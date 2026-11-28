/**
 * chat-soul-bridge 主入口（多模型通用 OneBot v11 桥接框架）
 *
 * 完整消息流：
 *   OneBot v11 WebSocket 收消息/拍一拍
 *     -> 白名单/黑名单校验 + 实时写入 state/memory.db 与内存缓存
 *     -> 群聊触发判定（@ / 引用 / 人设关键词 / 随机冒泡 + 防多 Bot 互刷护栏）
 *     -> 按 chatKey 串行排队 -> 拼装时间/上下文/图片 -> 调用统一多模型客户端（src/llm.js）
 *     -> 拟人化分条延迟发送到聊天窗口 + 落盘记忆库
 *
 * 同时运行定时冷场主动冒泡调度器（避开夜间免打扰时段，防连环刷屏）。
 */
import './bootstrap.js';
import fs from 'node:fs';
import path from 'node:path';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { loadConfig } from './config.js';
import { getBotRuntime, resolveBotResourcePath } from './runtime.js';
import { configureContextFade, getContextDbPath, getLastContextTsMs } from './context-db.js';
import { configureMemoryDb, initMemoryDb, saveChatMessageToDb, updateChatMessageTextInDb } from './db.js';
import {
  configureEmotion,
  ensureEmotionFile,
  formatEmotionForPrompt,
  formatMoodForPrompt,
  getEmotionSnapshot,
  recordDailyPassiveInteraction,
} from './emotion.js';
import { configureForward, resolveForwardMessage } from './forward.js';
import { detectImageMime } from './gif.js';
import {
  formatKnownUsersNote,
  formatSceneTag,
  resolveSpeakerIdentity,
} from './identity.js';
import {
  ensureImpressionsDb,
  findRelevantImpressions,
  getDynamicSpeakerRelation,
  getImpressionsDbPath,
  resolveImpressionScope,
  seedImpressionsFromConfig,
  touchUserInteraction,
} from './impressions.js';
import { resolveImageGenConfig } from './image-gen.js';
import { createLlmClient } from './llm.js';
import { archiveImagesForMessage, ensureMediaArchiveDir } from './media-archive.js';
import { cacheMessageImages } from './meme.js';
import {
  ensureDiaryDir,
  findCrossChatRecentMatches,
  formatMemoriesForPrompt,
  formatNow,
  getRecentMessages,
  recordRecentMessage,
} from './memory.js';
import { listPersonaReferenceImages, loadPersona } from './persona.js';
import { createSafetyGuard, ensureRateLimitFile } from './safety.js';
import {
  asyncLearnSlangWithLlm,
  ensureSlangDb,
  extractAbruptSlangCandidate,
  findMatchingSlang,
  formatSlangForPrompt,
  getSlangDbPath,
  observeAndSniffGroupRepeat,
  resolveSlangScope,
  seedDefaultSlang,
  sniffAndLearnSlang,
} from './slang.js';
import { markSyncHandled, syncMemoryAndCatchup, waitForClientReady } from './sync.js';
import {
  configureTodos,
  ensureTodosFile,
  formatTodosForPrompt,
  inspectTodoSchedule,
  markTodosStaleAsked,
  onTodosChanged,
  removeTodosByIds,
} from './todos.js';
import { buildTools, createToolExecutor, freeWebSearch, selectToolsForContext } from './tools.js';

const runtime = getBotRuntime();
const ROOT = runtime.dataRoot;
const config = loadConfig(ROOT);
configureContextFade(config.contextFade);
configureEmotion(config.emotion);
configureTodos(config.todos);
configureForward(config.forward);
configureMemoryDb({ pythonBin: config.paths.pythonBin });

const personaPath = resolveBotResourcePath(config.paths.personaFile || 'roles/persona.txt', ROOT, runtime.codeRoot);
const toolsPromptPath = config.paths.toolsPromptFile
  ? resolveBotResourcePath(config.paths.toolsPromptFile, ROOT, runtime.codeRoot)
  : '';
const LOG_TAG = runtime.isSubBot ? `[chat-bridge:${runtime.botName}]` : '[chat-bridge]';

function log(...args) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`${t} ${LOG_TAG}`, ...args);
}

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || config.proxyUrl || '';
if (proxyUrl) {
  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      httpProxy: proxyUrl,
      httpsProxy: proxyUrl,
      noProxy: '127.0.0.1,localhost',
    })
  );
  log(`已启用代理: ${proxyUrl}（127.0.0.1/localhost 自动直连）`);
}

const trustedGroupSet = new Set((config.memoryPrivacy?.trustedGroups || []).map(String));
const privateMemoryGroupSet = new Set((config.memoryPrivacy?.privateMemoryGroups || []).map(String));

function getPersona() {
  return loadPersona(personaPath);
}

function getToolsPrompt() {
  if (!toolsPromptPath) return '';
  try {
    if (fs.existsSync(toolsPromptPath)) {
      const content = fs.readFileSync(toolsPromptPath, 'utf8').trim();
      return content ? `\n\n${content}` : '';
    }
  } catch {}
  return '';
}

function getSystemInstruction(chatKey = '') {
  const base = getPersona().prompt;
  const toolsGuide = getToolsPrompt();
  // 隐私分级注入：
  // 1) 主人私聊 / 信任亲密小群：正常注入长期小本本；
  // 2) 熟人互通群（privateMemoryGroups）：注入长期小本本供心里有数，并附加严禁在群里泄露隐私的硬提醒；
  // 3) 外部普通群：0 字注入，彻底隔离。
  const isPrivate = chatKey.startsWith('private:');
  const gid = chatKey.startsWith('group:') ? chatKey.slice('group:'.length) : '';
  const isTrustedGroup = Boolean(gid) && trustedGroupSet.has(gid);
  const isPrivateMemoryGroup = Boolean(gid) && !isTrustedGroup && privateMemoryGroupSet.has(gid);
  let memories = '';
  if (isPrivate || isTrustedGroup) {
    memories = formatMemoriesForPrompt();
  } else if (isPrivateMemoryGroup) {
    const rawMem = formatMemoriesForPrompt();
    if (rawMem) {
      memories = rawMem.replace(
        '【长期小本本记忆】',
        '【长期小本本记忆（仅供你心里有数——当前在群聊有外人，绝对禁止直接复述本小本本，或泄露主人的隐私、私密心事、真实身份、联系方式及未公开私事）】'
      );
    }
  }
  return `${base}${toolsGuide}${memories}`;
}

function collectConfiguredSecrets(cfg) {
  const list = [];
  if (cfg?.snowluma?.accessToken) list.push(cfg.snowluma.accessToken);
  for (const p of Object.values(cfg?.llm?.providers || {})) {
    if (p && typeof p === 'object' && typeof p.apiKey === 'string' && p.apiKey.trim()) {
      list.push(p.apiKey.trim());
    }
  }
  for (const p of Object.values(cfg?.imageGen?.providers || {})) {
    if (p && typeof p === 'object' && typeof p.apiKey === 'string' && p.apiKey.trim()) {
      list.push(p.apiKey.trim());
    }
  }
  return list;
}

const safetyGuard = createSafetyGuard(config.safety, {
  extraSecrets: collectConfiguredSecrets(config),
  log,
});

