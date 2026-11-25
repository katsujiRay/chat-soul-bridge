/**
 * 统一多模型协议适配层（零写死接口地址与模型名，全部由 config.json 驱动）
 *
 * 支持三大底层协议（通过 config.json 的 llm.providers.<name>.protocol 指定）：
 *   1. gemini    ：Google Gemini Interactions API（无状态 store: false）
 *   2. openai    ：OpenAI 兼容 /chat/completions（覆盖 DeepSeek / GPT / Qwen / Kimi / OpenRouter / Ollama 等）
 *   3. anthropic ：Anthropic /v1/messages（覆盖 Claude 全系及兼容中转）
 *
 * 所有协议平等共享：
 *   - 同一套本地 state/context.db 滑窗上下文（切换模型不丢记忆）
 *   - 同一套工具声明与多轮调用循环（含多模态图片工具返回）
 *   - 同一套 fallbackModels 自动降级链
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { GoogleGenAI } from '@google/genai';
import {
  appendContextTurn,
  clearContext,
  loadContextMessages,
  loadContextSteps,
} from './context-db.js';
import { normalizeImagesForLlm } from './gif.js';

/** 将 GIF 分镜转换说明温和拼接到发给模型的当轮文本尾部（不污染持久化上下文） */
function appendGifNotes(baseText, gifNotes = []) {
  if (!Array.isArray(gifNotes) || gifNotes.length === 0) return baseText || '';
  const noteBlock = `【动图分镜说明】\n${gifNotes.join('\n')}`;
  return baseText ? `${baseText}\n${noteBlock}` : noteBlock;
}

/** 统一预处理工具返回的多模态结果（将其中可能包含的 GIF 归档图转为标准 PNG 分镜图） */
function normalizeMultimodalParts(parts = []) {
  if (!Array.isArray(parts) || parts.length === 0) return [];
  const rawImages = [];
  const imgPositions = [];
  const out = parts.map((p) => (p && typeof p === 'object' ? { ...p } : p));
  for (let i = 0; i < out.length; i++) {
    const p = out[i];
    if (p?.type === 'image' && p.data) {
      rawImages.push({ data: p.data, mimeType: p.mime_type || p.mimeType || 'image/jpeg' });
      imgPositions.push(i);
    }
  }
  if (rawImages.length === 0) return out;
  const { images: normImgs, gifNotes } = normalizeImagesForLlm(rawImages);
  for (let k = 0; k < imgPositions.length && k < normImgs.length; k++) {
    const pos = imgPositions[k];
    out[pos] = {
      type: 'image',
      data: normImgs[k].data,
      mime_type: normImgs[k].mimeType || 'image/png',
    };
  }
  if (gifNotes.length > 0) {
    out.push({ type: 'text', text: `【动图分镜说明】\n${gifNotes.join('\n')}` });
  }
  return out;
}

/** 单轮对话内最多允许连续调用工具的回合数，防止死循环 */
const MAX_TOOL_ROUNDS = 6;

/** 将配置里的 protocol 字符串归一化为 gemini / openai / anthropic / agy-cli */
function normalizeProtocol(raw) {
  const p = String(raw || '').trim().toLowerCase();
  if (p === 'gemini' || p === 'google') return 'gemini';
  if (p === 'anthropic' || p === 'claude') return 'anthropic';
  if (p === 'openai' || p === 'openai-compatible' || p === 'deepseek') return 'openai';
  if (p === 'agy-cli' || p === 'agy' || p === 'antigravity') return 'agy-cli';
  throw new Error(`不支持的协议类型 protocol="${raw}"，可选值：gemini / openai / anthropic / agy-cli`);
}

/** 将本轮干净的文本问答写入本地 state/context.db（图片仅留占位说明，防止数据库膨胀） */
function saveTurnToLocalContext(chatKey, text, images, replyText, toolContext, maxContextTurns) {
  const storedUserText =
    text || (images.length > 0 ? `（发送了 ${images.length} 张图片）` : '');
  const storedUserLine =
    text && images.length > 0 ? `${text}\n（附带 ${images.length} 张图片）` : storedUserText;
  if (storedUserLine) {
    appendContextTurn(chatKey, 'user', storedUserLine, maxContextTurns);
  }
  if (replyText) {
    appendContextTurn(chatKey, 'model', replyText, maxContextTurns);
  } else if (toolContext?.directSentText) {
    appendContextTurn(chatKey, 'model', toolContext.directSentText, maxContextTurns);
  }
}

const CAPTION_PROMPT =
  '请用一句不超过 28 个字的客观中文简述图片里的主要内容（人物/物体/文字/场景），直接输出描述本身，不要加“这张图是”或引号。';

