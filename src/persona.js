/**
 * 角色人设卡解析器（默认读取 roles/persona.txt）
 *
 * 设计目标：
 *   让“换角色”只需替换或修改人设文件，无需改代码和 config.json。
 *   按文件 mtimeMs 缓存解析结果，编辑保存即自动热生效。
 */
import fs from 'node:fs';
import path from 'node:path';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

let cachedPath = '';
let cachedMtimeMs = -1;
let cachedData = { name: 'Bot', keywords: [], topics: [], referencePath: '', prompt: '' };

/** 将逗号、顿号、竖线或数组括号包裹的关键词字符串拆分为干净数组 */
function splitKeywords(raw) {
  return String(raw || '')
    .replace(/^\[|\]$/g, '')
    .split(/[,，、|;\n]+/)
    .map((s) => s.replace(/^['"\s]+|['"\s]+$/g, ''))
    .filter(Boolean);
}

/**
 * 列出角色参考图/三视图文件（支持目录或单张图片路径）。
 * 若目录不存在或无图则静默返回空数组；严格限制在项目根目录内防止路径穿越。
 */
export function listPersonaReferenceImages(referencePath, baseDir = process.cwd(), maxCount = 3) {
  const raw = String(referencePath || '').trim();
  if (!raw) return [];

  const projectRoot = path.resolve(process.cwd());
  const candidates = [
    path.resolve(projectRoot, raw),
    path.resolve(path.resolve(baseDir), raw),
  ];

  let target = null;
  for (const cand of candidates) {
    // 安全限制：只允许读取项目根目录内的参考图
    if (cand !== projectRoot && !cand.startsWith(projectRoot + path.sep)) continue;
    if (fs.existsSync(cand)) {
      target = cand;
      break;
    }
  }
  if (!target) return [];

  const stat = fs.statSync(target);
  if (stat.isFile()) {
    return IMAGE_EXTS.has(path.extname(target).toLowerCase()) ? [target] : [];
  }
  if (stat.isDirectory()) {
    return fs
      .readdirSync(target)
      .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
      .sort()
      .slice(0, maxCount)
      .map((f) => path.join(target, f));
  }
  return [];
}

/**
 * 解析人设文件（按 mtimeMs 自动缓存，保存即热生效）：
 *
 * 支持顶部 YAML 风格元信息：
 * ---
 * name: 角色名
 * keywords: 唤醒词1, 唤醒词2, 唤醒词3
 * reference: ./assets/
 * ---
 * （正文...）
 *
 * 也兼容在正文中直接写“唤醒关键词：...”或“人设三视图/参考图：./assets/”。
 */
export function loadPersona(personaPath) {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(personaPath).mtimeMs;
  } catch {
    return cachedData;
  }
  if (cachedPath === personaPath && cachedMtimeMs === mtimeMs) {
    return cachedData;
  }

  const raw = fs.readFileSync(personaPath, 'utf8').replace(/\r\n/g, '\n');
  const baseDir = path.dirname(path.resolve(personaPath));
  let fullName = '';
  let name = 'Bot';
  let keywords = [];
  let topics = [];
  let referencePath = '';
  let prompt = raw.trim();

  // 1. 解析顶部 --- frontmatter ---
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fmMatch) {
    const metaBlock = fmMatch[1];
    prompt = fmMatch[2].trim();
    for (const line of metaBlock.split('\n')) {
      const m = line.match(/^\s*([a-zA-Z_\u4e00-\u9fa5/]+)\s*[:：]\s*(.+)\s*$/);
      if (!m) continue;
      const key = m[1].trim().toLowerCase();
      const val = m[2].trim();
      if (key === 'name' || key === '角色名' || key === '名字') {
        fullName = val.replace(/^['"]|['"]$/g, '').trim();
        name = fullName.replace(/[（(].*?[）)]/g, '').trim() || fullName || name;
      } else if (key === 'keywords' || key === '唤醒词' || key === '唤醒关键词') {
        keywords = splitKeywords(val);
      } else if (
        key === 'topics' ||
        key === 'interests' ||
        key === '话题词' ||
        key === '兴趣词' ||
        key === '兴趣话题'
      ) {
        topics = splitKeywords(val);
      } else if (
        key === 'reference' ||
        key === 'avatar' ||
        key === 'assets' ||
        key.includes('参考图') ||
        key.includes('三视图')
      ) {
        referencePath = val.replace(/^['"]|['"]$/g, '').trim();
      }
    }
  }

  // 2. 兼容正文里写【唤醒关键词】或“唤醒关键词：...”以及“兴趣话题：...”
  if (keywords.length === 0) {
    const inlineKw = raw.match(/(?:【唤醒关键词】|唤醒关键词\s*[:：])\s*([^\n]+)/);
    if (inlineKw) {
      keywords = splitKeywords(inlineKw[1]);
    }
  }
  if (topics.length === 0) {
    const inlineTopics = raw.match(/(?:【兴趣话题】|兴趣话题\s*[:：]|话题词\s*[:：])\s*([^\n]+)/);
    if (inlineTopics) {
      topics = splitKeywords(inlineTopics[1]);
    }
  }

  // 3. 兼容正文里写“人设三视图/参考图：./assets/”或“参考图：...”
  const refLineRe = /^[ \t]*(?:人设三视图\/参考图|人设参考图|三视图|参考图)\s*[:：]\s*([^\n]*)$/m;
  const refMatch = prompt.match(refLineRe);
  if (refMatch) {
    if (!referencePath) {
      referencePath = refMatch[1].trim();
    }
    const imgs = listPersonaReferenceImages(referencePath, baseDir);
    if (imgs.length > 0) {
      prompt = prompt.replace(
        refLineRe,
        `（你拥有 ${imgs.length} 张自己的形象参考图，需要确认外观细节可调用 get_self_image 查看，别人想看你长什么样时可调用 send_self_image 发图）`
      );
    } else {
      // 没有参考图就静默移除该路径行，不干扰模型
      prompt = prompt.replace(refLineRe, '').replace(/\n{3,}/g, '\n\n').trim();
    }
  }

  // 防止用户把名字只写在 frontmatter 里、正文没提名字导致模型不知道自己叫啥
  if (fullName && !prompt.slice(0, 80).includes(name)) {
    prompt = `你是 ${fullName}。\n${prompt}`;
  }

  cachedPath = personaPath;
  cachedMtimeMs = mtimeMs;
  cachedData = {
    name,
    keywords: [...new Set(keywords)],
    topics: [...new Set(topics)],
    referencePath,
    prompt,
  };
  return cachedData;
}