async function rawSendOneBot(action, payload) {
  const url = `${config.snowluma.httpUrl.replace(/\/$/, '')}/${action}`;
  const headers = { 'Content-Type': 'application/json' };
  if (config.snowluma.accessToken) {
    headers.Authorization = `Bearer ${config.snowluma.accessToken}`;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`OneBot HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json().catch(() => ({}));
}

const sendOneBot = safetyGuard.wrapSendOneBot(rawSendOneBot);

const tools = buildTools({
  enableGoogleSearch: config.tools?.googleSearch === true,
  enableWebSearch: config.tools?.webSearch !== false,
});
const memeDir = path.resolve(ROOT, config.paths.memeDir || 'tools/meme');
const diaryDir = path.resolve(ROOT, config.paths.diaryDir || 'tools/Diary');
const imageGenConfig = resolveImageGenConfig(config);
const executeTool = createToolExecutor({
  sendOneBot,
  log,
  ownerId: config.ownerId,
  botId: config.snowluma?.botId,
  trustedGroups: config.memoryPrivacy?.trustedGroups || [],
  privateMemoryGroups: config.memoryPrivacy?.privateMemoryGroups || [],
  denyGroups: config.deny?.groups || [],
  denyPrivate: config.deny?.private || [],
  memeDir,
  diaryDir,
  imageGenConfig,
  enableEmotion: config.emotion?.enabled !== false,
  enableTodos: config.todos?.enabled !== false,
  enableSlang: config.slang?.enabled !== false,
  forwardConfig: config.forward,
  getBotName: () => getPersona().name,
  getReferencePath: () => getPersona().referencePath,
  onMessageSent: (res) => rememberMyMessageId(res),
  sendReply: (ev, txt, opts) => sendReply(ev, txt, opts),
});

// 解析 config.json 中的 "${ENV_VAR}" 占位符，同时支持直接明文填写和 .env 环境变量回退
function expandEnvString(val) {
  if (typeof val !== 'string') return '';
  return val.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, k) => process.env[k] || '').trim();
}

function resolveLlmConfig() {
  const llm = config.llm || {};
  // 新版统一格式：config.llm.active + config.llm.providers[active]
  if (llm.providers && typeof llm.providers === 'object') {
    const activeName = String(llm.active || '').trim();
    const entry = llm.providers[activeName];
    if (!entry) {
      throw new Error(
        `config.json 的 llm.active="${activeName}" 在 llm.providers 中不存在（可用：${Object.keys(llm.providers).filter((k) => !k.startsWith('_')).join(', ')}）`
      );
    }
    const protocol = entry.protocol || activeName;
    const envFallbackKey =
      process.env[`${activeName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`] ||
      process.env.LLM_API_KEY ||
      (protocol === 'gemini' ? process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY : '') ||
      (protocol === 'anthropic' ? process.env.ANTHROPIC_API_KEY : '') ||
      (protocol === 'openai' ? process.env.OPENAI_API_KEY : '');

    return {
      providerName: activeName,
      protocol,
      apiKey: expandEnvString(entry.apiKey) || envFallbackKey || '',
      baseUrl: expandEnvString(entry.baseUrl) || process.env.LLM_BASE_URL || '',
      binPath: expandEnvString(entry.binPath) || '',
      model: String(entry.model || '').trim(),
      fallbackModels: Array.isArray(entry.fallbackModels) ? entry.fallbackModels.filter(Boolean) : [],
      temperature: entry.temperature ?? llm.temperature ?? 1.0,
      presencePenalty: entry.presencePenalty ?? llm.presencePenalty ?? null,
      frequencyPenalty: entry.frequencyPenalty ?? llm.frequencyPenalty ?? null,
      maxTokens: entry.maxTokens ?? llm.maxTokens ?? 1024,
      thinkingLevel: String(entry.thinkingLevel || '').trim() || String(llm.thinkingLevel || '').trim(),
      thinkingBudget: Number(entry.thinkingBudget || 0) || Number(llm.thinkingBudget || 0),
      maxContextTurns: entry.maxContextTurns ?? llm.maxContextTurns ?? 20,
    };
  }

  // 向后兼容旧版扁平 config.gemini / config.llm
  const legacy = config.llm || { protocol: 'gemini', ...(config.gemini || {}) };
  const protocol = legacy.protocol || legacy.provider || 'gemini';
  return {
    providerName: legacy.provider || protocol,
    protocol,
    apiKey:
      expandEnvString(legacy.apiKey) ||
      process.env.LLM_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      '',
    baseUrl: expandEnvString(legacy.baseUrl) || process.env.LLM_BASE_URL || '',
    model: String(legacy.model || '').trim(),
    fallbackModels: Array.isArray(legacy.fallbackModels) ? legacy.fallbackModels.filter(Boolean) : [],
    temperature: legacy.temperature ?? 1.0,
    presencePenalty: legacy.presencePenalty ?? null,
    frequencyPenalty: legacy.frequencyPenalty ?? null,
    maxTokens: legacy.maxTokens ?? 1024,
    thinkingLevel: legacy.thinkingLevel ?? '',
    thinkingBudget: legacy.thinkingBudget ?? 0,
    maxContextTurns: legacy.maxContextTurns ?? 20,
  };
}

const activeLlm = resolveLlmConfig();
const llmProvider = activeLlm.providerName;
const llmModel = activeLlm.model;

function getToolsForChat(chatKey) {
  const persona = getPersona();
  const hasReferenceImages =
    listPersonaReferenceImages(persona.referencePath, path.dirname(personaPath)).length > 0;
  return selectToolsForContext(tools, {
    chatKey,
    ownerId: config.ownerId,
    trustedGroups: config.memoryPrivacy?.trustedGroups || [],
    hasReferenceImages,
    hasImageGen: imageGenConfig.enabled === true,
    enableEmotion: config.emotion?.enabled !== false,
    enableTodos: config.todos?.enabled !== false,
    enableSlang: config.slang?.enabled !== false,
  });
}

const llm = createLlmClient({
  ...activeLlm,
  tools,
  getTools: getToolsForChat,
  executeTool,
  getSystemInstruction,
});

/**
 * 解析群聊后续语义裁判客户端（零额外配置自动适配）：
 *   1. 若显式指定了 semanticJudge.provider -> 用该 HTTP 提供商；
 *   2. 若当前主模型是 HTTP 协议（DeepSeek/OpenAI/Gemini/Claude）-> 直接复用当前模型（关思考、0 工具、max_tokens=16）；
 *   3. 若当前主模型是 agy-cli：优先探测已配置有效 Key 的 HTTP 轻量模型（如 gemini + captionModel），没有则自动降级为主模型 [SKIP] 静默权。
 */
function resolveSemanticJudge() {
  const sj = config.groupTrigger?.semanticJudge || {};
  if (sj.enabled === false) {
    return { mode: 'off', client: null, model: '', label: '关' };
  }
  const reqMode = String(sj.mode || 'auto').trim().toLowerCase();
  if (reqMode === 'off' || reqMode === 'none') {
    return { mode: 'off', client: null, model: '', label: '关' };
  }
  if (reqMode === 'skip') {
    return { mode: 'skip', client: null, model: '', label: '主模型[SKIP]静默权' };
  }

  const providers = config.llm?.providers && typeof config.llm.providers === 'object' ? config.llm.providers : {};
  const buildHttpJudge = (pName, modelOverride = '') => {
    const entry = providers[pName];
    if (!entry || typeof entry !== 'object') return null;
    const proto = String(entry.protocol || pName).trim().toLowerCase();
    if (proto === 'agy-cli' || proto === 'agy' || proto === 'antigravity') return null;
    const envFallbackKey =
      process.env[`${pName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`] ||
      process.env.LLM_API_KEY ||
      (proto === 'gemini' || proto === 'google' ? process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY : '') ||
      (proto === 'anthropic' || proto === 'claude' ? process.env.ANTHROPIC_API_KEY : '') ||
      (proto === 'openai' || proto === 'deepseek' ? process.env.OPENAI_API_KEY : '');
    const apiKey = expandEnvString(entry.apiKey) || envFallbackKey || '';
    const baseUrl = expandEnvString(entry.baseUrl) || process.env.LLM_BASE_URL || '';
    const fallbacks = Array.isArray(entry.fallbackModels) ? entry.fallbackModels.filter(Boolean) : [];
    const targetModel =
      String(modelOverride || '').trim() ||
      (proto === 'gemini' || proto === 'google' ? String(config.mediaArchive?.captionModel || '').trim() : '') ||
      fallbacks[0] ||
      String(entry.model || '').trim();
    if (!apiKey || apiKey.startsWith('请替换') || !targetModel) return null;
    if ((proto === 'openai' || proto === 'deepseek' || proto === 'anthropic' || proto === 'claude') && !baseUrl) {
      return null;
    }
    try {
      const client = createLlmClient({
        providerName: `${pName}-judge`,
        protocol: proto,
        apiKey,
        baseUrl,
        model: targetModel,
        fallbackModels: fallbacks,
        temperature: 0,
        maxTokens: 16,
        thinkingLevel: 'none',
        tools: [],
        getSystemInstruction: () => '',
      });
      if (client?.supportsQuickJudge && typeof client.quickText === 'function') {
        return { mode: 'http', client, model: targetModel, label: `轻量HTTP裁判(${pName}/${targetModel})` };
      }
    } catch {}
    return null;
  };

  const explicitProvider = String(sj.provider || '').trim();
  const explicitModel = String(sj.model || '').trim();
  if (explicitProvider) {
    const ext = buildHttpJudge(explicitProvider, explicitModel);
    if (ext) return ext;
  }

  if (llm?.supportsQuickJudge && typeof llm.quickText === 'function') {
    const targetModel = explicitModel || llmModel;
    return {
      mode: 'http',
      client: llm,
      model: explicitModel,
      label: `复用当前模型(${llmProvider}/${targetModel}, 关思考极速判定)`,
    };
  }

  // 主模型是 agy-cli 且未显式指定裁判：优先找已配好 Key 的轻量 HTTP 提供商，否则退回主模型 [SKIP]
  const preferredOrder = ['gemini', 'deepseek', 'openai', 'claude', ...Object.keys(providers)];
  const tried = new Set();
  for (const pName of preferredOrder) {
    if (!pName || pName.startsWith('_') || tried.has(pName)) continue;
    tried.add(pName);
    const ext = buildHttpJudge(pName, explicitModel);
    if (ext) return ext;
  }

  if (reqMode === 'http') {
    return { mode: 'off', client: null, model: '', label: '关(无可用HTTP裁判)' };
  }
  return { mode: 'skip', client: null, model: '', label: '主模型[SKIP]静默权' };
}

const semanticJudge = resolveSemanticJudge();

// 每个会话串行排队，避免并发消息打乱 previous_interaction_id
const chatQueues = new Map();
function enqueue(chatKey, task) {
  const prev = chatQueues.get(chatKey) || Promise.resolve();
  const next = prev.then(task, task).finally(() => {
    if (chatQueues.get(chatKey) === next) chatQueues.delete(chatKey);
  });
  chatQueues.set(chatKey, next);
  return next;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 追踪各会话收到新消息的序号：用于长间隔停顿时检测插话并提前收尾，避免跨轮错位
const chatIncomingSeq = new Map();

async function sleepInterruptible(ms, shouldInterrupt) {
  const total = Math.max(0, Number(ms) || 0);
  if (total <= 400 || typeof shouldInterrupt !== 'function') {
    await sleep(total);
    return;
  }
  const deadline = Date.now() + total;
  while (Date.now() < deadline) {
    if (shouldInterrupt()) {
      await sleep(Math.min(350, Math.max(0, deadline - Date.now())));
      return;
    }
    await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
  }
}

// 记录机器人自己发出去的消息 ID（用来判断群友是否引用了机器人）
const myMessageIds = new Set();
function rememberMyMessageId(res) {
  const id = res?.data?.message_id;
  if (!id) return;
  myMessageIds.add(String(id));
  if (myMessageIds.size > 300) {
    const first = myMessageIds.values().next().value;
    myMessageIds.delete(first);
  }
}

/** 将超长单段按自然标点智能切分为 <= maxChars 的子段，避免超长被整条拒发 */
function splitLongSegment(seg, maxChars = 500) {
  const text = String(seg || '').trim();
  if (!text) return [];
  if (!maxChars || maxChars <= 0 || text.length <= maxChars) return [text];

  const chunks = [];
  let rest = text;
  const minCut = Math.max(20, Math.floor(maxChars * 0.45));
  while (rest.length > maxChars) {
    const slice = rest.slice(0, maxChars);
    let cut = -1;
    for (let i = slice.length - 1; i >= minCut; i--) {
      const ch = slice[i];
      if ('\n。！？!?；;'.includes(ch)) {
        cut = i + 1;
        break;
      }
    }
    if (cut < 0) {
      for (let i = slice.length - 1; i >= minCut; i--) {
        const ch = slice[i];
        if ('，,、 '.includes(ch)) {
          cut = i + 1;
          break;
        }
      }
    }
    if (cut < 0) cut = maxChars;
    const head = rest.slice(0, cut).trim();
    if (head) chunks.push(head);
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * 将长回复按换行拆分为 1~maxParts 条聊天消息气泡短消息，剥离常见 Markdown 加粗符号，
 * 并对单条超过 maxChars（默认 500 字）的段落自动按标点二次切分。
 */
function splitBurstMessages(text, maxParts = 4, maxChars = 500) {
  const cleaned = text
    .replace(/\r\n/g, '\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .trim();
  if (!cleaned) return [];
  const lines = cleaned
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const grouped =
    lines.length <= maxParts
      ? lines
      : [...lines.slice(0, maxParts - 1), lines.slice(maxParts - 1).join('\n')];

  if (!maxChars || maxChars <= 0) return grouped;
  const result = [];
  for (const part of grouped) {
    result.push(...splitLongSegment(part, maxChars));
  }
  // 极端超长防刷屏上限：最多允许 maxParts + 2 条气泡
  const hardCap = Math.max(maxParts, maxParts + 2);
  if (result.length > hardCap) {
    const kept = result.slice(0, hardCap);
    const last = kept[kept.length - 1];
    kept[kept.length - 1] =
      last.length >= maxChars ? `${last.slice(0, Math.max(1, maxChars - 1))}…` : `${last}…`;
    return kept;
  }
  return result;
}

/** 提取模型回复开头的轻量行内引用指令 [reply:msg_id] / [quote:msg_id]（支持负数 ID，全模型零额外轮次通用） */
function extractInlineReplyDirective(raw) {
  const str = String(raw || '');
  const m = str.match(/^\s*\[(?:reply|quote)\s*[:=]\s*(-?\d+)\]\s*/i);
  if (!m) return { replyToMessageId: '', text: str.trim() };
  return {
    replyToMessageId: m[1],
    text: str.slice(m[0].length).trim(),
  };
}

const BUILTIN_CLICHE_ENCYCLOPEDIA_RE =
  /(?:这个梗(?:出自|源于|来自)|原出处(?:是|为)|原曲(?:是|来自)|空耳(?:自|来自|源于)|科普一下|简单来说就是|综上所述|总而言之)/;
const BUILTIN_CLICHE_BULLET_RE = /(?:^|\n)\s*(?:1[.、]|一、)[\s\S]{4,}\n\s*(?:2[.、]|二、)/;
const ASKING_FOR_EXPLAIN_RE = /(?:科普|出处|啥意思|什么意思|怎么来的|原曲|原版|解释一下|来源|百科)/;
const ASKING_FOR_LIST_RE = /(?:怎么|如何|推荐|对比|区别|列出|步骤|教程|名单|有哪些|总结|分析|几个|哪些)/;

/** 轻量“防八股传染”检测：拦截百科科普腔、闲聊客服分点腔及用户自定义八股正则（正经问科普/攻略时自动放行） */
function detectReplyCliche(replyText, incomingText, filterCfg = {}) {
  if (filterCfg.enabled === false) return '';
  const clean = extractInlineReplyDirective(replyText).text;
  if (!clean) return '';
  const userText = String(incomingText || '');

  if (!ASKING_FOR_EXPLAIN_RE.test(userText) && BUILTIN_CLICHE_ENCYCLOPEDIA_RE.test(clean)) {
    return '百科科普腔';
  }
  if (!ASKING_FOR_LIST_RE.test(userText) && BUILTIN_CLICHE_BULLET_RE.test(clean)) {
    return '客服分点腔';
  }
  const customPatterns = Array.isArray(filterCfg.patterns) ? filterCfg.patterns : [];
  for (const rawPat of customPatterns) {
    const patStr = String(rawPat || '').trim();
    if (!patStr) continue;
    try {
      if (new RegExp(patStr, 'i').test(clean)) {
        return `自定义八股(${patStr.slice(0, 20)})`;
      }
    } catch {}
  }
  return '';
}

/**
 * 拟人化分条发送回复（条间按字数停顿 + 可配概率长停顿 + 逐条 try/catch 容错）：
 *   逐条按真实 OneBot message_id 写入 state/memory.db 与内存 recentBuffers，
 *   确保与离线同步拉取的群/私聊历史 1 对 1 精准去重，且引用任意一条气泡都能秒命中缓存。
 */
async function sendReply(event, text, { replyToMessageId = '' } = {}) {
  const parsed = extractInlineReplyDirective(text);
  const maxBurst = Math.max(1, Math.min(8, Number(config.reply?.maxBurstParts ?? 4)));
  const maxChars = Math.max(0, Number(config.safety?.maxMessageChars ?? 500));
  const parts = splitBurstMessages(parsed.text, maxBurst, maxChars);
  if (parts.length === 0) return '';

  const rawReplyId = String(replyToMessageId || parsed.replyToMessageId || '').trim();
  const replyIdStr = /^-?\d+$/.test(rawReplyId) ? rawReplyId : '';
  const chatKey =
    event.message_type === 'group' ? `group:${event.group_id}` : `private:${event.user_id}`;
  const botName = getPersona().name;
  const startSeq = chatIncomingSeq.get(chatKey) || 0;
  const useTypingDelay = config.reply?.typingDelay !== false;
  const interruptibleTyping = config.reply?.interruptibleTyping === true;
  const firstMin = Math.max(0, Number(config.reply?.firstReplyMinMs ?? 1500));
  const firstMax = Math.max(firstMin, Number(config.reply?.firstReplyMaxMs ?? 3500));
  const burstBase = Math.max(0, Number(config.reply?.burstBaseMs ?? 1500));
  const burstPerChar = Math.max(0, Number(config.reply?.burstPerCharMs ?? 400));
  const burstMax = Math.max(burstBase, Number(config.reply?.burstMaxMs ?? 12000));
  const burstJitter = Math.max(0, Number(config.reply?.burstJitterMs ?? 600));
  const longGapProb = Math.max(0, Math.min(0.6, Number(config.reply?.longGapProbability ?? 0)));
  const longGapMin = Math.max(1000, Number(config.reply?.longGapMinMs ?? 3000));
  const longGapMax = Math.max(longGapMin, Number(config.reply?.longGapMaxMs ?? 5500));
  const shouldInterruptTyping = interruptibleTyping
    ? () => (chatIncomingSeq.get(chatKey) || 0) !== startSeq
    : null;
  let lastMsgId = '';

  for (let i = 0; i < parts.length; i++) {
    if (i === 0) {
      if (useTypingDelay && firstMax > 0) {
        const firstDelay = firstMin + Math.floor(Math.random() * (firstMax - firstMin + 1));
        if (firstDelay > 0) {
          await sleepInterruptible(firstDelay, shouldInterruptTyping);
        }
      }
    } else if (useTypingDelay) {
      const isLongGap = longGapProb > 0 && Math.random() < longGapProb;
      const rawBurst =
        burstBase + parts[i].length * burstPerChar + Math.floor(Math.random() * (burstJitter + 1));
      const delay = isLongGap
        ? longGapMin + Math.floor(Math.random() * Math.max(1, longGapMax - longGapMin))
        : Math.min(burstMax, rawBurst);
      if (delay > 0) {
        await sleepInterruptible(delay, shouldInterruptTyping);
      }
    }

    const payloadMsg =
      i === 0 && replyIdStr
        ? [
            { type: 'reply', data: { id: replyIdStr } },
            { type: 'text', data: { text: parts[i] } },
          ]
        : parts[i];

    let res;
    try {
      if (event.message_type === 'private') {
        res = await sendOneBot('send_private_msg', { user_id: event.user_id, message: payloadMsg });
      } else if (event.message_type === 'group') {
        res = await sendOneBot('send_group_msg', { group_id: event.group_id, message: payloadMsg });
      }
    } catch (err) {
      const code = String(err?.code || '');
      log(`发送第 ${i + 1}/${parts.length} 条失败 (${chatKey}): ${err?.message || err}`);
      if (code === 'RISK_COOLDOWN' || code.startsWith('RATE_LIMIT_')) {
        break;
      }
      continue;
    }

    rememberMyMessageId(res);
    const msgId = res?.data?.message_id != null ? String(res.data.message_id) : '';
    if (msgId) lastMsgId = msgId;
    if (event.message_type === 'group') {
      const gKey = String(event.group_id);
      lastGroupBotReplyAt.set(gKey, Date.now());
      lastGroupBotReplyText.set(gKey, parts.slice(0, i + 1).join('\n').slice(0, 300));
    }

    recordRecentMessage(chatKey, {
      message_id: msgId || 'self',
      time: formatNow().slice(11, 16),
      user_id: String(config.snowluma.botId || ''),
      sender: `我·${botName}`,
      text: parts[i].slice(0, 120),
    });

    saveChatMessageToDb({
      scope: event.message_type === 'group' ? 'group' : 'private',
      groupId: event.message_type === 'group' ? event.group_id : null,
      messageId: msgId,
      who: config.snowluma.botId,
      whoName: botName,
      isSelf: true,
      isOwner: false,
      isTriggered: true,
      text: parts[i],
    }).then((r) => {
      if (r && !r.ok && !r.skipped) log('写入记忆库失败(发):', r.error || r);
    });
  }
  return lastMsgId;
}

/** 下载聊天消息里的图片并编码为 base64（按魔数识别真实格式，兼容 GIF 与无标准 Content-Type 的 CDN） */
async function downloadImage(url, maxBytes) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const rawContentType = (res.headers.get('content-type') || '').split(';')[0].trim();
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > maxBytes) return null;
    const mimeType = detectImageMime(buf, rawContentType);
    if (!mimeType) return null;
    return { data: buf.toString('base64'), mimeType };
  } catch {
    return null;
  }
}

/** 解析 OneBot v11 消息段数组（提取纯文本、图片/动图/商城表情 URL、合并转发 ID、引用 ID 与 @ 标记/列表） */
function parseMessage(event) {
  const selfId = String(event.self_id || config.snowluma.botId || '');
  const textParts = [];
  const imageUrls = [];
  const forwardIds = [];
  const mentionedUserIds = [];
  let replyId = null;
  let isAtMe = false;

  if (Array.isArray(event.message)) {
    for (const seg of event.message) {
      if (seg.type === 'text' && seg.data?.text) {
        textParts.push(seg.data.text);
      } else if (seg.type === 'at' && seg.data?.qq != null) {
        const atUid = String(seg.data.qq);
        if (atUid === selfId) {
          isAtMe = true;
        } else if (/^\d+$/.test(atUid)) {
          mentionedUserIds.push(atUid);
        }
      } else if (seg.type === 'image' && seg.data?.url) {
        imageUrls.push(seg.data.url);
      } else if (seg.type === 'mface') {
        if (seg.data?.url) imageUrls.push(seg.data.url);
        if (seg.data?.summary) textParts.push(String(seg.data.summary));
      } else if (seg.type === 'forward' && seg.data?.id) {
        forwardIds.push(String(seg.data.id));
      } else if (seg.type === 'reply' && seg.data?.id) {
        replyId = String(seg.data.id);
      }
    }
  } else if (typeof event.raw_message === 'string') {
    textParts.push(event.raw_message);
    if (selfId && event.raw_message.includes(`[CQ:at,qq=${selfId}]`)) {
      isAtMe = true;
    }
    for (const m of event.raw_message.matchAll(/\[CQ:at,qq=(\d+)\]/g)) {
      if (m[1] !== selfId) mentionedUserIds.push(m[1]);
    }
    const cqReply = event.raw_message.match(/\[CQ:reply,id=([^\],\s]+)\]/);
    if (cqReply) replyId = String(cqReply[1]);
  }

  let text = textParts.join('').trim();
  for (const fid of forwardIds) {
    text = `${text} [合并转发 id=${fid}]`.trim();
  }
  return { text, imageUrls, forwardIds, mentionedUserIds, replyId, isAtMe };
}

/**
 * 自动展开消息里的合并转发（调用 get_forward_msg），返回：
 *   - text       : 完整展开版（写入 state/memory.db 供 chat_recall 检索，同时直接送给模型阅读）
 *   - compactText: 精简预览版（写入内存 recentBuffers，避免群聊上下文窗口被长转发撑爆）
 *   - imageUrls  : 合并转发内附带的图片 URL（合并进图片列表，让模型直接看清转发里的图）
 */
async function expandForwardsInMessage(forwardIds = [], baseText = '', baseImageUrls = []) {
  let fullText = String(baseText || '');
  let compactText = String(baseText || '');
  const mergedImages = [...(Array.isArray(baseImageUrls) ? baseImageUrls : [])];
  if (config.forward?.autoExpand === false) {
    return { text: fullText, compactText, imageUrls: mergedImages, expandedCount: 0 };
  }
  const maxImgLimit = Math.max(0, Number(config.forward?.maxExpandImages ?? 4));
  let expandedCount = 0;

  for (const fid of (forwardIds || []).slice(0, 3)) {
    const resolved = await resolveForwardMessage(sendOneBot, fid, {
      maxItems: Number(config.forward?.maxExpandItems ?? 60),
      maxDepth: Number(config.forward?.maxExpandDepth ?? 5),
      maxImages: Math.max(0, maxImgLimit - mergedImages.length),
      maxChars: Number(config.forward?.maxExpandChars ?? 5000),
      formatIdentity: (uid, rawName) => resolveSpeakerIdentity(uid, rawName, config, getPersona().name).label,
    });
    if (!resolved.ok || !resolved.summaryText) {
      log(`自动展开合并转发失败 (id=${fid}): ${resolved.error || 'unknown'}`);
      continue;
    }
    expandedCount += 1;
    const token = `[合并转发 id=${fid}]`;
    fullText = fullText.includes(token)
      ? fullText.replace(token, resolved.summaryText)
      : `${fullText}\n${resolved.summaryText}`.trim();
    compactText = compactText.includes(token)
      ? compactText.replace(token, resolved.compactText)
      : `${compactText} ${resolved.compactText}`.trim();
    for (const url of resolved.imageUrls || []) {
      if (mergedImages.length < maxImgLimit && !mergedImages.includes(url)) {
        mergedImages.push(url);
      }
    }
  }

  return { text: fullText, compactText, imageUrls: mergedImages, expandedCount };
}

/**
 * 展开被引用消息的原话与图片：
 *   1. 优先命中当前会话的内存缓存（零网络开销）；
 *   2. 缓存未命中或仅存有“[图片]”占位时，调用 OneBot get_msg 拉取完整消息内容（含图片 URL）；
 *   3. 若原消息已被撤回或协议端不支持，静默降级返回缓存或 null，不影响正常对话。
 */
async function resolveQuotedMessage(chatKey, replyId) {
  if (!replyId) return null;
  const targetId = String(replyId);

  const recent = getRecentMessages(chatKey, 30);
  const hit = recent.find((m) => String(m.message_id) === targetId);
  const isIncompleteCache = !hit?.text || hit.text === '[图片]' || hit.text.includes('[合并转发');
  if (hit && !isIncompleteCache) {
    return {
      sender: hit.sender || String(hit.user_id || '未知'),
      userId: String(hit.user_id || ''),
      text: hit.text,
      imageUrls: [],
    };
  }

  try {
    const numId = /^-?\d+$/.test(targetId) ? Number(targetId) : targetId;
    const res = await sendOneBot('get_msg', { message_id: numId });
    const data = res?.data;
    if (data) {
      const rawSender =
        data.sender?.card ||
        data.sender?.nickname ||
        String(data.sender?.user_id || data.user_id || '未知');
      const userId = String(data.sender?.user_id || data.user_id || '');
      const speaker = resolveSpeakerIdentity(userId, rawSender, config, getPersona().name);
      const parsed = parseMessage(data);
      let qText = parsed.text || (parsed.imageUrls.length > 0 ? '[图片]' : '');
      let qImages = parsed.imageUrls;
      let isForward = false;
      if (parsed.forwardIds.length > 0) {
        const exp = await expandForwardsInMessage(parsed.forwardIds, qText, qImages);
        if (exp.expandedCount > 0) {
          qText = exp.text;
          qImages = exp.imageUrls;
          isForward = true;
        }
      }
      if (qText || qImages.length > 0) {
        return { sender: speaker.label, userId, text: qText, imageUrls: qImages, isForward };
      }
    }
  } catch (err) {
    log(`拉取被引用消息失败 (id=${targetId}):`, err?.message || err);
  }

  if (hit) {
    return {
      sender: hit.sender || String(hit.user_id || '未知'),
      userId: String(hit.user_id || ''),
      text: hit.text || '',
      imageUrls: [],
    };
  }
  return null;
}

/** 校验私聊/群聊是否在放行范围内（黑名单 deny 优先级最高） */
function isAllowedTarget(type, id) {
  if (type === 'private') {
    const deny = new Set((config.deny?.private || []).map(String));
    if (deny.has(String(id))) return false;
    if (config.allowAllPrivate) return true;
    const list = new Set([...(config.allow?.private || []), config.ownerId].filter(Boolean).map(String));
    return list.has(String(id));
  }
  if (type === 'group') {
    const deny = new Set((config.deny?.groups || []).map(String));
    if (deny.has(String(id))) return false;
    if (config.allowAllGroups) return true;
    const list = new Set((config.allow?.groups || []).map(String));
    return list.has(String(id));
  }
  return false;
}

// 活跃追踪 + 群聊冒泡冷却 + 管理员独立冷却/连聊窗口 + 上句回声缓存 + 语义裁判冷却 + 防 AI 互怼死循环计数
const bridgeStartedAt = Date.now();
const lastActivityAt = new Map();
const proactiveSentAt = new Map(); // chatKey -> 上次主动冒泡时间戳（收到对方消息立即清零，或超过 unansweredResetHours 自动解锁）
const lastRandomReplyAt = new Map();
const lastOwnerRandomReplyAt = new Map();
const lastGroupBotReplyAt = new Map();
const lastGroupBotReplyText = new Map();
const lastSemanticJudgeAt = new Map();
const nonOwnerStreak = new Map();
const lastNonOwnerTriggerAt = new Map();
const activeGroupReplyCount = new Map();

const ECHO_STOPWORDS = new Set([
  '什么', '怎么', '怎样', '还是', '就是', '不是', '已经', '因为', '所以', '但是', '不过', '其实',
  '如果', '可以', '一下', '这个', '那个', '这样', '那样', '我们', '你们', '他们', '自己', '大家',
  '哈哈', '呵呵', '嘻嘻', '嗯嗯', '好的', '好吧', '好呀', '知道', '觉得', '真的', '没有', '现在',
  '今天', '明天', '昨天', '刚才', '时候', '东西', '事情', '有点', '一点', '这么', '那么', '不会',
  '不要', '不能', '应该', '可能', '好像', '感觉', '出来', '起来', '进去', '回去', '过来', '过去',
  '老大', '主人', '群主', '管理员',
]);

/** 提取并匹配机器人上一条群回复与当前群消息的实词回声（0ms，过滤常见虚词防误触发） */
function findEchoOverlap(botLastText, incomingText) {
  const prev = String(botLastText || '').trim();
  const cur = String(incomingText || '').trim().toLowerCase();
  if (!prev || cur.length < 2) return '';
  const spans = prev.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,}/g) || [];
  for (const rawSpan of spans) {
    const span = rawSpan.toLowerCase();
    for (let len = Math.min(4, span.length); len >= 2; len--) {
      for (let i = 0; i + len <= span.length; i++) {
        const sub = span.slice(i, i + len);
        if (/^\d+$/.test(sub)) continue;
        if (len === 2 && (ECHO_STOPWORDS.has(sub) || /^[a-z]{2}$/.test(sub))) continue;
        if (cur.includes(sub)) return rawSpan.slice(i, i + len);
      }
    }
  }
  return '';
}

/** 判断消息是否显式点名了同群其他 AI 伙伴（避免别人叫另一只 Bot 时抢答） */
function mentionsOtherAiBot(text) {
  const lower = String(text || '').toLowerCase();
  if (!lower) return false;
  const myKws = new Set(
    [getPersona().name, ...(getPersona().keywords || []), ...(config.groupTrigger?.keywords || [])]
      .map((s) => String(s || '').trim().toLowerCase())
      .filter(Boolean)
  );
  for (const info of Object.values(config.identity?.aiBots || {})) {
    const name = String(typeof info === 'string' ? info : info?.name || '').trim().toLowerCase();
    if (name.length >= 2 && !myKws.has(name) && lower.includes(name)) {
      return true;
    }
  }
  return false;
}

/**
 * 第一层零成本续聊强相关检测（仅在刚回完话的续聊窗口内运行，0ms / 0 Token）：
 *   1. 回声匹配：对方复述了机器人上一句里的 2~4 字实词（如复述关键词/刚聊到的梗）；
 *   2. 短时第二人称紧接：机器人刚说完话 25 秒内，对方没 @ 别人、没点名其他 Bot，直接用“你/您”搭话。
 */
function detectFollowupDirectSignal(gKey, text, mentionedUserIds, sinceBotReply, isOwner) {
  if (!text || text.length < 2) return null;
  if (Array.isArray(mentionedUserIds) && mentionedUserIds.length > 0) return null;
  if (mentionsOtherAiBot(text)) return null;

  if (config.groupTrigger?.followupEchoEnabled !== false) {
    const echo = findEchoOverlap(lastGroupBotReplyText.get(gKey), text);
    if (echo) {
      return { reason: 'followup_echo', detail: echo };
    }
  }

  const directWin = Number(config.groupTrigger?.followupDirectWindowMs ?? 25000);
  if (directWin > 0 && sinceBotReply <= directWin) {
    const talksToOwner = !isOwner && /(?:老大|主人|群主|管理员)\s*你/.test(text);
    if (!talksToOwner && /(?:你(?!们)|您)/.test(text)) {
      return { reason: 'followup_direct', detail: '第二人称紧接' };
    }
  }
  return null;
}

/** 第二层 HTTP 语义裁判（复用当前 HTTP 模型关思考极速判 YES/NO，或使用配置的轻量 HTTP 模型） */
async function runHttpSemanticJudge(chatKey, senderLabel, incomingText) {
  if (semanticJudge.mode !== 'http' || !semanticJudge.client?.quickText) return null;
  const sj = config.groupTrigger?.semanticJudge || {};
  const maxCtx = Math.max(2, Math.min(10, Number(sj.maxContextMessages ?? 6)));
  const recent = getRecentMessages(chatKey, maxCtx + 1).slice(0, -1);
  const historyLines = recent.map((m) => `${m.time} [${m.sender}]: ${m.text}`).join('\n');
  const persona = getPersona();
  const aliasList = [...new Set([persona.name, ...(persona.keywords || [])].filter(Boolean))].join(' / ');
  const prompt =
    `你是群聊相关性判断助手。当前角色叫「${persona.name}」（别名/唤醒词：${aliasList || persona.name}）。\n` +
    `请结合下面最近几条群聊记录，判断最新一条消息是不是在对「${persona.name}」说话、回应「${persona.name}」刚说的话，或者「${persona.name}」顺嘴接一句很自然。\n` +
    `如果明显是在和别人聊天、与「${persona.name}」无关，输出 NO；如果相关或适合接茬，输出 YES。\n` +
    `只输出 YES 或 NO，不要任何解释。\n\n` +
    `【最近群聊】\n${historyLines || '（无）'}\n` +
    `【最新消息】\n[${senderLabel}]: ${incomingText}`;
  const raw = await semanticJudge.client.quickText(prompt, {
    preferredModel: semanticJudge.model || '',
    maxTokens: 16,
    timeoutMs: Number(sj.timeoutMs ?? 8000),
  });
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (/\bYES\b/.test(upper) && !/\bNO\b/.test(upper)) return true;
  if (/\bNO\b/.test(upper) && !/\bYES\b/.test(upper)) return false;
  if (/^(是|相关|需要|回复)/.test(raw.trim())) return true;
  if (/^(否|不是|无关|不用|跳过)/.test(raw.trim())) return false;
  return null;
}

function touchActivity(chatKey) {
  lastActivityAt.set(chatKey, Date.now());
  proactiveSentAt.delete(chatKey);
}

/**
 * 计算群聊当前的话题相关度（0 API 消耗）：
 *   - 合并 roles/persona.txt 的 topics 与 config.groupTrigger.topicKeywords；
 *   - 当前消息每命中 1 个不同话题词 +1.0（单条上限 2.0）；
 *   - 群聊最近 5 条上下文中每条命中话题词的消息 +0.35（延续上下文热度，上限 1.4）；
 *   - 返回 { heat, matchedWords }，用于给随机搭话概率做平滑加成。
 */
function computeGroupTopicHeat(chatKey, currentText) {
  const rawTopics = [
    ...(getPersona().topics || []),
    ...(config.groupTrigger?.topicKeywords || []),
  ];
  const topics = [...new Set(rawTopics.map((w) => String(w || '').trim()).filter(Boolean))];
  if (topics.length === 0) return { heat: 0, matchedWords: [] };

  const matched = new Set();
  const curLower = String(currentText || '').toLowerCase();
  let curHits = 0;
  for (const kw of topics) {
    if (curLower.includes(kw.toLowerCase())) {
      matched.add(kw);
      curHits += 1;
    }
  }
  let heat = Math.min(2.0, curHits * 1.0);

  // 结合最近 5 条刚聊过的话：即便当前这句只是“我也想吃”，只要刚聊过相关话题也保持热度
  const recent = getRecentMessages(chatKey, 6).slice(0, -1);
  let ctxHits = 0;
  for (const m of recent) {
    const mLower = String(m.text || '').toLowerCase();
    let msgMatched = false;
    for (const kw of topics) {
      if (mLower.includes(kw.toLowerCase())) {
        matched.add(kw);
        msgMatched = true;
      }
    }
    if (msgMatched) ctxHits += 1;
  }
  heat += Math.min(1.4, ctxHits * 0.35);

  return { heat: Math.round(heat * 100) / 100, matchedWords: [...matched] };
}

/**
 * 群聊唤醒判定：依次检查防多 Bot 死循环护栏 -> @ -> 引用回复 -> 人设关键词 -> 续聊回声/第二人称直指 -> 管理员优先/短时续聊窗口/话题热度/普通群友概率。
 * 返回 { reason, matchedTopics, skipReason, directDetail, eligibleForSemanticJudge }（reason 为 null 表示暂未触发）。
 */
function checkGroupTrigger(
  groupId,
  senderId,
  text,
  isAtMe,
  replyId,
  hasImage = false,
  speaker = null,
  chatKey = '',
  mentionedUserIds = []
) {
  const gKey = String(groupId);
  const now = Date.now();
  const isOwner = Boolean(config.ownerId) && String(senderId) === String(config.ownerId);
  const isKnownBot =
    !isOwner &&
    (speaker?.isAiBot === true || (speaker?.role === 'known' && /(ai|bot|机器人)/i.test(String(speaker.tag || ''))));
  const maxStreak = Number(config.groupTrigger?.maxConsecutiveWithoutOwner ?? 2);
  const resetMs = Math.max(0, Number(config.groupTrigger?.nonOwnerStreakResetMs ?? 0));
  if (resetMs > 0 && (nonOwnerStreak.get(gKey) || 0) > 0) {
    const lastTrig = lastNonOwnerTriggerAt.get(gKey) || 0;
    if (lastTrig > 0 && now - lastTrig >= resetMs) {
      nonOwnerStreak.set(gKey, 0);
    }
  }
  const currentStreak = nonOwnerStreak.get(gKey) || 0;

  if (isOwner) {
    nonOwnerStreak.set(gKey, 0);
  }

  // 硬上限熔断：无主人参与时连续接话达上限，所有非主人消息（含引用回复与未登记的外部 Bot）一律暂停，绝不因他人引用/@清零计数
  if (!isOwner && currentStreak >= maxStreak) {
    return {
      reason: null,
      matchedTopics: [],
      skipReason: `${isKnownBot ? 'AI' : '无主人'}连聊达上限(${currentStreak}/${maxStreak})`,
    };
  }

  // 防群聊队列积压：本群已有回复正在思考或慢节奏发送中时，不再把后续非主人消息堆进队列（避免几十秒后吐出陈年引用回复）
  if (!isOwner && (activeGroupReplyCount.get(gKey) || 0) > 0) {
    return { reason: null, matchedTopics: [], skipReason: '群聊回复进行中，跳过排队积压' };
  }

  // 显式 @ 提及与引用回复：均计入无主人连聊轮数（仅主人发话可清零）
  if (config.groupTrigger?.atMention !== false && isAtMe) {
    if (!isOwner) {
      nonOwnerStreak.set(gKey, currentStreak + 1);
      lastNonOwnerTriggerAt.set(gKey, now);
    }
    return { reason: 'at', matchedTopics: [], skipReason: '' };
  }

  if (config.groupTrigger?.replyToMe !== false && replyId && myMessageIds.has(String(replyId))) {
    if (!isOwner) {
      nonOwnerStreak.set(gKey, currentStreak + 1);
      lastNonOwnerTriggerAt.set(gKey, now);
    }
    return { reason: 'reply', matchedTopics: [], skipReason: '' };
  }

  const keywords = [...new Set([...(getPersona().keywords || []), ...(config.groupTrigger?.keywords || [])])];
  const lower = text.toLowerCase();
  if (keywords.some((kw) => kw && lower.includes(String(kw).toLowerCase()))) {
    if (!isOwner) {
      nonOwnerStreak.set(gKey, currentStreak + 1);
      lastNonOwnerTriggerAt.set(gKey, now);
    }
    return { reason: 'keyword', matchedTopics: [], skipReason: '' };
  }

  const lastBotReply = lastGroupBotReplyAt.get(gKey) || 0;
  const sinceBotReply = lastBotReply > 0 ? now - lastBotReply : Infinity;
  const followupWindowMs = Number(config.groupTrigger?.followupWindowMs ?? 60000);
  const ownerFollowupWindowMs = Number(config.groupTrigger?.ownerFollowupWindowMs ?? 90000);
  const inFollowup = followupWindowMs > 0 && sinceBotReply <= followupWindowMs;
  const inOwnerFollowup = ownerFollowupWindowMs > 0 && sinceBotReply <= ownerFollowupWindowMs;

  // 第一层零成本本地强相关检测：刚回完话续聊窗口内，复述上句实词或短时第二人称直指 -> 直接接话（仍受无主人连聊上限兜底）
  if (inFollowup || (isOwner && inOwnerFollowup)) {
    const directSig = detectFollowupDirectSignal(gKey, text, mentionedUserIds, sinceBotReply, isOwner);
    if (directSig) {
      if (isOwner) {
        lastOwnerRandomReplyAt.set(gKey, now);
      } else {
        lastRandomReplyAt.set(gKey, now);
        nonOwnerStreak.set(gKey, currentStreak + 1);
        lastNonOwnerTriggerAt.set(gKey, now);
      }
      return { reason: directSig.reason, matchedTopics: [], skipReason: '', directDetail: directSig.detail };
    }
  }

  // 计算角色兴趣话题热度加成（0 延迟、0 API 消耗）
  const { heat, matchedWords } = computeGroupTopicHeat(chatKey || `group:${gKey}`, text);
  const topicBoostStep = Number(config.groupTrigger?.topicBoostStep ?? 0.25);
  const topicMaxBoost = Number(config.groupTrigger?.topicMaxBoost ?? 0.45);
  const topicBoost = heat > 0 ? Math.min(topicMaxBoost, heat * topicBoostStep) : 0;

  const canSemanticJudge =
    semanticJudge.mode !== 'off' &&
    (inFollowup || (isOwner && inOwnerFollowup)) &&
    text.length >= 2 &&
    (!Array.isArray(mentionedUserIds) || mentionedUserIds.length === 0) &&
    !mentionsOtherAiBot(text);

  // 管理员发言专属通道：更高唤醒概率 + 更短独立冷却 + 刚聊过天时的连聊窗口加成 + 话题热度加成
  if (isOwner) {
    const baseOwnerProb = Number(
      config.groupTrigger?.ownerRandomReplyProbability ??
        config.groupTrigger?.randomReplyProbability ??
        0.75
    );
    if (baseOwnerProb <= 0) {
      return { reason: null, matchedTopics: matchedWords, skipReason: '管理员随机回复已关闭', eligibleForSemanticJudge: canSemanticJudge };
    }
    if (text.length < 1 && !hasImage) {
      return { reason: null, matchedTopics: matchedWords, skipReason: '消息内容为空' };
    }
    const ownerCooldownMs = Number(config.groupTrigger?.ownerReplyCooldownMs ?? 10000);
    const prob = Math.min(0.95, baseOwnerProb + (inOwnerFollowup ? 0.2 : 0) + topicBoost);
    const last = lastOwnerRandomReplyAt.get(gKey) || 0;
    if (now - last < ownerCooldownMs) {
      const remainSec = Math.max(1, Math.ceil((ownerCooldownMs - (now - last)) / 1000));
      return { reason: null, matchedTopics: matchedWords, skipReason: `管理员冷却中(剩${remainSec}s)`, eligibleForSemanticJudge: canSemanticJudge };
    }
    if (Math.random() < prob) {
      lastOwnerRandomReplyAt.set(gKey, now);
      const reason = topicBoost > 0 ? 'owner_topic' : inOwnerFollowup ? 'owner_followup' : 'owner_random';
      return { reason, matchedTopics: matchedWords, skipReason: '' };
    }
    return {
      reason: null,
      matchedTopics: matchedWords,
      skipReason: `管理员${inOwnerFollowup ? '续聊' : '随机'}概率未中(${Math.round(prob * 100)}%)`,
      eligibleForSemanticJudge: canSemanticJudge,
    };
  }

  // 非管理员：区分“已知同群 AI 伙伴”与“普通人类群友”，并支持刚回完话的短时续聊窗口加成（仍受无主人连聊上限兜底）
  const baseProb = isKnownBot
    ? Number(config.groupTrigger?.botRandomReplyProbability ?? 0.15)
    : Number(config.groupTrigger?.randomReplyProbability ?? 0.3);
  if (baseProb <= 0) {
    return {
      reason: null,
      matchedTopics: matchedWords,
      skipReason: isKnownBot ? 'AI随机接话已关闭' : '随机插话已关闭',
      eligibleForSemanticJudge: canSemanticJudge,
    };
  }
  const followupBoost = inFollowup ? Math.max(0, Number(config.groupTrigger?.followupBoost ?? 0.35)) : 0;
  const prob = isKnownBot
    ? Math.min(0.65, baseProb + followupBoost + topicBoost * 0.5)
    : Math.min(0.85, baseProb + followupBoost + topicBoost);
  const baseCooldownMs = Number(config.groupTrigger?.randomReplyCooldownMs ?? 30000);
  const followupCooldownMs = Number(config.groupTrigger?.followupCooldownMs ?? 8000);
  const effectiveCooldownMs = inFollowup ? Math.min(baseCooldownMs, followupCooldownMs) : baseCooldownMs;

  if (!(text.length >= 2 || ((topicBoost > 0 || inFollowup) && text.length >= 1))) {
    return { reason: null, matchedTopics: matchedWords, skipReason: '消息过短' };
  }
  const last = lastRandomReplyAt.get(gKey) || 0;
  if (now - last < effectiveCooldownMs) {
    const remainSec = Math.max(1, Math.ceil((effectiveCooldownMs - (now - last)) / 1000));
    return {
      reason: null,
      matchedTopics: matchedWords,
      skipReason: `${isKnownBot ? 'AI' : '群'}${inFollowup ? '续聊' : '随机'}冷却中(剩${remainSec}s)`,
      eligibleForSemanticJudge: canSemanticJudge,
    };
  }
  if (Math.random() < prob) {
    lastRandomReplyAt.set(gKey, now);
    nonOwnerStreak.set(gKey, currentStreak + 1);
    lastNonOwnerTriggerAt.set(gKey, now);
    const reason = topicBoost > 0 ? 'topic' : inFollowup ? 'followup' : 'random';
    return { reason, matchedTopics: matchedWords, skipReason: '' };
  }
  return {
    reason: null,
    matchedTopics: matchedWords,
    skipReason: `${isKnownBot ? 'AI' : '群友'}${inFollowup ? '续聊' : '随机'}概率未中(${Math.round(prob * 100)}%)`,
    eligibleForSemanticJudge: canSemanticJudge,
  };
}

// ── 主动找你聊（定时冷场检查） ───────────────────────────────────────────────
let wsConnected = false;

function isQuietHour() {
  const start = Number(config.proactive?.quietStartHour ?? 23);
  const end = Number(config.proactive?.quietEndHour ?? 8);
  const h = new Date().getHours();
  if (start > end) {
    return h >= start || h < end;
  }
  return h >= start && h < end;
}

function describeTimeOfDay(date = new Date()) {
  const h = date.getHours();
  if (h >= 5 && h < 9) return '早上';
  if (h >= 9 && h < 12) return '上午';
  if (h >= 12 && h < 14) return '中午';
  if (h >= 14 && h < 18) return '下午';
  if (h >= 18 && h < 20) return '傍晚';
  return '晚上';
}

function logProactiveSkip(chatKey, reason) {
  if (config.proactive?.logSkipped !== false) {
    log(`[proactive] 跳过 ${chatKey} (${reason})`);
  }
}

function isProactiveLocked(chatKey, now = Date.now()) {
  const sentAt = proactiveSentAt.get(chatKey) || 0;
  if (!sentAt) return false;
  const resetHours = Number(config.proactive?.unansweredResetHours ?? 12);
  if (resetHours <= 0) return true; // <=0 表示严格锁到对方回复为止
  return now - sentAt < resetHours * 3600 * 1000;
}

/** 启动时从本地 context.db 与 sync-state.json 恢复真实上次活跃时间，避免一重启就归零重算冷场 */
function restoreLastActivityAt(chatKey) {
  const now = Date.now();
  let best = getLastContextTsMs(chatKey);
  try {
    const syncPath = path.join(ROOT, 'state', 'sync-state.json');
    if (fs.existsSync(syncPath)) {
      const parsed = JSON.parse(fs.readFileSync(syncPath, 'utf8'));
      const sec = Number(parsed?.lastHandled?.[chatKey]?.ts || 0);
      if (Number.isFinite(sec) && sec > 0) {
        best = Math.max(best, Math.round(sec * 1000));
      }
    }
  } catch {}
  if (best > 0) return Math.min(best, now);
  return now;
}

function scheduleProactiveCheck(chatKey, targetEvent) {
  if (!config.proactive?.enabled) return;
  const minMs = Math.max(60000, Number(config.proactive?.checkIntervalMinMs ?? 900000));
  const maxMs = Math.max(minMs, Number(config.proactive?.checkIntervalMaxMs ?? 1500000));
  const delay = minMs + Math.floor(Math.random() * Math.max(1000, maxMs - minMs));

  setTimeout(async () => {
    try {
      await maybeSendProactive(chatKey, targetEvent);
    } catch (err) {
      log(`主动冒泡检查异常 (${chatKey}):`, err?.message || err);
    } finally {
      scheduleProactiveCheck(chatKey, targetEvent);
    }
  }, delay);
}

async function maybeSendProactive(chatKey, targetEvent) {
  const now = Date.now();
  if (!wsConnected) {
    logProactiveSkip(chatKey, 'WebSocket 未连接');
    return;
  }
  if (isQuietHour()) {
    logProactiveSkip(chatKey, `夜间免打扰 ${config.proactive?.quietStartHour ?? 23}:00~${config.proactive?.quietEndHour ?? 8}:00`);
    return;
  }
  const graceMs = Math.max(0, Number(config.proactive?.startupGraceMs ?? 600000));
  if (graceMs > 0 && now - bridgeStartedAt < graceMs) {
    const remainMin = Math.ceil((graceMs - (now - bridgeStartedAt)) / 60000);
    logProactiveSkip(chatKey, `启动保护期剩约 ${remainMin} 分`);
    return;
  }
  if (isProactiveLocked(chatKey, now)) {
    const sentAt = proactiveSentAt.get(chatKey) || now;
    const waitedH = ((now - sentAt) / 3600000).toFixed(1);
    const resetH = Number(config.proactive?.unansweredResetHours ?? 12);
    logProactiveSkip(chatKey, `上次主动消息尚未回复，锁定中(${waitedH}/${resetH > 0 ? `${resetH}h` : '∞'})`);
    return;
  }

  const idleThresholdMs = Math.max(60000, Number(config.proactive?.idleThresholdMs ?? 2700000));
  const last = lastActivityAt.get(chatKey) || 0;
  const idleMs = now - last;
  if (idleMs < idleThresholdMs) {
    logProactiveSkip(chatKey, `冷场 ${Math.floor(idleMs / 60000)}/${Math.round(idleThresholdMs / 60000)} 分`);
    return;
  }

  // 冷场越久主动意愿越高：刚满阈值走基础概率，超 2 倍阈值涨至 >=65%，超 4 倍阈值涨至 >=85%，杜绝连黑数小时
  let prob = Number(config.proactive?.probability ?? 0.35);
  if (idleMs >= idleThresholdMs * 4) {
    prob = Math.max(prob, 0.85);
  } else if (idleMs >= idleThresholdMs * 2) {
    prob = Math.max(prob, 0.65);
  }
  // 好感度与心情联动主动意愿：心情极低落或关系疏远时减少主动打扰，开心且亲近时略微更主动
  if (targetEvent.message_type === 'private' && config.emotion?.enabled !== false) {
    const emo = getEmotionSnapshot();
    if (emo.mood <= -20 || emo.affection < 30) {
      logProactiveSkip(chatKey, `当前情绪/好感暂不适合打扰(mood=${emo.mood}, aff=${emo.affection})`);
      return;
    }
    if (emo.mood >= 20 && emo.affection >= 65) prob = Math.min(0.9, prob * 1.25);
  }
  if (Math.random() >= prob) {
    logProactiveSkip(chatKey, `概率未中 ${Math.round(prob * 100)}%，已冷场 ${Math.floor(idleMs / 60000)} 分`);
    return;
  }

  const wakeCat = targetEvent.message_type === 'group' ? 'group_auto' : 'private';
  const wakeCheck = safetyGuard.checkAndRecordWake(chatKey, wakeCat);
  if (!wakeCheck.ok) {
    log(`[safety] 跳过主动冒泡 (${chatKey}): ${wakeCheck.error}`);
    return;
  }

  enqueue(chatKey, async () => {
    const fireNow = Date.now();
    if (isProactiveLocked(chatKey, fireNow)) return;
    proactiveSentAt.set(chatKey, fireNow);
    lastActivityAt.set(chatKey, fireNow);

    try {
      const nowStr = formatNow();
      const isPrivate = targetEvent.message_type === 'private';
      const isTrustedGroup = !isPrivate && trustedGroupSet.has(String(targetEvent.group_id));
      const sceneTag = isPrivate
        ? '[场景：与主人私聊]'
        : isTrustedGroup
          ? '[场景：信任亲密小群]'
          : '[场景：群聊]';

      let emoBlock = '';
      if (config.emotion?.enabled !== false) {
        if (isPrivate) {
          const emoText = formatEmotionForPrompt();
          if (emoText) emoBlock = `\n${emoText}`;
        } else if (isTrustedGroup) {
          const moodText = formatMoodForPrompt({ inGroup: true, includeHint: true });
          if (moodText) emoBlock = `\n${moodText}`;
        } else if (config.emotion?.syncMoodToExternalGroups !== false) {
          const moodText = formatMoodForPrompt({ inGroup: true, maskReason: true, includeHint: false });
          if (moodText) emoBlock = `\n${moodText}`;
        }
      }

      const recent = getRecentMessages(chatKey, 6);
      const recentBlock = recent.length
        ? `\n【之前聊到这儿】\n${recent.map((m) => `${m.time} ${m.sender}: ${m.text}`).join('\n')}`
        : '';

      const todoInjectMax = Math.max(1, Number(config.todos?.injectMaxItems ?? 5));
      const todoLine =
        (isPrivate || isTrustedGroup) && config.todos?.enabled !== false
          ? formatTodosForPrompt(todoInjectMax)
          : '';
      const todoBlock = todoLine ? `\n${todoLine}` : '';
      const timeSlot = describeTimeOfDay();
      const sceneHint = isPrivate
        ? `你和主人已经好一会儿没说话了，现在是${timeSlot}空闲时间，你突然想主动私聊找他聊两句（可以问问他在干嘛、分享个小念头、或者顺着待办小纸条或之前聊过的事随口问一句）。自然一点，1~2句短话就行，别用“在吗”这种机械开场白。`
        : `群里安静好一会儿了，现在是${timeSlot}，你闲不住想主动冒个泡找大家唠嗑（可以随口抛个生活小脑洞、问问大家在干嘛、或者接着之前的话题逗逗大家）。自然简短，1~2句就行，别用“有人吗”这种气氛组话术。`;

      const prompt = `[当前时间: ${nowStr}] ${sceneTag}${emoBlock}${todoBlock}${recentBlock}\n（主动冒泡机会：${sceneHint}）`;
      log(`触发主动找你聊: ${chatKey}（已冷场 ${Math.floor(idleMs / 60000)} 分，命中率 ${Math.round(prob * 100)}%）`);

      let directSent = false;
      const toolContext = {
        chatKey,
        event: targetEvent,
        markDirectSent: (sentText) => {
          directSent = true;
          if (sentText) toolContext.directSentText = sentText;
        },
      };
      const reply = await llm.chat(chatKey, {
        text: prompt,
        persistText: `[${nowStr.slice(11, 16)}] （主动发起闲聊）`,
        toolContext,
      });

      if (reply && !directSent) {
        await sendReply(targetEvent, reply);
        if (!isPrivate) {
          lastGroupBotReplyAt.set(String(targetEvent.group_id), Date.now());
          lastGroupBotReplyText.set(String(targetEvent.group_id), reply.slice(0, 300));
        }
        log(`主动发言 ${chatKey}: ${reply.slice(0, 80)}`);
      } else if (directSent) {
        if (!isPrivate) {
          lastGroupBotReplyAt.set(String(targetEvent.group_id), Date.now());
          if (toolContext.directSentText) {
            lastGroupBotReplyText.set(String(targetEvent.group_id), String(toolContext.directSentText).slice(0, 300));
          }
        }
      } else {
        // 模型返回空且未通过工具发出：释放防连环锁，避免永久锁死
        proactiveSentAt.delete(chatKey);
        log(`主动冒泡返回为空 (${chatKey})，已自动释放锁等待下次机会`);
      }
    } catch (err) {
      proactiveSentAt.delete(chatKey);
      log(`主动冒泡发送失败 (${chatKey})，已自动释放锁:`, err?.message || err);
    }
  });
}

function startProactiveSchedulers() {
  if (!config.proactive?.enabled) {
    log('主动找你聊未启用（如需开启，请在 config.json 将 proactive.enabled 设为 true 并按需填写 proactive.groupIds）');
    return;
  }
  const targets = [];

  if (config.proactive.privateEnabled !== false && config.ownerId) {
    const key = `private:${config.ownerId}`;
    const restored = restoreLastActivityAt(key);
    lastActivityAt.set(key, restored);
    const idleMin = Math.floor((Date.now() - restored) / 60000);
    targets.push(`${key}(已静默${idleMin}分)`);
    scheduleProactiveCheck(key, {
      message_type: 'private',
      user_id: config.ownerId,
      self_id: config.snowluma.botId,
    });
  }

  for (const gid of config.proactive.groupIds || []) {
    const key = `group:${gid}`;
    const restored = restoreLastActivityAt(key);
    lastActivityAt.set(key, restored);
    const idleMin = Math.floor((Date.now() - restored) / 60000);
    targets.push(`${key}(已静默${idleMin}分)`);
    scheduleProactiveCheck(key, {
      message_type: 'group',
      group_id: gid,
      self_id: config.snowluma.botId,
    });
  }

  if (targets.length > 0) {
    const idleMin = Math.round(Number(config.proactive.idleThresholdMs ?? 2700000) / 60000);
    const minM = Math.round(Number(config.proactive.checkIntervalMinMs ?? 900000) / 60000);
    const maxM = Math.round(Number(config.proactive.checkIntervalMaxMs ?? 1500000) / 60000);
    const graceM = Math.round(Number(config.proactive.startupGraceMs ?? 600000) / 60000);
    const probPct = Math.round(Number(config.proactive.probability ?? 0.35) * 100);
    const resetH = Number(config.proactive.unansweredResetHours ?? 12);
    log(
      `已开启主动找你聊: ${targets.join(', ')}（冷场 ${idleMin}分 | 巡检 ${minM}~${maxM}分 | 启动保护 ${graceM}分 | 概率 ${probPct}%→85%递增 | 未回解锁 ${resetH}h | 免打扰 ${config.proactive.quietStartHour ?? 23}:00~${config.proactive.quietEndHour ?? 8}:00）`
    );
  } else {
    log('主动找你聊已开启，但未配置目标会话（请检查 privateEnabled 与 proactive.groupIds）');
  }
}

// ── 待办清单「单一精准预约」调度器（0 轮询、0 空转，全局最多 1 个 setTimeout） ──
const MAX_TODO_TIMER_HOP_MS = 24 * 60 * 60 * 1000;
let todoTimer = null;

function computeNextMorningMs() {
  const endHour = Number(config.proactive?.quietEndHour ?? 8);
  const d = new Date();
  if (d.getHours() >= endHour) d.setDate(d.getDate() + 1);
  d.setHours(endHour, 5, 0, 0);
  return d.getTime();
}

function scheduleNextTodoCheck(overrideWakeAtMs = 0) {
  if (todoTimer) {
    clearTimeout(todoTimer);
    todoTimer = null;
  }
  if (!config.ownerId || config.todos?.enabled === false) return;

  const now = Date.now();
  const { dueItems, staleItems, nextWakeAtMs } = inspectTodoSchedule(now);
  let targetAtMs = overrideWakeAtMs;

  if (!targetAtMs) {
    if (dueItems.length > 0) {
      targetAtMs = now + 1500;
    } else if (staleItems.length > 0) {
      targetAtMs = isQuietHour() ? computeNextMorningMs() : now + 2000;
    } else if (nextWakeAtMs > 0) {
      targetAtMs = nextWakeAtMs;
    }
  }

  if (!targetAtMs) return; // 无待办闹钟：0 定时器，CPU 占用 0%
  const delay = Math.max(1000, Math.min(MAX_TODO_TIMER_HOP_MS, targetAtMs - now));
  todoTimer = setTimeout(() => {
    todoTimer = null;
    runTodoAlarmCheck().catch((err) => log('待办调度异常:', err?.message || err));
  }, delay);
}

async function runTodoAlarmCheck() {
  if (!config.ownerId) return;
  if (!wsConnected) {
    // WS 尚未连通时延后 30s 重试，不丢失到期提醒
    scheduleNextTodoCheck(Date.now() + 30000);
    return;
  }

  const now = Date.now();
  const { dueItems, staleItems } = inspectTodoSchedule(now);
  const ownerKey = `private:${config.ownerId}`;
  const pseudoEvent = {
    message_type: 'private',
    user_id: Number(config.ownerId),
    self_id: config.snowluma.botId,
  };

  // 1. 到点的定时提醒：立即私聊自然提醒，发完自动从待办数组删除
  if (dueItems.length > 0) {
    const dueIds = dueItems.map((it) => it.id);
    removeTodosByIds(dueIds);
    const listText = dueItems.map((it) => `- #${it.id} ${it.content}${it.dueAt ? `（预定 ${it.dueAt}）` : ''}`).join('\n');
    log(`触发定时待办提醒 (${dueItems.length} 条): ${dueItems.map((i) => i.content).join(' / ')}`);

    enqueue(ownerKey, async () => {
      try {
        const nowStr = formatNow();
        const prompt =
          `[当前时间: ${nowStr}] [场景：与主人私聊]\n${formatEmotionForPrompt()}\n` +
          `【定时待办到点提醒（系统已自动划掉这几条）】\n${listText}\n` +
          '（提示：现在到时间啦，用你平时自然的口语私聊提醒主人一句就行，简短自然别像闹钟播报）';
        let directSent = false;
        const reply = await llm.chat(ownerKey, {
          text: prompt,
          persistText: `[${nowStr.slice(11, 16)}] （到点提醒待办：${dueItems.map((i) => i.content).join('、')}）`,
          toolContext: { chatKey: ownerKey, event: pseudoEvent, markDirectSent: () => { directSent = true; } },
        });
        if (reply && !directSent) {
          await sendReply(pseudoEvent, reply);
          log(`已发出定时待办提醒: ${reply.slice(0, 80)}`);
        }
      } catch (err) {
        log('发送定时待办提醒失败:', err?.message || err);
      }
    });
  }

  // 2. 超过 7 天的普通待办：避开夜间免打扰，温柔随口问一次“还要不要做”，等主人确认后再由 chat_todo done 删掉
  if (staleItems.length > 0) {
    if (isQuietHour()) {
      scheduleNextTodoCheck(computeNextMorningMs());
      return;
    }
    const batch = staleItems.slice(0, 3);
    markTodosStaleAsked(batch.map((it) => it.id), now);
    const listText = batch.map((it) => `- #${it.id} ${it.content}（记于 ${it.createdAt}）`).join('\n');
    log(`触发 7 天陈旧待办温柔确认 (${batch.length} 条)`);

    enqueue(ownerKey, async () => {
      try {
        const nowStr = formatNow();
        const prompt =
          `[当前时间: ${nowStr}] [场景：与主人私聊]\n${formatEmotionForPrompt()}\n` +
          `【以下待办已经放了超过 7 天还没划掉，不要擅自删，先随口问主人一句】\n${listText}\n` +
          '（提示：轻松随口问一句主人这些事还要不要做、或者是不是已经搞定了，等他确认不做后再调 chat_todo done 删掉；简短自然 1~2 句就行）';
        let directSent = false;
        const reply = await llm.chat(ownerKey, {
          text: prompt,
          persistText: `[${nowStr.slice(11, 16)}] （随口确认超过7天的待办：${batch.map((i) => i.content).join('、')}）`,
          toolContext: { chatKey: ownerKey, event: pseudoEvent, markDirectSent: () => { directSent = true; } },
        });
        if (reply && !directSent) {
          await sendReply(pseudoEvent, reply);
          log(`已发出 7 天待办确认: ${reply.slice(0, 80)}`);
        }
      } catch (err) {
        log('发送 7 天待办确认失败:', err?.message || err);
      }
    });
  }

  scheduleNextTodoCheck();
}

// ── 消息与拍一拍处理 ─────────────────────────────────────────────────────────
async function handlePoke(event) {
  const selfId = String(event.self_id || config.snowluma.botId || '');
  if (String(event.target_id) !== selfId) return;
  if (String(event.user_id) === selfId) return;

  const isGroup = Boolean(event.group_id);
  const type = isGroup ? 'group' : 'private';
  const targetId = isGroup ? event.group_id : event.user_id;
  if (!isAllowedTarget(type, targetId)) return;

  const chatKey = isGroup ? `group:${event.group_id}` : `private:${event.user_id}`;
  touchActivity(chatKey);
  if (isGroup && String(event.user_id) === String(config.ownerId || '')) {
    nonOwnerStreak.set(String(event.group_id), 0);
  }

  const pseudoEvent = {
    message_type: type,
    user_id: event.user_id,
    group_id: event.group_id,
    self_id: event.self_id,
  };

  log(`收到拍一拍 ${chatKey} from ID:${event.user_id}`);
  const wakeCheck = safetyGuard.checkAndRecordWake(chatKey, isGroup ? 'group_mention' : 'private');
  if (!wakeCheck.ok) {
    log(`[safety] 跳过拍一拍回复 (${chatKey}): ${wakeCheck.error}`);
    return;
  }
  enqueue(chatKey, async () => {
    try {
      let directSent = false;
      const nowStr = formatNow();
      const poker = resolveSpeakerIdentity(event.user_id, `ID:${event.user_id}`, config, getPersona().name);
      const sceneTag = formatSceneTag(pseudoEvent, config, poker);
      const prompt = `[当前时间: ${nowStr}] ${sceneTag}\n（系统事件：[${poker.label}(${event.user_id})] 拍了拍你。你可以自然回一句话，或者顺手调用 chat_send_poke 拍回去！）`;
      const reply = await llm.chat(chatKey, {
        text: prompt,
        persistText: `[${nowStr.slice(11, 16)}] [${poker.label}] 拍了拍你`,
        toolContext: { chatKey, event: pseudoEvent, markDirectSent: () => { directSent = true; } },
      });
      if (reply && !directSent) {
        await sendReply(pseudoEvent, reply);
        log(`回复拍一拍 ${chatKey}: ${reply.slice(0, 60)}`);
      }
    } catch (err) {
      log(`处理拍一拍失败 (${chatKey}):`, err?.message || err);
    }
  });
}

async function handleMessage(event) {
  // 监听 OneBot 心跳/生命周期事件：捕获 离线->重新上线切换，自动重新触发记忆库同步门控
  if (event.post_type === 'meta_event') {
    if (event.meta_event_type === 'heartbeat' && event.status) {
      if (event.status.online === false && clientOnline) {
        clientOnline = false;
        log('检测到 Chat 客户端离线，待重新登录后将自动同步离线记忆库');
      } else if (event.status.online === true && !clientOnline && !syncRunning) {
        triggerOnlineSyncGate('heartbeat_online');
      }
    }
    return;
  }
  if (event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke') {
    return handlePoke(event);
  }
  if (event.post_type !== 'message') return;
  if (String(event.user_id) === String(event.self_id || config.snowluma.botId)) return;

  const targetId = event.message_type === 'group' ? event.group_id : event.user_id;
  if (!isAllowedTarget(event.message_type, targetId)) {
    if (event.message_type === 'group') {
      log(`收到未放行群消息 group:${event.group_id}（请把群号加入 config.json 的 allow.groups）`);
    }
    return;
  }

  const parsedIncoming = parseMessage(event);
  let { text, imageUrls } = parsedIncoming;
  const { forwardIds, mentionedUserIds, replyId, isAtMe } = parsedIncoming;
  // 纯 @ 机器人或「引用消息/聊天记录 + @ 机器人」（无额外正文）必须放行，不能当空消息静默丢弃
  if (!text && imageUrls.length === 0 && !isAtMe && !replyId && forwardIds.length === 0) return;

  const fallbackRecordText =
    imageUrls.length > 0
      ? '[图片]'
      : isAtMe && replyId
        ? '[引用消息并@了你]'
        : isAtMe
          ? '[@了你]'
          : '[引用消息]';

  // 触发判定使用原始发言文本（避免转发的旧聊天记录里出现角色名导致无关外群误触发）
  const rawTextForTrigger = text;
  let recentRecordText = text;
  if (forwardIds.length > 0) {
    const expanded = await expandForwardsInMessage(forwardIds, text, imageUrls);
    if (expanded.expandedCount > 0) {
      text = expanded.text;
      recentRecordText = expanded.compactText;
      imageUrls = expanded.imageUrls;
    }
  }

  const chatKey =
    event.message_type === 'private'
      ? `private:${event.user_id}`
      : `group:${event.group_id}`;
  const incomingSeqAtReceive = (chatIncomingSeq.get(chatKey) || 0) + 1;
  chatIncomingSeq.set(chatKey, incomingSeqAtReceive);
  const senderName = event.sender?.card || event.sender?.nickname || String(event.user_id);
  const impScope = resolveImpressionScope(event, {
    ownerId: config.ownerId,
    trustedGroups: config.memoryPrivacy?.trustedGroups || [],
    privateMemoryGroups: config.memoryPrivacy?.privateMemoryGroups || [],
  });
  const dynRel = config.impressions?.enabled !== false ? getDynamicSpeakerRelation(event.user_id, impScope.readScopes) : '';
  const speaker = resolveSpeakerIdentity(event.user_id, senderName, config, getPersona().name, {
    dynamicRelation: dynRel,
  });

  if (imageUrls.length > 0) {
    cacheMessageImages(chatKey, event.message_id, imageUrls);
  }

  touchActivity(chatKey);
  // 被动更新人物互动次数与曾用名（0 API 消耗，严格按分区隔离）
  try {
    touchUserInteraction({
      userId: event.user_id,
      nickname: senderName,
      scopeKey: impScope.writeScope,
    });
  } catch (err) {
    log('更新人物互动计数失败:', err?.message || err);
  }

  // 先记入最近消息缓存 + 写入本地 SQLite 记忆库（哪怕这句没触发机器人，以后 chat_recall 也能翻到）
  recordRecentMessage(chatKey, {
    message_id: String(event.message_id || ''),
    time: formatNow().slice(11, 16),
    user_id: String(event.user_id),
    sender: speaker.label,
    text: recentRecordText || fallbackRecordText,
  });

  let triggerReason = 'private';
  let matchedTopics = [];
  let skipReason = '';
  let directDetail = '';
  let allowSkipTurn = false;
  let quotedMessage;
  if (event.message_type === 'group') {
    const triggerRes = checkGroupTrigger(
      event.group_id,
      event.user_id,
      rawTextForTrigger,
      isAtMe,
      replyId,
      imageUrls.length > 0,
      speaker,
      chatKey,
      mentionedUserIds
    );
    triggerReason = triggerRes?.reason || null;
    matchedTopics = triggerRes?.matchedTopics || [];
    skipReason = triggerRes?.skipReason || '';
    directDetail = triggerRes?.directDetail || '';
    // 兜底：若群友引用的是机器人重启前发的旧消息（不在内存 myMessageIds 中），通过 get_msg 识别并唤醒（同样严格受连聊上限与队列积压约束）
    if (!triggerReason && replyId && config.groupTrigger?.replyToMe !== false) {
      const gKey = String(event.group_id);
      const selfId = String(event.self_id || config.snowluma.botId || '');
      const isOwnerSender = Boolean(config.ownerId) && String(event.user_id) === String(config.ownerId);
      const maxStreak = Number(config.groupTrigger?.maxConsecutiveWithoutOwner ?? 2);
      const streak = nonOwnerStreak.get(gKey) || 0;
      const busy = (activeGroupReplyCount.get(gKey) || 0) > 0;
      if (isOwnerSender || (streak < maxStreak && !busy)) {
        quotedMessage = await resolveQuotedMessage(chatKey, replyId);
        if (quotedMessage && selfId && quotedMessage.userId === selfId) {
          triggerReason = 'reply';
          skipReason = '';
          if (!isOwnerSender) {
            nonOwnerStreak.set(gKey, streak + 1);
            lastNonOwnerTriggerAt.set(gKey, Date.now());
          }
        }
      }
    }

    // 第二层：刚回完话的续聊窗口内若第一层回声/概率未命中，自动走语义裁判（HTTP 极速判 YES/NO，无 HTTP 时退回主模型 [SKIP]）
    if (!triggerReason && triggerRes?.eligibleForSemanticJudge) {
      const gKey = String(event.group_id);
      const sjCooldown = Number(config.groupTrigger?.semanticJudge?.cooldownMs ?? 4000);
      const nowMs = Date.now();
      const lastJudge = lastSemanticJudgeAt.get(gKey) || 0;
      if (nowMs - lastJudge >= sjCooldown) {
        lastSemanticJudgeAt.set(gKey, nowMs);
        const isOwnerSender = Boolean(config.ownerId) && String(event.user_id) === String(config.ownerId);
        if (semanticJudge.mode === 'http') {
          try {
            const verdict = await runHttpSemanticJudge(chatKey, speaker.label, rawTextForTrigger);
            if (verdict === true) {
              triggerReason = 'followup_semantic';
              skipReason = '';
              if (isOwnerSender) {
                lastOwnerRandomReplyAt.set(gKey, nowMs);
              } else {
                lastRandomReplyAt.set(gKey, nowMs);
                nonOwnerStreak.set(gKey, (nonOwnerStreak.get(gKey) || 0) + 1);
              }
            } else if (verdict === false) {
              skipReason = '语义裁判判定无关(NO)';
            }
          } catch (err) {
            log(`语义裁判异常 (${chatKey}):`, err?.message || err);
          }
        } else if (semanticJudge.mode === 'skip') {
          triggerReason = 'followup_skip_check';
          skipReason = '';
          allowSkipTurn = true;
        }
      }
    }
  }

  if (!/^(\/reset|\/清空|重置记忆)$/i.test(text)) {
    saveChatMessageToDb({
      scope: event.message_type === 'group' ? 'group' : 'private',
      groupId: event.message_type === 'group' ? event.group_id : null,
      messageId: event.message_id,
      who: event.user_id,
      whoName: senderName,
      isSelf: false,
      isOwner: String(event.user_id) === String(config.ownerId || ''),
      isTriggered: Boolean(triggerReason),
      text: text || fallbackRecordText,
      ts: event.time ? Number(event.time) : Date.now() / 1000,
    }).then((r) => {
      if (r && !r.ok && !r.skipped) log('写入记忆库失败(收):', r.error || r);
    });
  }

  // 第 2 层：旁听所有群消息（含未触发回复的水聊），0 成本跨发言者重复词捕捉并后台验真入库
  if (
    event.message_type === 'group' &&
    rawTextForTrigger &&
    config.slang?.enabled !== false &&
    config.slang?.repeatDetect !== false &&
    config.tools?.webSearch !== false
  ) {
    const repeatScope = resolveSlangScope(event, {
      ownerId: config.ownerId,
      trustedGroups: config.memoryPrivacy?.trustedGroups || [],
      privateMemoryGroups: config.memoryPrivacy?.privateMemoryGroups || [],
    });
    const p = getPersona();
    observeAndSniffGroupRepeat({
      chatKey,
      userId: event.user_id,
      text: rawTextForTrigger,
      readScopes: repeatScope.readScopes,
      botKeywords: [p.name, ...(p.keywords || []), ...(config.groupTrigger?.keywords || [])],
      windowMs: config.slang?.repeatWindowMs ?? 2700000,
      minSpeakers: config.slang?.repeatMinSpeakers ?? 2,
      missCacheHours: config.slang?.missCacheHours ?? 24,
      searchFn: freeWebSearch,
      timeoutMs: config.slang?.sniffTimeoutMs ?? 3500,
      log,
    });
  }

  if (event.message_type === 'group' && !triggerReason) {
    if (config.groupTrigger?.logSkipped !== false) {
      const preview = (recentRecordText || fallbackRecordText || '').replace(/\s+/g, ' ').slice(0, 50);
      log(`已入库 ${chatKey} (${senderName}, 未触发: ${skipReason || '未命中规则'}): ${preview}`);
    }
    return;
  }

  // 只有真正触发了实时回复时，才标记实时活跃与同步游标，避免群友未触发的普通水聊误杀离线补回
  liveMessageAt.set(chatKey, Date.now());
  markSyncHandled(chatKey, event.message_id, event.time ? Number(event.time) : Date.now() / 1000);

  // 重置记忆指令（只清短期对话上下文，保留长期小本本记忆与历史库）
  if (/^(\/reset|\/清空|重置记忆)$/i.test(text)) {
    llm.resetSession(chatKey);
    await sendReply(event, '好嘞，刚才的短期对话上下文已经清空啦，长期小本本和历史记录都还保留着哦！');
    log(`已重置会话记忆: ${chatKey}`);
    return;
  }

  const wakeCategory =
    event.message_type === 'private'
      ? 'private'
      : ['at', 'reply', 'name', 'keyword'].includes(triggerReason)
        ? 'group_mention'
        : 'group_auto';
  const wakeCheck = safetyGuard.checkAndRecordWake(chatKey, wakeCategory);
  if (!wakeCheck.ok) {
    log(`[safety] 跳过本次唤醒 (${chatKey}, reason=${triggerReason}): ${wakeCheck.error}`);
    return;
  }

  const activeGroupKey = event.message_type === 'group' ? String(event.group_id) : '';
  if (activeGroupKey) {
    activeGroupReplyCount.set(activeGroupKey, (activeGroupReplyCount.get(activeGroupKey) || 0) + 1);
  }

  enqueue(chatKey, async () => {
    try {
      const nowStr = formatNow();
      const sceneTag = formatSceneTag(event, config, speaker);
      let contextPrefix = `[当前时间: ${nowStr}] ${sceneTag}`;

      // 主人私聊时：记录每日被动陪伴好感并注入当前好感/心情状态（绝不泄露给外部群聊）
      const isOwnerPrivate =
        event.message_type === 'private' &&
        config.ownerId &&
        String(event.user_id) === String(config.ownerId);
      const isTrustedGroup =
        event.message_type === 'group' && trustedGroupSet.has(String(event.group_id));
      if (isOwnerPrivate && config.emotion?.enabled !== false) {
        recordDailyPassiveInteraction();
        const emoBlock = formatEmotionForPrompt();
        if (emoBlock) contextPrefix += `\n${emoBlock}`;
      } else if (isTrustedGroup && config.emotion?.enabled !== false) {
        const moodBlock = formatMoodForPrompt({ inGroup: true, includeHint: true });
        if (moodBlock) contextPrefix += `\n${moodBlock}`;
      } else if (
        event.message_type === 'group' &&
        config.emotion?.enabled !== false &&
        config.emotion?.syncMoodToExternalGroups !== false
      ) {
        const extMoodBlock = formatMoodForPrompt({ inGroup: true, maskReason: true, includeHint: false });
        if (extMoodBlock) contextPrefix += `\n${extMoodBlock}`;
      }
      if ((isOwnerPrivate || isTrustedGroup) && config.todos?.enabled !== false) {
        const todoLine = formatTodosForPrompt(Math.max(1, Number(config.todos?.injectMaxItems ?? 5)));
        if (todoLine) contextPrefix += `\n${todoLine}`;
      }

      const presentIds = [event.user_id];
      if (event.message_type === 'group') {
        const recent = getRecentMessages(chatKey, 10).slice(0, -1);
        for (const m of recent) presentIds.push(m.user_id);
        if (recent.length > 0) {
          const historyLines = recent
            .map((m) => `[msg_id=${m.message_id}] ${m.time} [${m.sender}(${m.user_id})]: ${m.text}`)
            .join('\n');
          contextPrefix += `\n【群里刚才的聊天记录（供了解上下文）】\n${historyLines}`;
        }
        if (triggerReason === 'random') {
          contextPrefix += '\n（提示：没人特意叫你，你是路过觉得好玩顺嘴插一句，简短自然即可）';
        } else if (triggerReason === 'followup_echo') {
          contextPrefix += `\n（提示：对方紧接着提到了你刚才说的「${directDetail || '原话'}」，是在回应你，顺着话茬自然接一句即可）`;
        } else if (triggerReason === 'followup_direct' || triggerReason === 'followup_semantic' || triggerReason === 'followup') {
          contextPrefix += '\n（提示：你刚才正在群里聊着天，对方紧接着在跟你搭话，顺着刚才的话茬自然接一句即可，简短自然）';
        } else if (triggerReason === 'followup_skip_check') {
          contextPrefix +=
            '\n（判定提示：对方没 @ 你也没喊你名字，只是在你刚说完话后紧接着发了新消息。如果这句话明显是在跟你搭话或需要你接一句，请直接自然回复；如果明显是在跟别人聊天、和你无关或没必要插嘴，请只输出 [SKIP]，不要说任何其他内容。）';
        } else if (triggerReason === 'topic' || triggerReason === 'owner_topic') {
          const topicStr = matchedTopics.slice(0, 3).join('、');
          contextPrefix += `\n（提示：群里正好聊到你很感兴趣的话题${topicStr ? `「${topicStr}」` : ''}，顺嘴凑过去插一句，简短自然即可）`;
        } else if (triggerReason === 'owner_random' || triggerReason === 'owner_followup') {
          contextPrefix += '\n（提示：管理员在群里说话了，你自然地搭一句茬或接上话，简短自然即可）';
        }
      }
      const knownNote = formatKnownUsersNote(config, presentIds, text);
      if (knownNote) {
        contextPrefix += `\n${knownNote}`;
      }

      // 跨聊近期关键词 0ms 联想（严格遵循隐私边界：主人私聊 <-> 亲密/熟人互通群，外部普通群 0 透传）
      const isPrivateMemoryGroup =
        event.message_type === 'group' && !isTrustedGroup && privateMemoryGroupSet.has(String(event.group_id));
      let crossChatKeys = [];
      if (isOwnerPrivate) {
        crossChatKeys = [
          ...new Set([
            ...(config.memoryPrivacy?.trustedGroups || []),
            ...(config.memoryPrivacy?.privateMemoryGroups || []),
          ]),
        ].map((g) => `group:${g}`);
      } else if ((isTrustedGroup || isPrivateMemoryGroup) && config.ownerId) {
        crossChatKeys = [`private:${config.ownerId}`];
      }
      if (crossChatKeys.length > 0 && text) {
        const crossHits = findCrossChatRecentMatches(crossChatKeys, text, { maxHits: 2, maxChars: 180 });
        if (crossHits.length > 0) {
          const crossLabel = isPrivateMemoryGroup
            ? '跨聊近期相关参考（来自主人私聊，仅供心里有数，严禁在群里泄露隐私）'
            : '跨聊近期相关记忆';
          contextPrefix += `\n[${crossLabel}：${crossHits.join(' | ')}]`;
        }
      }

      // 自动展开被引用消息的原话（以及引用消息里附带的图片）
      if (replyId && quotedMessage === undefined) {
        quotedMessage = await resolveQuotedMessage(chatKey, replyId);
      }

      // 1ms 精准捞取当前相关人物的极简印象行（大群 O(1) 硬封顶最多 1~2 人，且不落盘进 context.db 防漂移）
      if (config.impressions?.enabled !== false) {
        const impLine = findRelevantImpressions({
          speakerId: event.user_id,
          quotedUserId: quotedMessage?.userId || '',
          mentionedUserIds,
          botId: config.snowluma?.botId || '',
          text,
          readScopes: impScope.readScopes,
          maxUsers: config.impressions?.injectMaxUsers ?? 2,
          maxCharsPerUser: config.impressions?.maxCharsPerUser ?? 60,
        });
        if (impLine) {
          contextPrefix += `\n${impLine}`;
        }
      }

      // 0.1ms 本地梗库扫描 + 跳戏短语自动联网嗅梗入库（仅当轮注入，不落盘进 context.db）
      let slangScope = null;
      let slangHits = [];
      if (config.slang?.enabled !== false && rawTextForTrigger) {
        slangScope = resolveSlangScope(event, {
          ownerId: config.ownerId,
          trustedGroups: config.memoryPrivacy?.trustedGroups || [],
          privateMemoryGroups: config.memoryPrivacy?.privateMemoryGroups || [],
        });
        slangHits = findMatchingSlang(rawTextForTrigger, slangScope.readScopes, {
          maxHits: config.slang?.injectMaxHits ?? 3,
        });
        if (
          slangHits.length === 0 &&
          config.slang?.autoSniff !== false &&
          config.tools?.webSearch !== false
        ) {
          const recentForSniff = getRecentMessages(chatKey, 6).slice(0, -1);
          const p = getPersona();
          const botKeywords = [
            p.name,
            ...(p.keywords || []),
            ...(config.groupTrigger?.keywords || []),
          ];
          const candidate = extractAbruptSlangCandidate(rawTextForTrigger, recentForSniff, {
            botKeywords,
            missCacheHours: config.slang?.missCacheHours ?? 24,
          });
          if (candidate) {
            const learned = await sniffAndLearnSlang({
              candidate,
              searchFn: freeWebSearch,
              timeoutMs: config.slang?.sniffTimeoutMs ?? 3500,
              log,
            });
            if (learned) slangHits = [learned];
          }
        }
        const slangBlock = formatSlangForPrompt(slangHits);
        if (slangBlock) {
          contextPrefix += `\n${slangBlock}`;
        }
      }

      let replyHint = '';
      if (replyId) {
        if (quotedMessage && quotedMessage.text) {
          const extraImgNote = quotedMessage.imageUrls?.length > 0 && quotedMessage.text !== '[图片]' ? '（含图片）' : '';
          if (quotedMessage.isForward || quotedMessage.text.startsWith('[合并转发')) {
            const maxFwdChars = Math.max(1600, Number(config.forward?.maxExpandChars ?? 5000));
            replyHint = ` [引用了 ${quotedMessage.sender} 的合并转发(id=${replyId})${extraImgNote}：\n${quotedMessage.text.slice(0, maxFwdChars)}\n]`;
          } else {
            const snippet = quotedMessage.text.replace(/\s+/g, ' ').slice(0, 220);
            replyHint = ` [引用了 ${quotedMessage.sender} 的消息(id=${replyId}): 「${snippet}」${extraImgNote}]`;
          }
        } else {
          replyHint = ` [引用了消息 id=${replyId}]`;
        }
      }
      const fallbackPromptText =
        imageUrls.length > 0
          ? '（发了一张图片）'
          : isAtMe && replyId
            ? '（引用上述消息并 @ 了你，请你看看）'
            : isAtMe
              ? '（单独 @ 了你一下）'
              : '（引用了上述消息）';
      const currentLine =
        event.message_type === 'group'
          ? `[当前消息 msg_id=${event.message_id || ''}][${speaker.label}(${event.user_id})]${replyHint} ${text || fallbackPromptText}`
          : `[当前消息 msg_id=${event.message_id || ''}][${speaker.label}]${replyHint} ${text || fallbackPromptText}`;

      const promptText = `${contextPrefix}\n${currentLine}`;

      const triggerTag = directDetail ? `${triggerReason}:${directDetail}` : triggerReason;
      log(`收到 ${chatKey} (${senderName}, ${triggerTag}): ${text || fallbackRecordText}`);

      // 下载当前消息里的图片；若引用了含图消息且未超 3 张上限，一并下载供模型查看
      const images = [];
      const ownImages = [];
      const maxBytes = config.maxImageBytes || 5242880;
      for (const url of imageUrls.slice(0, 3)) {
        const img = await downloadImage(url, maxBytes);
        if (img) {
          images.push(img);
          ownImages.push(img);
        }
      }
      if (quotedMessage?.imageUrls?.length && images.length < 3) {
        for (const qUrl of quotedMessage.imageUrls) {
          if (images.length >= 3) break;
          if (imageUrls.includes(qUrl)) continue;
          const img = await downloadImage(qUrl, maxBytes);
          if (img) images.push(img);
        }
      }

      // 将本轮触发收到的原图按 message_id 归档至 state/media/（同步落盘防链接过期）
      if (ownImages.length > 0 && event.message_id && config.mediaArchive?.enabled !== false) {
        try {
          archiveImagesForMessage({
            messageId: String(event.message_id),
            images: ownImages,
            scope: event.message_type === 'group' ? 'group' : 'private',
            groupId: event.message_type === 'group' ? event.group_id : null,
            userId: event.user_id,
            maxFiles: config.mediaArchive?.maxFiles ?? 300,
            maxTotalMB: config.mediaArchive?.maxTotalMB ?? 200,
          });
        } catch (err) {
          log('归档图片失败:', err?.message || err);
        }
      }

      let directSent = false;
      const toolContext = {
        chatKey,
        event,
        markDirectSent: (sentText) => {
          directSent = true;
          if (sentText) toolContext.directSentText = sentText;
        },
      };
      // 发送给模型当轮使用带实时状态/群背景的完整 promptText；
      // 落盘至 state/context.db 时只保留去噪后的本轮发言（防过期心情和重复群记录滚雪球污染上下文；全量消息仍完整保存在 state/memory.db 供 chat_recall 随时检索）
      const persistLine = `[${nowStr.slice(11, 16)}] ${currentLine}`;
      const clicheCfg = config.reply?.clicheFilter || {};
      const maxClicheRerolls =
        clicheCfg.enabled === false ? 0 : Math.max(0, Math.min(2, Number(clicheCfg.maxRerolls ?? 1)));
      const useDeferredSave = maxClicheRerolls > 0 && typeof llm.commitTurn === 'function';
      let reply = await llm.chat(chatKey, {
        text: promptText,
        persistText: persistLine,
        images,
        toolContext,
        allowSkip: allowSkipTurn,
        noSave: useDeferredSave,
      });

      if (allowSkipTurn && toolContext.skipped && !directSent) {
        if (config.groupTrigger?.logSkipped !== false) {
          const preview = (recentRecordText || fallbackRecordText || '').replace(/\s+/g, ' ').slice(0, 50);
          log(`已入库 ${chatKey} (${senderName}, 主模型判断无关 [SKIP]): ${preview}`);
        }
        return;
      }

      if (useDeferredSave) {
        if (reply && !directSent) {
          for (let attempt = 0; attempt < maxClicheRerolls; attempt++) {
            const clicheHit = detectReplyCliche(reply, rawTextForTrigger, clicheCfg);
            if (!clicheHit) break;
            log(
              `[cliche-filter] 命中「${clicheHit}」(${chatKey})，静默重 Roll 第 ${attempt + 1}/${maxClicheRerolls} 次防污染记忆...`
            );
            const rerollPrompt =
              activeLlm.protocol === 'agy-cli'
                ? `（风格纠偏：上一版回复命中了「${clicheHit}」，不要发那一版；请直接换一句简短、自然、接地气的人设口语重新回复刚才那条消息，严禁科普出处或分点说教）`
                : `${promptText}\n（风格纠偏：切勿输出「${clicheHit}」这类百科科普/客服八股腔，请直接用简短自然、接地气的人设口语回复）`;
            try {
              const rerolled = await llm.chat(chatKey, {
                text: rerollPrompt,
                persistText: persistLine,
                images: activeLlm.protocol === 'agy-cli' ? [] : images,
                toolContext,
                allowSkip: false,
                noSave: true,
              });
              if (rerolled && rerolled.trim()) {
                reply = rerolled;
              } else {
                break;
              }
            } catch (rerollErr) {
              log(`[cliche-filter] 重 Roll 失败，回退原回复 (${chatKey}):`, rerollErr?.message || rerollErr);
              break;
            }
          }
        }
        llm.commitTurn(chatKey, persistLine, images, reply, toolContext);
      }

      if (allowSkipTurn && event.message_type === 'group') {
        const gKey = String(event.group_id);
        const isOwnerSender = Boolean(config.ownerId) && String(event.user_id) === String(config.ownerId);
        if (isOwnerSender) {
          lastOwnerRandomReplyAt.set(gKey, Date.now());
        } else {
          lastRandomReplyAt.set(gKey, Date.now());
          nonOwnerStreak.set(gKey, (nonOwnerStreak.get(gKey) || 0) + 1);
        }
      }

      if (reply && !directSent) {
        const inlineDirective = extractInlineReplyDirective(reply);
        const cleanReplyText = inlineDirective.text;
        if (cleanReplyText) {
          const groupJumped =
            event.message_type === 'group' &&
            config.reply?.autoQuoteOnGroupJump !== false &&
            event.message_id != null &&
            (chatIncomingSeq.get(chatKey) || 0) > incomingSeqAtReceive;
          const targetReplyId =
            inlineDirective.replyToMessageId || (groupJumped ? String(event.message_id) : '');
          await sendReply(event, cleanReplyText, { replyToMessageId: targetReplyId });
          if (event.message_type === 'group') {
            lastGroupBotReplyAt.set(String(event.group_id), Date.now());
            lastGroupBotReplyText.set(String(event.group_id), cleanReplyText.slice(0, 300));
          }
          const quoteTag = targetReplyId ? ` [引用:${targetReplyId}]` : '';
          log(`回复 ${chatKey}${quoteTag}: ${cleanReplyText.slice(0, 80)}${cleanReplyText.length > 80 ? '...' : ''}`);
        }
      } else if (directSent && event.message_type === 'group') {
        lastGroupBotReplyAt.set(String(event.group_id), Date.now());
        if (toolContext.directSentText) {
          lastGroupBotReplyText.set(String(event.group_id), String(toolContext.directSentText).slice(0, 300));
        }
      }

      // 第 3 层：主回复发出后后台异步轻量偷学（默认关闭，config.json -> slang.asyncLlmLearn=true 按需开启，0ms 延迟）
      if (
        config.slang?.enabled !== false &&
        config.slang?.asyncLlmLearn === true &&
        rawTextForTrigger
      ) {
        const quickClient =
          semanticJudge?.mode === 'http' && semanticJudge.client
            ? semanticJudge.client
            : llm?.supportsQuickJudge && typeof llm.quickText === 'function'
              ? llm
              : null;
        if (quickClient) {
          const scopeForAsync =
            slangScope ||
            resolveSlangScope(event, {
              ownerId: config.ownerId,
              trustedGroups: config.memoryPrivacy?.trustedGroups || [],
              privateMemoryGroups: config.memoryPrivacy?.privateMemoryGroups || [],
            });
          const recentForAsync = getRecentMessages(chatKey, 4).slice(0, -1);
          asyncLearnSlangWithLlm({
            chatKey,
            rawText: rawTextForTrigger,
            recentMessages: recentForAsync,
            existingHits: slangHits,
            slangScope: scopeForAsync,
            quickClient,
            preferredModel: semanticJudge?.model || '',
            searchFn: config.tools?.webSearch !== false ? freeWebSearch : null,
            timeoutMs: config.slang?.sniffTimeoutMs ?? 3500,
            cooldownMs: config.slang?.asyncLlmCooldownMs ?? 30000,
            log,
          }).catch(() => {});
        }
      }

      // 主回复发出后再异步补写图片图注进 state/memory.db（避免与主回复抢并发额度，优先使用 mediaArchive.captionModel 或刚成功的模型）
      if (
        ownImages.length > 0 &&
        event.message_id &&
        config.mediaArchive?.enabled !== false &&
        config.mediaArchive?.autoCaption !== false &&
        typeof llm.captionImages === 'function'
      ) {
        const msgScope = event.message_type === 'group' ? 'group' : 'private';
        const msgIdStr = String(event.message_id);
        const origText = text;
        const capModel = String(config.mediaArchive?.captionModel || '').trim();
        llm
          .captionImages(ownImages, capModel)
          .then(async (caption) => {
            if (!caption) {
              log(`图片图注未生成(msg_id=${msgIdStr})，请检查模型配额或配置 mediaArchive.captionModel`);
              return;
            }
            const enriched = origText ? `${origText} [图片：${caption}]` : `[图片：${caption}]`;
            const upd = await updateChatMessageTextInDb({ scope: msgScope, messageId: msgIdStr, text: enriched });
            if (upd?.ok) log(`已自动补写图片图注(msg_id=${msgIdStr}): ${caption}`);
            else log(`补写图片图注落盘失败(msg_id=${msgIdStr}):`, upd?.error || upd);
          })
          .catch((err) => log(`自动补写图片图注异常(msg_id=${msgIdStr}):`, err?.message || err));
      }
    } catch (err) {
      log(`处理消息失败 (${chatKey}):`, err?.message || err);
    } finally {
      if (activeGroupKey) {
        const left = (activeGroupReplyCount.get(activeGroupKey) || 1) - 1;
        if (left <= 0) activeGroupReplyCount.delete(activeGroupKey);
        else activeGroupReplyCount.set(activeGroupKey, left);
      }
    }
  });
}

// ── 上线确定性记忆库同步门控（返回 status: "success" 后再触发离线未读补回） ──
let clientOnline = false;
let syncRunning = false;
const liveMessageAt = new Map();

async function handleOfflineUnreadTarget(target, syncStartedAt) {
  // 若同步期间该会话已经触发了实时对话，说明已经在实时聊了，取消旧离线补回避免撞车
  if ((liveMessageAt.get(target.chatKey) || 0) >= syncStartedAt) {
    log(`跳过离线补回 ${target.chatKey}（同步期间已触发实时对话）`);
    markSyncHandled(target.chatKey, target.latestMsgId, target.latestTs);
    return;
  }

  const pseudoEvent =
    target.scope === 'group'
      ? {
          message_type: 'group',
          group_id: target.groupId,
          user_id: target.userId,
          self_id: config.snowluma.botId,
        }
      : {
          message_type: 'private',
          user_id: target.userId,
          self_id: config.snowluma.botId,
        };

  enqueue(target.chatKey, async () => {
    try {
      if ((liveMessageAt.get(target.chatKey) || 0) >= syncStartedAt) {
        log(`跳过离线补回 ${target.chatKey}（排队期间已触发实时对话）`);
        markSyncHandled(target.chatKey, target.latestMsgId, target.latestTs);
        return;
      }

      log(`开始离线补回 ${target.chatKey}（${target.messages.length} 条未读）...`);
      const nowStr = formatNow();
      const latestMsg = target.messages[target.messages.length - 1];
      const sceneTag = formatSceneTag(pseudoEvent, config, latestMsg.speaker);
      let contextPrefix = `[当前时间: ${nowStr}] ${sceneTag}`;
      if (
        target.scope === 'private' &&
        config.emotion?.enabled !== false &&
        config.ownerId &&
        String(target.userId) === String(config.ownerId)
      ) {
        recordDailyPassiveInteraction();
        contextPrefix += `\n${formatEmotionForPrompt()}`;
      }

      const lines = target.messages
        .map((m) => {
          const dt = new Date(m.ts * 1000);
          const hhmm = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
          return `[msg_id=${m.messageId}] ${hhmm} [${m.speaker.label}(${m.who})]: ${m.text}`;
        })
        .join('\n');

      const isLatestMentionOnly = target.catchupMode === 'mention_latest';
      const promptText = isLatestMentionOnly
        ? `${contextPrefix}\n【你刚才离线/刚上线，以下是离线期间最后一条提到或 @ 你的消息】\n${lines}\n` +
          '（提示：你刚刚上线才看到这条喊你的消息，自然回应这一条就行，别把更早刷过去的旧话全翻出来）'
        : `${contextPrefix}\n【你刚才离线/刚上线，以下是离线期间发给你的未读消息】\n${lines}\n` +
          '（提示：你刚刚上线才看到这些消息，自然合并回应一句即可，不要一条条机械刷屏）';
      const persistLine = `[${nowStr.slice(11, 16)}] （刚上线看到 ${target.messages.length} 条离线留言）`;

      let directSent = false;
      const toolContext = {
        chatKey: target.chatKey,
        event: pseudoEvent,
        markDirectSent: (sentText) => {
          directSent = true;
          if (sentText) toolContext.directSentText = sentText;
        },
      };

      const reply = await llm.chat(target.chatKey, {
        text: promptText,
        persistText: persistLine,
        toolContext,
      });

      markSyncHandled(target.chatKey, target.latestMsgId, target.latestTs);

      if (reply && !directSent) {
        await sendReply(pseudoEvent, reply);
        if (target.scope === 'group') {
          lastGroupBotReplyAt.set(String(target.groupId), Date.now());
        }
        log(`离线补回 ${target.chatKey}: ${reply.slice(0, 80)}${reply.length > 80 ? '...' : ''}`);
      } else if (!directSent) {
        log(`离线补回 ${target.chatKey} 返回为空，未发送消息`);
      }
    } catch (err) {
      log(`离线补回失败 (${target.chatKey}):`, err?.message || err);
    }
  });
}

async function triggerOnlineSyncGate(reason = 'ws_open') {
  if (config.startupCatchup?.enabled === false) return;
  if (syncRunning) return;
  syncRunning = true;
  const syncStartedAt = Date.now();

  try {
    // 1. 探测等待 Chat 客户端真正在线（哪怕只开了 SnowLuma 还没登 账号 也不会扑空）
    const ready = await waitForClientReady(sendOneBot, {
      pollIntervalMs: config.startupCatchup?.onlinePollMs ?? 3000,
      maxWaitMs: 0,
      log,
      shouldStop: () => !wsConnected,
    });
    if (!ready.ok) return;
    clientOnline = true;
    log(`检测到 客户端已在线 (ID:${ready.userId}, 触发源:${reason})，开始收敛同步离线记忆库...`);

    // 2. 确定性收敛同步 + await 落盘 state/memory.db + 预热内存 recentBuffers
    const syncRes = await syncMemoryAndCatchup({
      config,
      sendOneBot,
      getPersona,
      log,
      recordRecentMessage,
      shouldStop: () => !wsConnected,
      count: config.startupCatchup?.preloadCount ?? 30,
      probeIntervalMs: config.startupCatchup?.probeIntervalMs ?? 2500,
      maxProbes: config.startupCatchup?.maxProbes ?? 6,
      maxAgeMinutes: config.startupCatchup?.maxAgeMinutes ?? 120,
      mentionMaxAgeMinutes: config.startupCatchup?.mentionMaxAgeMinutes ?? 720,
      mentionReplyLastOnly: config.startupCatchup?.mentionReplyLastOnly !== false,
      maxUnreadPerChat: config.startupCatchup?.maxUnreadPerChat ?? 8,
    });

    // 3. 只有明确收到 status === "success" 信号后，才进入下一步（回复离线未读消息）
    if (syncRes.status !== 'success') {
      log('离线记忆库同步未完成:', syncRes.error || syncRes.status);
      return;
    }

    if (config.startupCatchup?.replyUnread !== false && syncRes.unreadTargets.length > 0) {
      for (const target of syncRes.unreadTargets) {
        await handleOfflineUnreadTarget(target, syncStartedAt);
      }
    } else {
      // 不开启自动补回时，也标记当前位置避免后续重复扫描
      for (const target of syncRes.unreadTargets) {
        markSyncHandled(target.chatKey, target.latestMsgId, target.latestTs);
      }
    }
  } catch (err) {
    log('上线同步门控异常:', err?.message || err);
  } finally {
    syncRunning = false;
  }
}

let reconnectDelay = 2000;
/** 建立 OneBot v11 正向 WebSocket 连接，断线后指数退避自动重连（2s -> 30s） */
function connectSnowLuma() {
  const wsUrl = config.snowluma.wsUrl;
  log(`正在连接 SnowLuma: ${wsUrl.split('?')[0]}`);

  const ws = new WebSocket(wsUrl);

  ws.addEventListener('open', () => {
    wsConnected = true;
    reconnectDelay = 2000;
    const p = getPersona();
    const thinkText = activeLlm.thinkingLevel ? `，思考强度: ${activeLlm.thinkingLevel}` : '';
    log(
      `SnowLuma 已连接！角色: ${p.name}（唤醒词: ${p.keywords.join('/') || '仅@'}），提供商: ${llmProvider}，模型: ${llmModel}${thinkText}，已挂载 ${tools.length} 个工具`
    );
    triggerOnlineSyncGate('ws_open');
    scheduleNextTodoCheck();
  });

  ws.addEventListener('message', (msg) => {
    try {
      const data = JSON.parse(String(msg.data));
      Promise.resolve(handleMessage(data)).catch((err) => {
        log('处理 WebSocket 消息事件异常:', err?.message || err);
      });
    } catch (err) {
      log('解析 WebSocket 消息 JSON 失败:', err?.message || err);
    }
  });

  ws.addEventListener('close', (ev) => {
    wsConnected = false;
    clientOnline = false;
    log(`SnowLuma 连接断开 (code=${ev.code})，${reconnectDelay / 1000}s 后重连...`);
    setTimeout(connectSnowLuma, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });

  ws.addEventListener('error', (err) => {
    log('SnowLuma WebSocket 错误:', err?.message || '连接失败，请确认 SnowLuma 已启动');
  });
}

log('chat-soul-bridge 启动中...');
ensureEmotionFile();
ensureImpressionsDb();
seedImpressionsFromConfig(config);
ensureSlangDb();
const slangSeedRes = config.slang?.seedBuiltins !== false ? seedDefaultSlang() : { inserted: 0, total: 0 };
ensureMediaArchiveDir();
ensureDiaryDir(diaryDir);
ensureTodosFile();
ensureRateLimitFile();
onTodosChanged(() => scheduleNextTodoCheck());
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    safetyGuard.flushStateNow();
    process.exit(0);
  });
}
if (safetyGuard.config.enabled) {
  const sc = safetyGuard.config;
  const fmtLimit = (n, unit) => (n > 0 ? `${n}/${unit}` : `不限/${unit}`);
  const gapDesc =
    sc.maxGlobalSendGapMs > sc.minGlobalSendGapMs
      ? `${sc.minGlobalSendGapMs}~${sc.maxGlobalSendGapMs}ms(随机)`
      : `${sc.minGlobalSendGapMs}ms`;
  log(
    `风控护栏已启用: 单会话 ${fmtLimit(sc.maxSendPerMinute, '分')} ${fmtLimit(sc.maxSendPerHour, '时')} | 全局 ${fmtLimit(sc.globalMaxSendPerMinute, '分')} ${fmtLimit(sc.globalMaxSendPerHour, '时')} | 发包间距 ${gapDesc} | 唤醒限流 ${sc.wakeLimit?.enabled ? '开' : '关'} | 单条上限 ${sc.maxMessageChars}字`
  );
}
if (config.reply?.typingDelay !== false) {
  const r = config.reply || {};
  log(
    `回复节奏已启用: 首句随机 ${Number(r.firstReplyMinMs ?? 1500)}~${Number(r.firstReplyMaxMs ?? 3500)}ms | 后续气泡 ${Number(r.burstBaseMs ?? 1500)}ms+字数×${Number(r.burstPerCharMs ?? 400)}ms(+0~${Number(r.burstJitterMs ?? 600)}ms, 封顶${Number(r.burstMaxMs ?? 12000)}ms) | 插话打断 ${r.interruptibleTyping === true ? '开' : '关'} | 最多拆分 ${Number(r.maxBurstParts ?? 4)} 条`
  );
}
log(
  `群聊续聊判断已就绪: 回声检测 ${config.groupTrigger?.followupEchoEnabled !== false ? '开' : '关'} | 短时指代 ${Math.round(Number(config.groupTrigger?.followupDirectWindowMs ?? 25000) / 1000)}s | 语义裁判 ${semanticJudge.label}`
);
log(`本地短期上下文库已就绪: ${getContextDbPath()}`);
log(`本地人物印象库已就绪: ${getImpressionsDbPath()}`);
log(
  `本地梗库已就绪: ${getSlangDbPath()}（种子 ${slangSeedRes.total}条/新补${slangSeedRes.inserted} | 自动嗅梗 ${config.slang?.autoSniff !== false ? '开' : '关'} | 重复词捕捉 ${config.slang?.repeatDetect !== false ? '开' : '关'} | 后台偷学 ${config.slang?.asyncLlmLearn === true ? '开' : '关'}）`
);
initMemoryDb()
  .then((res) => {
    if (res?.ok) log(`本地记忆库已就绪: ${res.db}`);
    else log('本地记忆库初始化失败:', res?.error || res);
  })
  .finally(() => {
    connectSnowLuma();
    startProactiveSchedulers();
  });