function cleanCaptionText(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .replace(/^[“"「『（(]+|[”"」』）)。！!]+$/g, '')
    .trim()
    .slice(0, 40);
}

/** 将配置里的思考强度归一化（留空表示不传，遵循模型默认行为） */
function normalizeThinkingLevel(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v || v === 'default' || v === 'auto') return '';
  if (v === 'off' || v === 'false' || v === '0') return 'none';
  return v;
}

/** 将统一思考强度映射为 Anthropic 扩展思考预算（budget_tokens） */
function resolveAnthropicThinking(thinkingLevel, thinkingBudget) {
  const customBudget = Number(thinkingBudget || 0);
  if (Number.isFinite(customBudget) && customBudget >= 1024) {
    return { type: 'enabled', budget_tokens: Math.round(customBudget) };
  }
  const level = normalizeThinkingLevel(thinkingLevel);
  if (!level) return null;
  if (level === 'none') return { type: 'disabled' };
  const map = {
    minimal: 1024,
    low: 2048,
    medium: 4096,
    high: 8192,
    xhigh: 16384,
  };
  return { type: 'enabled', budget_tokens: map[level] || 2048 };
}

/** 协议 1：Google Gemini Interactions API 适配器（支持官方地址与自定义反代 baseUrl） */
function createGeminiClient({
  providerName,
  apiKey,
  baseUrl = '',
  model,
  fallbackModels = [],
  temperature = 1.0,
  thinkingLevel = '',
  maxContextTurns = 20,
  tools = [],
  getTools = null,
  executeTool,
  getSystemInstruction,
}) {
  if (!model) {
    throw new Error(`请在 config.json 的 llm.providers.${providerName}.model 中填写要使用的模型 ID`);
  }
  if (!apiKey || apiKey.startsWith('请替换')) {
    throw new Error(`请在 config.json 的 llm.providers.${providerName}.apiKey（或 .env）中填入有效 API Key`);
  }

  const ai = new GoogleGenAI({
    apiKey,
    ...(baseUrl ? { httpOptions: { baseUrl } } : {}),
  });
  const modelChain = [...new Set([model, ...fallbackModels].filter(Boolean))];
  let lastWorkingModel = '';
  const normThinking = normalizeThinkingLevel(thinkingLevel);
  const geminiThinkingLevel = normThinking === 'none' ? 'minimal' : normThinking;

  function extractFunctionCalls(interaction) {
    const steps = Array.isArray(interaction?.steps) ? interaction.steps : [];
    return steps.filter((s) => s?.type === 'function_call' && s?.id && s?.name);
  }

  async function runWithModel(targetModel, historySteps, currentUserStep, systemInstruction, activeTools, toolContext) {
    const baseOpts = {
      model: targetModel,
      store: false,
      system_instruction: systemInstruction,
      generation_config: {
        temperature,
        ...(geminiThinkingLevel ? { thinking_level: geminiThinkingLevel } : {}),
      },
      ...(activeTools.length > 0 ? { tools: activeTools } : {}),
    };

    const workingSteps = [...historySteps, currentUserStep];
    let interaction = await ai.interactions.create({ ...baseOpts, input: workingSteps });

    for (let round = 0; round < MAX_TOOL_ROUNDS && executeTool; round++) {
      const calls = extractFunctionCalls(interaction);
      if (calls.length === 0) break;

      if (Array.isArray(interaction.steps) && interaction.steps.length > 0) {
        workingSteps.push(...interaction.steps);
      }

      const results = [];
      for (const call of calls) {
        let output;
        let isError = false;
        try {
          output = await executeTool(call.name, call.arguments || {}, toolContext);
        } catch (err) {
          output = { ok: false, error: err?.message || String(err) };
          isError = true;
        }
        const formattedResult =
          output && Array.isArray(output.__multimodalResult)
            ? normalizeMultimodalParts(output.__multimodalResult)
            : typeof output === 'string'
              ? output
              : JSON.stringify(output);
        results.push({
          type: 'function_result',
          call_id: call.id,
          name: call.name,
          result: formattedResult,
          ...(isError ? { is_error: true } : {}),
        });
      }

      workingSteps.push(...results);
      interaction = await ai.interactions.create({ ...baseOpts, input: workingSteps });
    }

    return interaction;
  }

  return {
    resetSession: (chatKey) => clearContext(chatKey),
    async captionImages(images = [], preferredModel = '') {
      if (!Array.isArray(images) || images.length === 0) return '';
      const { images: normImgs, gifNotes } = normalizeImagesForLlm(images.slice(0, 2));
      if (normImgs.length === 0) return '';
      const prompt = gifNotes.length > 0 ? `${CAPTION_PROMPT}\n${gifNotes.join(' ')}` : CAPTION_PROMPT;
      const content = [
        { type: 'text', text: prompt },
        ...normImgs.map((img) => ({ type: 'image', data: img.data, mime_type: img.mimeType })),
      ];
      const candidates = [...new Set([preferredModel, lastWorkingModel, ...modelChain].filter(Boolean))];
      for (const targetModel of candidates) {
        try {
          const interaction = await ai.interactions.create({
            model: targetModel,
            store: false,
            generation_config: { temperature: 0.2 },
            input: [{ type: 'user_input', content }],
          });
          const caption = cleanCaptionText(interaction?.output_text);
          if (caption) return caption;
        } catch (err) {
          console.warn(`[llm:${providerName}] 图片图注模型 ${targetModel} 失败:`, err?.message || err);
        }
      }
      return '';
    },
    async chat(chatKey, { text, persistText, images = [], toolContext = {} }) {
      const systemInstruction = getSystemInstruction(chatKey);
      const activeTools = typeof getTools === 'function' ? getTools(chatKey, toolContext) || [] : tools;
      const { images: normImgs, gifNotes } = normalizeImagesForLlm(images);
      const effectiveText = appendGifNotes(text, gifNotes);
      const contentParts = [];
      if (effectiveText) contentParts.push({ type: 'text', text: effectiveText });
      for (const img of normImgs) {
        contentParts.push({ type: 'image', data: img.data, mime_type: img.mimeType });
      }
      if (contentParts.length === 0) return '';

      const historySteps = loadContextSteps(chatKey, maxContextTurns);
      const currentUserStep = { type: 'user_input', content: contentParts };

      let lastErr;
      for (const targetModel of modelChain) {
        try {
          const interaction = await runWithModel(
            targetModel,
            historySteps,
            currentUserStep,
            systemInstruction,
            activeTools,
            toolContext
          );
          lastWorkingModel = targetModel;
          const replyText = (interaction?.output_text ?? '').trim();
          saveTurnToLocalContext(chatKey, persistText ?? text, images, replyText, toolContext, maxContextTurns);
          return replyText;
        } catch (err) {
          lastErr = err;
          console.warn(`[llm:${providerName}] 模型 ${targetModel} 调用失败:`, err?.message || err);
        }
      }
      throw lastErr;
    },
  };
}

