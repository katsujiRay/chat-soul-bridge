/**
 * 多协议 AI 画图 / 文生图引擎（零写死模型与接口地址，全部由 config.json 的 imageGen 驱动）
 *
 * 支持两大通用协议：
 *   1. gemini ：Google Gemini 原生生图模型（@google/genai Interactions API v1beta，支持带角色参考图保持外貌一致）；
 *   2. openai ：标准 OpenAI 兼容 /images/generations（支持 GPT Image / 硅基流动 FLUX / 各类兼容中转与本地代理）。
 *
 * 返回统一的 { ok: true, data: '<base64>', mimeType: 'image/png', model }，
 * 由上层直接通过 OneBot base64:// 发送到 QQ，避免外链防盗链或超时失效。
 */
import { GoogleGenAI } from '@google/genai';

function expandEnvString(val) {
  if (typeof val !== 'string') return '';
  return val.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, name) => process.env[name] || '').trim();
}

/** 从 config.imageGen 解析当前生效的生图提供商配置 */
export function resolveImageGenConfig(config) {
  const ig = config?.imageGen;
  if (!ig || ig.enabled !== true) {
    return { enabled: false };
  }
  const providers = ig.providers && typeof ig.providers === 'object' ? ig.providers : {};
  const activeName = String(ig.active || '').trim();
  const entry = providers[activeName];
  if (!entry) {
    return { enabled: false, error: `imageGen.active="${activeName}" 在 imageGen.providers 中不存在` };
  }

  const protocol = String(entry.protocol || activeName).trim().toLowerCase();
  const envFallbackKey =
    process.env[`${activeName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`] ||
    (protocol === 'gemini' ? process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY : '') ||
    (protocol === 'openai' ? process.env.OPENAI_API_KEY : '');

  const apiKey = expandEnvString(entry.apiKey) || envFallbackKey || '';
  const baseUrl = expandEnvString(entry.baseUrl) || '';
  const model = String(entry.model || '').trim();
  const fallbackModels = Array.isArray(entry.fallbackModels) ? entry.fallbackModels.filter(Boolean) : [];

  if (!model || !apiKey) {
    return { enabled: false, error: `请在 config.json 的 imageGen.providers.${activeName} 中配置 model 和 apiKey` };
  }

  return {
    enabled: true,
    providerName: activeName,
    protocol: protocol === 'google' ? 'gemini' : protocol,
    apiKey,
    baseUrl,
    model,
    fallbackModels,
    size: String(entry.size || '1024x1024'),
    cooldownMs: Number(ig.cooldownMs ?? 30000),
  };
}

/** 根据 aspect_ratio 映射分辨率（SiliconFlow Kolors 与标准 OpenAI 分别适配支持尺寸） */
function aspectToSize(aspectRatio, fallbackSize = '1024x1024', isSiliconFlow = false) {
  const sfMap = {
    '1:1': '1024x1024',
    '16:9': '1024x576',
    '9:16': '576x1024',
    '4:3': '1024x768',
    '3:4': '768x1024',
  };
  const oaiMap = {
    '1:1': '1024x1024',
    '16:9': '1536x1024',
    '9:16': '1024x1536',
    '4:3': '1024x768',
    '3:4': '768x1024',
  };
  const map = isSiliconFlow ? sfMap : oaiMap;
  return map[String(aspectRatio || '').trim()] || fallbackSize;
}