/** 协议 2：OpenAI 兼容适配器（支持 GPT / DeepSeek / Qwen / Kimi / OpenRouter / Ollama 等任意兼容接口） */
function createOpenAICompatibleClient({
  providerName,
  apiKey,
  baseUrl,
  model,
  fallbackModels = [],
  temperature = 1.0,
  thinkingLevel = '',
  maxContextTurns = 20,
  tools = [],
  getTools = null,
  executeTool,
  getSystemInstruction,
}) {
  if (!baseUrl) {
    throw new Error(`请在 config.json 的 llm.providers.${providerName}.baseUrl 中配置接口地址`);
  }
  if (!model) {
    throw new Error(`请在 config.json 的 llm.providers.${providerName}.model 中填写要使用的模型 ID`);
  }
  if (!apiKey || apiKey.startsWith('请替换')) {
    throw new Error(`请在 config.json 的 llm.providers.${providerName}.apiKey（或 .env）中填入有效 API Key`);
  }

  const trimmed = baseUrl.replace(/\/$/, '');
  const endpoint = trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
  const modelChain = [...new Set([model, ...fallbackModels].filter(Boolean))];
  let lastWorkingModel = '';
  const reasoningEffort = normalizeThinkingLevel(thinkingLevel);

  function toOpenAITools(list) {
    return list
      .filter((t) => t.type === 'function')
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters || { type: 'object', properties: {} },
        },
      }));
  }

  async function runWithModel(targetModel, messages, fnTools, toolContext) {
    const working = [...messages];

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const body = {
        model: targetModel,
        messages: working,
        temperature,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(fnTools.length > 0 ? { tools: fnTools } : {}),
      };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const data = await res.json();
      const msg = data?.choices?.[0]?.message;
      if (!msg) return '';

      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (toolCalls.length === 0 || !executeTool || round === MAX_TOOL_ROUNDS) {
        return typeof msg.content === 'string' ? msg.content.trim() : '';
      }

      working.push({
        role: 'assistant',
        content: msg.content || '',
        tool_calls: toolCalls,
      });

      for (const tc of toolCalls) {
        let parsedArgs = {};
        try {
          parsedArgs = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {}
        let output;
        try {
          output = await executeTool(tc.function?.name, parsedArgs, toolContext);
        } catch (err) {
          output = { ok: false, error: err?.message || String(err) };
        }
        const normMulti =
          output && Array.isArray(output.__multimodalResult)
            ? normalizeMultimodalParts(output.__multimodalResult)
            : null;
        const textResult = normMulti
          ? normMulti
              .filter((p) => p.type === 'text')
              .map((p) => p.text)
              .join('\n') || JSON.stringify({ ok: true, files: output.files || [] })
          : typeof output === 'string'
            ? output
            : JSON.stringify(output);
        working.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: textResult,
        });
        // OpenAI tool role 仅接受纯文本，若工具返回了图片则附带一条多模态 user 消息
        if (normMulti) {
          const imgs = normMulti.filter((p) => p.type === 'image' && p.data);
          if (imgs.length > 0) {
            working.push({
              role: 'user',
              content: [
                { type: 'text', text: '（以下是工具返回的图片）' },
                ...imgs.map((img) => ({
                  type: 'image_url',
                  image_url: { url: `data:${img.mime_type || 'image/png'};base64,${img.data}` },
                })),
              ],
            });
          }
        }
      }
    }
    return '';
  }

  return {
    resetSession: (chatKey) => clearContext(chatKey),
    async captionImages(images = [], preferredModel = '') {
      if (!Array.isArray(images) || images.length === 0) return '';
      const { images: normImgs, gifNotes } = normalizeImagesForLlm(images.slice(0, 2));
      if (normImgs.length === 0) return '';
      const prompt = gifNotes.length > 0 ? `${CAPTION_PROMPT}\n${gifNotes.join(' ')}` : CAPTION_PROMPT;
      const userContent = [
        { type: 'text', text: prompt },
        ...normImgs.map((img) => ({
          type: 'image_url',
          image_url: { url: `data:${img.mimeType};base64,${img.data}` },
        })),
      ];
      const candidates = [...new Set([preferredModel, lastWorkingModel, ...modelChain].filter(Boolean))];
      for (const targetModel of candidates) {
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model: targetModel,
              temperature: 0.2,
              max_tokens: 80,
              messages: [{ role: 'user', content: userContent }],
            }),
            signal: AbortSignal.timeout(25000),
          });
          if (!res.ok) continue;
          const data = await res.json();
          const caption = cleanCaptionText(data?.choices?.[0]?.message?.content);
          if (caption) return caption;
        } catch (err) {
          console.warn(`[llm:${providerName}] 图片图注模型 ${targetModel} 失败:`, err?.message || err);
        }
      }
      return '';
    },
    async chat(chatKey, { text, persistText, images = [], toolContext = {} }) {
      const systemInstruction = getSystemInstruction(chatKey);
      const activeTools = typeof getTools === 'function' ? getTools(chatKey, toolContext) || [] : tools;
      const fnTools = toOpenAITools(activeTools);
      const history = loadContextMessages(chatKey, maxContextTurns).map((m) => ({
        role: m.role === 'model' ? 'assistant' : 'user',
        content: m.text,
      }));

      const { images: normImgs, gifNotes } = normalizeImagesForLlm(images);
      const effectiveText = appendGifNotes(text, gifNotes);
      let userContent;
      if (normImgs.length > 0) {
        userContent = [];
        if (effectiveText) userContent.push({ type: 'text', text: effectiveText });
        for (const img of normImgs) {
          userContent.push({
            type: 'image_url',
            image_url: { url: `data:${img.mimeType};base64,${img.data}` },
          });
        }
      } else {
        userContent = effectiveText;
      }
      if (!userContent || (Array.isArray(userContent) && userContent.length === 0)) return '';

      const messages = [
        ...(systemInstruction ? [{ role: 'system', content: systemInstruction }] : []),
        ...history,
        { role: 'user', content: userContent },
      ];

      let lastErr;
      for (const targetModel of modelChain) {
        try {
          const replyText = await runWithModel(targetModel, messages, fnTools, toolContext);
          lastWorkingModel = targetModel;
          saveTurnToLocalContext(chatKey, persistText ?? text, images, replyText, toolContext, maxContextTurns);
          return replyText;
        } catch (err) {
          lastErr = err;
          console.warn(`[llm:${providerName}] 模型 ${targetModel} 调用失败:`, err?.message || err);
        }
      }
      throw lastErr;
    },
  };
}

/** 协议 3：Anthropic Messages API 适配器（支持 Claude 全系及兼容中转） */
function createAnthropicClient({
  providerName,
  apiKey,
  baseUrl,
  model,
  fallbackModels = [],
  temperature = 1.0,
  maxTokens = 1024,
  thinkingLevel = '',
  thinkingBudget = 0,
  maxContextTurns = 20,
  tools = [],
  getTools = null,
  executeTool,
  getSystemInstruction,
}) {
  if (!baseUrl) {
    throw new Error(`请在 config.json 的 llm.providers.${providerName}.baseUrl 中配置接口地址`);
  }
  if (!model) {
    throw new Error(`请在 config.json 的 llm.providers.${providerName}.model 中填写要使用的模型 ID`);
  }
  if (!apiKey || apiKey.startsWith('请替换')) {
    throw new Error(`请在 config.json 的 llm.providers.${providerName}.apiKey（或 .env）中填入有效 API Key`);
  }

  const trimmed = baseUrl.replace(/\/$/, '');
  const endpoint = trimmed.endsWith('/v1/messages') ? trimmed : `${trimmed}/v1/messages`;
  const modelChain = [...new Set([model, ...fallbackModels].filter(Boolean))];
  let lastWorkingModel = '';
  const thinkingCfg = resolveAnthropicThinking(thinkingLevel, thinkingBudget);
  const effectiveMaxTokens =
    thinkingCfg?.type === 'enabled'
      ? Math.max(maxTokens, thinkingCfg.budget_tokens + 1024)
      : maxTokens;

  function toClaudeTools(list) {
    return list
      .filter((t) => t.type === 'function')
      .map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters || { type: 'object', properties: {} },
      }));
  }

  async function runWithModel(targetModel, systemInstruction, messages, claudeTools, toolContext) {
    const working = [...messages];

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const body = {
        model: targetModel,
        max_tokens: effectiveMaxTokens,
        // Anthropic 启用 extended thinking 时要求不传或固定 temperature=1，避免接口报 400
        ...(thinkingCfg?.type === 'enabled' ? {} : { temperature }),
        ...(thinkingCfg ? { thinking: thinkingCfg } : {}),
        ...(systemInstruction ? { system: systemInstruction } : {}),
        messages: working,
        ...(claudeTools.length > 0 ? { tools: claudeTools } : {}),
      };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const data = await res.json();
      const blocks = Array.isArray(data?.content) ? data.content : [];
      const toolUses = blocks.filter((b) => b?.type === 'tool_use');

      if (toolUses.length === 0 || !executeTool || round === MAX_TOOL_ROUNDS) {
        return blocks
          .filter((b) => b?.type === 'text' && b.text)
          .map((b) => b.text)
          .join('\n')
          .trim();
      }

      working.push({ role: 'assistant', content: blocks });
      const toolResults = [];
      for (const tu of toolUses) {
        let output;
        let isError = false;
        try {
          output = await executeTool(tu.name, tu.input || {}, toolContext);
        } catch (err) {
          output = { ok: false, error: err?.message || String(err) };
          isError = true;
        }
        const formattedContent =
          output && Array.isArray(output.__multimodalResult)
            ? normalizeMultimodalParts(output.__multimodalResult).map((p) =>
                p.type === 'image'
                  ? { type: 'image', source: { type: 'base64', media_type: p.mime_type || 'image/png', data: p.data } }
                  : { type: 'text', text: p.text }
              )
            : typeof output === 'string'
              ? output
              : JSON.stringify(output);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: formattedContent,
          ...(isError ? { is_error: true } : {}),
        });
      }
      working.push({ role: 'user', content: toolResults });
    }
    return '';
  }

  return {
    resetSession: (chatKey) => clearContext(chatKey),
    async captionImages(images = [], preferredModel = '') {
      if (!Array.isArray(images) || images.length === 0) return '';
      const { images: normImgs, gifNotes } = normalizeImagesForLlm(images.slice(0, 2));
      if (normImgs.length === 0) return '';
      const prompt = gifNotes.length > 0 ? `${CAPTION_PROMPT}\n${gifNotes.join(' ')}` : CAPTION_PROMPT;
      const userBlocks = [
        { type: 'text', text: prompt },
        ...normImgs.map((img) => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mimeType, data: img.data },
        })),
      ];
      const candidates = [...new Set([preferredModel, lastWorkingModel, ...modelChain].filter(Boolean))];
      for (const targetModel of candidates) {
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: targetModel,
              max_tokens: 80,
              temperature: 0.2,
              messages: [{ role: 'user', content: userBlocks }],
            }),
            signal: AbortSignal.timeout(25000),
          });
          if (!res.ok) continue;
          const data = await res.json();
          const text = (data?.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join(' ');
          const caption = cleanCaptionText(text);
          if (caption) return caption;
        } catch (err) {
          console.warn(`[llm:${providerName}] 图片图注模型 ${targetModel} 失败:`, err?.message || err);
        }
      }
      return '';
    },
    async chat(chatKey, { text, persistText, images = [], toolContext = {} }) {
      const systemInstruction = getSystemInstruction(chatKey);
      const activeTools = typeof getTools === 'function' ? getTools(chatKey, toolContext) || [] : tools;
      const claudeTools = toClaudeTools(activeTools);
      const history = loadContextMessages(chatKey, maxContextTurns).map((m) => ({
        role: m.role === 'model' ? 'assistant' : 'user',
        content: m.text,
      }));

      const { images: normImgs, gifNotes } = normalizeImagesForLlm(images);
      const effectiveText = appendGifNotes(text, gifNotes);
      const userBlocks = [];
      if (effectiveText) userBlocks.push({ type: 'text', text: effectiveText });
      for (const img of normImgs) {
        userBlocks.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mimeType, data: img.data },
        });
      }
      if (userBlocks.length === 0) return '';

      const messages = [...history, { role: 'user', content: userBlocks }];
      let lastErr;
      for (const targetModel of modelChain) {
        try {
          const replyText = await runWithModel(targetModel, systemInstruction, messages, claudeTools, toolContext);
          lastWorkingModel = targetModel;
          saveTurnToLocalContext(chatKey, persistText ?? text, images, replyText, toolContext, maxContextTurns);
          return replyText;
        } catch (err) {
          lastErr = err;
          console.warn(`[llm:${providerName}] 模型 ${targetModel} 调用失败:`, err?.message || err);
        }
      }
      throw lastErr;
    },
  };
}