/** 协议 1：Google Gemini 原生 Interactions API 生图（支持可选多模态参考图） */
async function generateWithGemini(cfg, { prompt, aspectRatio = '', referenceImages = [] }) {
  const ai = new GoogleGenAI({
    apiKey: cfg.apiKey,
    apiVersion: 'v1beta',
    ...(cfg.baseUrl ? { httpOptions: { baseUrl: cfg.baseUrl } } : {}),
  });

  const modelChain = [cfg.model, ...(cfg.fallbackModels || [])].filter(Boolean);
  let input;
  if (referenceImages.length > 0) {
    input = [
      {
        type: 'text',
        text: `请参考附图中的角色外观特征（发型、发色、瞳色、服饰风格）来绘制以下画面：\n${prompt}`,
      },
      ...referenceImages.map((img) => ({
        type: 'image',
        data: img.data,
        mime_type: img.mimeType || 'image/png',
      })),
    ];
  } else {
    input = prompt;
  }

  const validRatios = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']);
  const imageConfig = validRatios.has(String(aspectRatio || '').trim())
    ? { aspect_ratio: String(aspectRatio).trim() }
    : undefined;

  let lastErr;
  for (const targetModel of modelChain) {
    try {
      const res = await ai.interactions.create({
        model: targetModel,
        store: false,
        response_modalities: ['image'],
        input,
        ...(imageConfig ? { generation_config: { image_config: imageConfig } } : {}),
      });
      const outImg = res?.output_image;
      if (outImg?.data) {
        return {
          ok: true,
          data: outImg.data,
          mimeType: outImg.mime_type || 'image/png',
          model: targetModel,
        };
      }
      // 兼容从 steps 遍历提取图片
      for (const step of res?.steps || []) {
        if (step?.type === 'model_output' && Array.isArray(step.content)) {
          const hit = step.content.find((c) => c?.type === 'image' && c.data);
          if (hit) {
            return {
              ok: true,
              data: hit.data,
              mimeType: hit.mime_type || 'image/png',
              model: targetModel,
            };
          }
        }
      }
      lastErr = new Error(`模型 ${targetModel} 未返回图片数据`);
    } catch (err) {
      lastErr = err;
    }
  }
  return { ok: false, error: lastErr?.message || String(lastErr || 'Gemini 生图失败') };
}

/** 协议 2：OpenAI 兼容 /images/generations（支持 b64_json 与 url 自动下载转 base64） */
async function generateWithOpenAI(cfg, { prompt, aspectRatio = '' }) {
  if (!cfg.baseUrl) {
    return { ok: false, error: `请在 config.json 的 imageGen.providers.${cfg.providerName}.baseUrl 中配置生图接口地址` };
  }
  const trimmed = cfg.baseUrl.replace(/\/$/, '');
  const endpoint = trimmed.endsWith('/images/generations') ? trimmed : `${trimmed}/images/generations`;
  const modelChain = [cfg.model, ...(cfg.fallbackModels || [])].filter(Boolean);
  const isSiliconFlow =
    cfg.protocol === 'siliconflow' || /siliconflow\.(cn|com)/i.test(endpoint);
  const size = aspectToSize(aspectRatio, cfg.size, isSiliconFlow);

  let lastErr;
  for (const targetModel of modelChain) {
    try {
      const reqBody = isSiliconFlow
        ? {
            model: targetModel,
            prompt,
            image_size: size,
            batch_size: 1,
            num_inference_steps: 20,
            guidance_scale: 7.5,
          }
        : {
            model: targetModel,
            prompt,
            n: 1,
            size,
          };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(90000),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 260)}`);
      }
      const json = await res.json();
      const first = json?.data?.[0] || json?.images?.[0];
      if (!first) throw new Error('接口未返回图片数据');

      if (first.b64_json) {
        return { ok: true, data: first.b64_json, mimeType: 'image/png', model: targetModel };
      }
      if (first.url) {
        const dl = await fetch(first.url, { signal: AbortSignal.timeout(30000) });
        if (!dl.ok) throw new Error(`下载生成图片失败 HTTP ${dl.status}`);
        const mimeType = (dl.headers.get('content-type') || 'image/png').split(';')[0].trim();
        const buf = Buffer.from(await dl.arrayBuffer());
        if (buf.length === 0) throw new Error('下载的图片为空');
        return { ok: true, data: buf.toString('base64'), mimeType, model: targetModel };
      }
      throw new Error('返回结果缺少 b64_json 或 url');
    } catch (err) {
      lastErr = err;
    }
  }
  return { ok: false, error: lastErr?.message || String(lastErr || '生图接口调用失败') };
}

/** 统一文生图入口 */
export async function generateImage(imageGenConfig, { prompt, aspectRatio = '', referenceImages = [] }) {
  if (!imageGenConfig?.enabled) {
    return { ok: false, error: imageGenConfig?.error || '未启用 imageGen 生图功能' };
  }
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) {
    return { ok: false, error: 'prompt 画面描述不能为空' };
  }
  if (imageGenConfig.protocol === 'gemini') {
    return generateWithGemini(imageGenConfig, { prompt: cleanPrompt, aspectRatio, referenceImages });
  }
  return generateWithOpenAI(imageGenConfig, { prompt: cleanPrompt, aspectRatio });
}