/** 查找本机 Antigravity CLI (agy) 可执行文件路径 */
function resolveAgyBin(customBin = '') {
  const candidates = [
    customBin,
    process.env.AGY_BIN,
    process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe')
      : path.join(os.homedir(), '.local', 'bin', 'agy'),
  ].filter(Boolean);
  for (const cand of candidates) {
    if (fs.existsSync(cand)) return cand;
  }
  return process.platform === 'win32' ? 'agy.exe' : 'agy';
}

/**
 * 协议 4：Antigravity CLI 无头长连接适配器（agy --input-format stream-json --output-format stream-json）
 *
 * 特点：
 *   - 复用你本机 `agy` 登录缓存的 Antigravity Google 账号凭证，无需一直开着 agy 终端；
 *   - 每个 chatKey 懒启动一个常驻 stream-json 子进程，首轮注入人设与本地 context.db 历史，
 *     后续轮次直接复用预热上下文缓存（秒级响应），并同步回写 state/context.db 以便随时切换其他模型。
 */
function createAgyCliClient({
  providerName = 'antigravity',
  model = '',
  thinkingLevel = '',
  binPath = '',
  maxContextTurns = 20,
  tools = [],
  getTools = null,
  executeTool = null,
  getSystemInstruction,
}) {
  const agyBin = resolveAgyBin(binPath);
  const normEffort = normalizeThinkingLevel(thinkingLevel);
  const agyEffort =
    normEffort === 'none' || normEffort === 'minimal'
      ? 'low'
      : ['low', 'medium', 'high', 'xhigh', 'max'].includes(normEffort)
        ? normEffort
        : '';
  const sessions = new Map(); // chatKey -> { proc, initialized, pending }
  const tmpDir = path.resolve(process.cwd(), 'state', 'media', 'tmp_agy');

  function killSession(chatKey) {
    const s = sessions.get(chatKey);
    if (!s) return;
    sessions.delete(chatKey);
    try {
      s.proc.stdin.end();
      s.proc.kill();
    } catch {}
  }

  function ensureSession(chatKey) {
    const existing = sessions.get(chatKey);
    if (existing && !existing.proc.killed && existing.proc.exitCode === null) {
      return existing;
    }
    const args = [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--disable-slash-commands',
    ];
    if (model) args.push('--model', model);
    if (agyEffort) args.push('--effort', agyEffort);

    const proc = spawn(agyBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(agyBin),
      cwd: process.cwd(),
    });

    const session = { proc, initialized: false, pending: null, stderrBuf: '' };
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let ev;
      try {
        ev = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (ev.event === 'result' && session.pending) {
        const { resolve, reject, timer } = session.pending;
        session.pending = null;
        clearTimeout(timer);
        const r = ev.result || {};
        if (r.status && r.status !== 'SUCCESS' && r.error) {
          reject(new Error(`agy 返回异常(${r.status}): ${r.error}`));
        } else {
          resolve(String(r.response || '').trim());
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      session.stderrBuf = (session.stderrBuf + String(chunk)).slice(-600);
    });

    proc.on('error', (err) => {
      if (sessions.get(chatKey) === session) sessions.delete(chatKey);
      if (session.pending) {
        const { reject, timer } = session.pending;
        session.pending = null;
        clearTimeout(timer);
        reject(new Error(`启动 agy CLI 失败（请确认已安装 agy 并完成一次登录）: ${err.message}`));
      }
    });

    proc.on('exit', (code) => {
      if (sessions.get(chatKey) === session) sessions.delete(chatKey);
      if (session.pending) {
        const { reject, timer } = session.pending;
        session.pending = null;
        clearTimeout(timer);
        reject(
          new Error(
            `agy CLI 提前退出 (code=${code})${session.stderrBuf ? `: ${session.stderrBuf.trim()}` : ''}`
          )
        );
      }
    });

    sessions.set(chatKey, session);
    return session;
  }

  function writeTempImages(images) {
    if (!Array.isArray(images) || images.length === 0) return [];
    fs.mkdirSync(tmpDir, { recursive: true });
    const paths = [];
    for (let i = 0; i < Math.min(3, images.length); i++) {
      const img = images[i];
      if (!img?.data) continue;
      const mime = String(img.mimeType || '').toLowerCase();
      const ext = mime.includes('png')
        ? '.png'
        : mime.includes('webp')
          ? '.webp'
          : mime.includes('gif')
            ? '.gif'
            : '.jpg';
      const file = path.join(tmpDir, `img_${Date.now()}_${i}${ext}`);
      fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
      paths.push(file);
    }
    return paths;
  }

  function sendToSession(chatKey, content, timeoutMs = 120000) {
    const session = ensureSession(chatKey);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (session.pending) {
          session.pending = null;
          killSession(chatKey);
          reject(new Error('agy CLI 响应超时'));
        }
      }, timeoutMs);
      session.pending = { resolve, reject, timer };
      try {
        session.proc.stdin.write(`${JSON.stringify({ event: 'user', message: { content } })}\n`);
      } catch (err) {
        clearTimeout(timer);
        session.pending = null;
        killSession(chatKey);
        reject(err);
      }
    });
  }

  function formatAgyToolsBrief(activeTools = []) {
    const fnTools = (activeTools || []).filter((t) => t && t.type === 'function' && t.name);
    if (fnTools.length === 0) return '';
    const lines = fnTools.map((t) => {
      const props = t.parameters?.properties || {};
      const req = new Set(t.parameters?.required || []);
      const paramStr = Object.keys(props)
        .map((k) => `${k}${req.has(k) ? '' : '?'}`)
        .join(', ');
      const desc = String(t.description || '').replace(/\s+/g, ' ').slice(0, 130);
      return `- ${t.name}(${paramStr}): ${desc}`;
    });
    return (
      `\n\n【Chat 桥接专属工具调用协议】\n` +
      `当前会话允许你调用以下 Chat 工具。如果这一轮需要执行某个工具（如转发消息、查历史记忆、写日记、记待办、发表情包等），` +
      `请只输出一行或多行：[[TOOL_CALL:{"name":"工具名","args":{...}}]]（不要输出其他废话，也不要编造工具结果）；` +
      `桥接程序会自动执行并把真实结果发回给你，收到结果后再用自然口语回复。\n` +
      lines.join('\n')
    );
  }

  function extractAgyToolCalls(replyText) {
    const text = String(replyText || '');
    const calls = [];
    const marker = '[[TOOL_CALL:';
    let pos = 0;
    while (pos < text.length) {
      const start = text.indexOf(marker, pos);
      if (start === -1) break;
      const jsonStart = text.indexOf('{', start + marker.length);
      if (jsonStart === -1) break;
      let depth = 0;
      let inStr = false;
      let esc = false;
      let endObj = -1;
      for (let i = jsonStart; i < text.length; i++) {
        const ch = text[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
        } else {
          if (ch === '"') inStr = true;
          else if (ch === '{') depth += 1;
          else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
              endObj = i;
              break;
            }
          }
        }
      }
      if (endObj === -1) break;
      const closeBracket = text.indexOf(']]', endObj + 1);
      const rawJson = text.slice(jsonStart, endObj + 1);
      try {
        const parsed = JSON.parse(rawJson);
        if (parsed && typeof parsed.name === 'string' && parsed.name.trim()) {
          calls.push({
            name: parsed.name.trim(),
            args: parsed.args && typeof parsed.args === 'object' ? parsed.args : {},
          });
        }
      } catch {}
      pos = closeBracket !== -1 ? closeBracket + 2 : endObj + 1;
    }
    return calls;
  }

  function stripAgyToolCallTags(replyText) {
    return String(replyText || '')
      .replace(/\[\[TOOL_CALL:\{[\s\S]*?\}\]\]/g, '')
      .trim();
  }

  return {
    resetSession: (chatKey) => {
      killSession(chatKey);
      clearContext(chatKey);
    },
    async captionImages() {
      // agy-cli 模式下跳过后台额外起进程生成图注，避免多占一轮 CLI 额度
      return '';
    },
    async chat(chatKey, { text, persistText, images = [], toolContext = {} }) {
      const session = ensureSession(chatKey);
      const { images: normImgs, gifNotes } = normalizeImagesForLlm(images);
      const tempImgPaths = writeTempImages(normImgs);
      const extraTempPaths = [];
      const gifHintText = gifNotes.length > 0 ? `\n【动图分镜说明】\n${gifNotes.join('\n')}` : '';
      const imgHint =
        tempImgPaths.length > 0
          ? `\n（对方发来了 ${tempImgPaths.length} 张图片，本地路径：${tempImgPaths.join(' , ')}，如需看图可用 read_file 查看后再回复）${gifHintText}`
          : '';

      const activeTools = typeof getTools === 'function' ? getTools(chatKey, toolContext) || [] : tools;
      const allowedToolNames = new Set(activeTools.map((t) => t?.name).filter(Boolean));

      let payloadText;
      if (!session.initialized) {
        const sys = getSystemInstruction(chatKey) || '';
        const toolsBrief = executeTool ? formatAgyToolsBrief(activeTools) : '';
        const history = loadContextMessages(chatKey, maxContextTurns);
        const histBlock =
          history.length > 0
            ? `\n\n【近期历史对话（承接上下文用）】\n${history
                .map((m) => `${m.role === 'model' ? '你' : '对方'}: ${m.text}`)
                .join('\n')}`
            : '';
        payloadText =
          `【你的角色设定与聊天规则（请全程严格保持人设，直接输出自然口语回复，绝不输出动作描写或 Markdown，不要执行任何修改/删除本地文件的命令）】\n${sys}${toolsBrief}${histBlock}\n\n【当前收到的 聊天消息】\n${text || '（发了一张图片）'}${imgHint}`;
      } else {
        payloadText = `${text || '（发了一张图片）'}${imgHint}`;
      }

      try {
        let replyText = '';
        let nextPayload = payloadText;
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
          replyText = await sendToSession(chatKey, nextPayload);
          session.initialized = true;

          const calls = executeTool ? extractAgyToolCalls(replyText) : [];
          if (calls.length === 0 || round === MAX_TOOL_ROUNDS) {
            replyText = stripAgyToolCallTags(replyText);
            break;
          }

          const resultLines = [];
          for (const call of calls.slice(0, 4)) {
            let output;
            if (allowedToolNames.size > 0 && !allowedToolNames.has(call.name)) {
              output = { ok: false, error: `当前会话不允许调用工具 ${call.name}` };
            } else {
              try {
                output = await executeTool(call.name, call.args || {}, toolContext);
              } catch (err) {
                output = { ok: false, error: err?.message || String(err) };
              }
            }
            if (output && Array.isArray(output.__multimodalResult)) {
              const normMulti = normalizeMultimodalParts(output.__multimodalResult);
              const textParts = normMulti.filter((p) => p.type === 'text').map((p) => p.text);
              const imgParts = normMulti
                .filter((p) => p.type === 'image' && p.data)
                .map((p) => ({ data: p.data, mimeType: p.mime_type || 'image/png' }));
              const paths = writeTempImages(imgParts);
              extraTempPaths.push(...paths);
              resultLines.push(
                `[${call.name}] ${textParts.join('\n')}${paths.length ? `（图片路径：${paths.join(' , ')}，可用 read_file 查看）` : ''}`
              );
            } else {
              const jsonOut = typeof output === 'string' ? output : JSON.stringify(output);
              resultLines.push(`[${call.name}] ${jsonOut.slice(0, 2200)}`);
            }
          }
          nextPayload = `【Chat 工具执行结果（请勿再复述工具名或 JSON，直接用自然人设口语回复用户；如还需继续调工具才输出 [[TOOL_CALL:...]]）】\n${resultLines.join('\n')}`;
        }

        saveTurnToLocalContext(chatKey, persistText ?? text, images, replyText, toolContext, maxContextTurns);
        return replyText;
      } catch (err) {
        console.warn(`[llm:${providerName}] agy-cli 调用失败:`, err?.message || err);
        throw err;
      } finally {
        for (const f of [...tempImgPaths, ...extraTempPaths]) {
          try {
            fs.unlinkSync(f);
          } catch {}
        }
      }
    },
  };
}

/** 统一多模型工厂：按 protocol 路由到 gemini / openai / anthropic / agy-cli 客户端 */
export function createLlmClient(options) {
  const protocol = normalizeProtocol(options.protocol || options.provider);
  const providerName = options.providerName || protocol;
  if (protocol === 'gemini') {
    return createGeminiClient({ ...options, providerName });
  }
  if (protocol === 'anthropic') {
    return createAnthropicClient({ ...options, providerName });
  }
  if (protocol === 'agy-cli') {
    return createAgyCliClient({ ...options, providerName });
  }
  return createOpenAICompatibleClient({ ...options, providerName });
}
