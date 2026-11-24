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
import { configureContextFade, getContextDbPath } from './context-db.js';
import { configureMemoryDb, initMemoryDb, saveChatMessageToDb, updateChatMessageTextInDb } from './db.js';
import {
  configureEmotion,
  ensureEmotionFile,
  formatEmotionForPrompt,
  getEmotionSnapshot,
  recordDailyPassiveInteraction,
} from './emotion.js';
import { configureForward, resolveForwardMessage } from './forward.js';
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
import { buildTools, createToolExecutor, selectToolsForContext } from './tools.js';

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

async function sendOneBot(action, payload) {
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
  forwardConfig: config.forward,
  getBotName: () => getPersona().name,
  getReferencePath: () => getPersona().referencePath,
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
  });
}

const llm = createLlmClient({
  ...activeLlm,
  tools,
  getTools: getToolsForChat,
  executeTool,
  getSystemInstruction,
});

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

/**
 * 将长回复按换行拆分为 1~4 条 聊天消息气泡短消息，并剥离常见 Markdown 加粗符号。
 */
function splitBurstMessages(text, maxParts = 4) {
  const cleaned = text
    .replace(/\r\n/g, '\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .trim();
  if (!cleaned) return [];
  const lines = cleaned
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= maxParts) return lines;
  return [...lines.slice(0, maxParts - 1), lines.slice(maxParts - 1).join('\n')];
}

/**
 * 拟人化分条发送回复（条间按字数随机停顿 0.7~2.8s）：
 *   逐条按真实 OneBot message_id 写入 state/memory.db 与内存 recentBuffers，
 *   确保与离线同步拉取的群/私聊历史 1 对 1 精准去重，且引用任意一条气泡都能秒命中缓存。
 */
async function sendReply(event, text) {
  const maxBurst = Math.max(1, Math.min(8, Number(config.reply?.maxBurstParts ?? 4)));
  const parts = splitBurstMessages(text, maxBurst);
  if (parts.length === 0) return '';

  const chatKey =
    event.message_type === 'group' ? `group:${event.group_id}` : `private:${event.user_id}`;
  const botName = getPersona().name;
  let lastMsgId = '';

  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      const delay = Math.min(2800, 700 + parts[i].length * 35 + Math.floor(Math.random() * 400));
      await sleep(delay);
    }
    let res;
    if (event.message_type === 'private') {
      res = await sendOneBot('send_private_msg', { user_id: event.user_id, message: parts[i] });
    } else if (event.message_type === 'group') {
      res = await sendOneBot('send_group_msg', { group_id: event.group_id, message: parts[i] });
    }
    rememberMyMessageId(res);
    const msgId = res?.data?.message_id != null ? String(res.data.message_id) : '';
    if (msgId) lastMsgId = msgId;

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

/** 下载 聊天消息里的图片并编码为 base64（带超时与体积上限保护） */
async function downloadImage(url, maxBytes) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const contentType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    if (!contentType.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > maxBytes) return null;
    return { data: buf.toString('base64'), mimeType: contentType };
  } catch {
    return null;
  }
}

/** 解析 OneBot v11 消息段数组（提取纯文本、图片 URL、合并转发 ID、引用 ID 与 @ 标记/列表） */
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

  for (const fid of (forwardIds || []).slice(0, 2)) {
    const resolved = await resolveForwardMessage(sendOneBot, fid, {
      maxItems: Number(config.forward?.maxExpandItems ?? 25),
      maxDepth: Number(config.forward?.maxExpandDepth ?? 2),
      maxImages: Math.max(0, maxImgLimit - mergedImages.length),
      maxChars: 2600,
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
  if (hit && hit.text && hit.text !== '[图片]') {
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

// 活跃追踪 + 群聊冒泡冷却 + 管理员独立冷却/连聊窗口 + 防 AI 互怼死循环计数
const lastActivityAt = new Map();
const proactiveSentSinceLastActivity = new Set();
const lastRandomReplyAt = new Map();
const lastOwnerRandomReplyAt = new Map();
const lastGroupBotReplyAt = new Map();
const nonOwnerStreak = new Map();

function touchActivity(chatKey) {
  lastActivityAt.set(chatKey, Date.now());
  proactiveSentSinceLastActivity.delete(chatKey);
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
 * 群聊唤醒判定：依次检查防多 Bot 死循环护栏 -> @ -> 引用回复 -> 人设关键词 -> 管理员优先/话题热度/普通群友概率。
 * 返回 { reason, matchedTopics } 或 null（不回复）。
 */
function checkGroupTrigger(
  groupId,
  senderId,
  text,
  isAtMe,
  replyId,
  hasImage = false,
  speaker = null,
  chatKey = ''
) {
  const gKey = String(groupId);
  const isOwner = Boolean(config.ownerId) && String(senderId) === String(config.ownerId);
  const isKnownBot =
    !isOwner &&
    (speaker?.isAiBot === true || (speaker?.role === 'known' && /(ai|bot|机器人)/i.test(String(speaker.tag || ''))));
  const maxStreak = Number(config.groupTrigger?.maxConsecutiveWithoutOwner ?? 2);
  const currentStreak = nonOwnerStreak.get(gKey) || 0;

  if (isOwner) {
    nonOwnerStreak.set(gKey, 0);
  }

  // 如果连续非主人（例如另一个 AI 机器人）触发达到上限，暂停响应避免两个 AI 无限互刷
  if (!isOwner && currentStreak >= maxStreak) {
    return null;
  }

  if (config.groupTrigger?.atMention !== false && isAtMe) {
    if (!isOwner) nonOwnerStreak.set(gKey, currentStreak + 1);
    return { reason: 'at', matchedTopics: [] };
  }

  if (config.groupTrigger?.replyToMe !== false && replyId && myMessageIds.has(String(replyId))) {
    if (!isOwner) nonOwnerStreak.set(gKey, currentStreak + 1);
    return { reason: 'reply', matchedTopics: [] };
  }

  const keywords = [...new Set([...(getPersona().keywords || []), ...(config.groupTrigger?.keywords || [])])];
  const lower = text.toLowerCase();
  if (keywords.some((kw) => kw && lower.includes(String(kw).toLowerCase()))) {
    if (!isOwner) nonOwnerStreak.set(gKey, currentStreak + 1);
    return { reason: 'keyword', matchedTopics: [] };
  }

  // 计算角色兴趣话题热度加成（0 延迟、0 API 消耗）
  const { heat, matchedWords } = computeGroupTopicHeat(chatKey || `group:${gKey}`, text);
  const topicBoostStep = Number(config.groupTrigger?.topicBoostStep ?? 0.25);
  const topicMaxBoost = Number(config.groupTrigger?.topicMaxBoost ?? 0.45);
  const topicBoost = heat > 0 ? Math.min(topicMaxBoost, heat * topicBoostStep) : 0;

  // 管理员发言专属通道：更高唤醒概率 + 更短独立冷却 + 刚聊过天时的连聊窗口加成 + 话题热度加成
  if (isOwner) {
    const baseOwnerProb = Number(
      config.groupTrigger?.ownerRandomReplyProbability ??
        config.groupTrigger?.randomReplyProbability ??
        0.55
    );
    if (baseOwnerProb > 0 && (text.length >= 1 || hasImage)) {
      const ownerCooldownMs = Number(config.groupTrigger?.ownerReplyCooldownMs ?? 10000);
      const followupWindowMs = Number(config.groupTrigger?.ownerFollowupWindowMs ?? 90000);
      const now = Date.now();
      const inFollowup =
        followupWindowMs > 0 && now - (lastGroupBotReplyAt.get(gKey) || 0) <= followupWindowMs;
      const prob = Math.min(0.95, baseOwnerProb + (inFollowup ? 0.25 : 0) + topicBoost);
      const last = lastOwnerRandomReplyAt.get(gKey) || 0;
      if (now - last >= ownerCooldownMs && Math.random() < prob) {
        lastOwnerRandomReplyAt.set(gKey, now);
        const reason = topicBoost > 0 ? 'owner_topic' : inFollowup ? 'owner_followup' : 'owner_random';
        return { reason, matchedTopics: matchedWords };
      }
    }
    return null;
  }

  // 非管理员：区分“已知同群 AI 伙伴”（低概率防互刷）与“普通人类群友”（默认 30% + 话题热度加成）
  const baseProb = isKnownBot
    ? Number(config.groupTrigger?.botRandomReplyProbability ?? 0.15)
    : Number(config.groupTrigger?.randomReplyProbability ?? 0.3);
  const prob = isKnownBot
    ? Math.min(0.6, baseProb + topicBoost * 0.5)
    : Math.min(0.8, baseProb + topicBoost);
  const cooldownMs = Number(config.groupTrigger?.randomReplyCooldownMs ?? 30000);
  if (prob > 0 && (text.length >= 2 || (topicBoost > 0 && text.length >= 1))) {
    const last = lastRandomReplyAt.get(gKey) || 0;
    if (Date.now() - last >= cooldownMs && Math.random() < prob) {
      lastRandomReplyAt.set(gKey, Date.now());
      nonOwnerStreak.set(gKey, currentStreak + 1);
      return { reason: topicBoost > 0 ? 'topic' : 'random', matchedTopics: matchedWords };
    }
  }
  return null;
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

function scheduleProactiveCheck(chatKey, targetEvent) {
  if (!config.proactive?.enabled) return;
  const minMs = Number(config.proactive?.checkIntervalMinMs ?? 1800000);
  const maxMs = Number(config.proactive?.checkIntervalMaxMs ?? 3600000);
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
  if (!wsConnected) return;
  if (isQuietHour()) return;
  if (proactiveSentSinceLastActivity.has(chatKey)) return; // 对方没回之前不连环发

  const idleThresholdMs = Number(config.proactive?.idleThresholdMs ?? 2700000);
  const last = lastActivityAt.get(chatKey) || 0;
  if (Date.now() - last < idleThresholdMs) return;

  let prob = Number(config.proactive?.probability ?? 0.35);
  // 好感度与心情联动主动意愿：心情极低落或关系疏远时减少主动打扰，开心且亲近时略微更主动
  if (targetEvent.message_type === 'private' && config.emotion?.enabled !== false) {
    const emo = getEmotionSnapshot();
    if (emo.mood <= -20 || emo.affection < 30) return;
    if (emo.mood >= 20 && emo.affection >= 65) prob = Math.min(0.75, prob * 1.3);
  }
  if (Math.random() >= prob) return;

  enqueue(chatKey, async () => {
    if (proactiveSentSinceLastActivity.has(chatKey)) return;
    proactiveSentSinceLastActivity.add(chatKey);
    lastActivityAt.set(chatKey, Date.now());

    const nowStr = formatNow();
    const recent = getRecentMessages(chatKey, 6);
    const recentBlock = recent.length
      ? `\n【之前聊到这儿】\n${recent.map((m) => `${m.time} ${m.sender}: ${m.text}`).join('\n')}`
      : '';

    const todoInjectMax = Math.max(1, Number(config.todos?.injectMaxItems ?? 5));
    const todoLine =
      targetEvent.message_type === 'private' && config.todos?.enabled !== false
        ? formatTodosForPrompt(todoInjectMax)
        : '';
    const todoBlock = todoLine ? `\n${todoLine}` : '';
    const sceneHint =
      targetEvent.message_type === 'private'
        ? '你和主人已经好一会儿没说话了，现在是白天空闲时间，你突然想主动私聊找他聊两句（可以问问他在干嘛、分享个小念头、或者顺着待办小纸条或之前聊过的事随口问一句）。自然一点，1~2句短话就行，别用“在吗”这种机械开场白。'
        : '群里安静好一会儿了，你闲不住想主动冒个泡找大家唠嗑（可以随口抛个生活小脑洞、问问大家在干嘛、或者接着之前的话题逗逗大家）。自然简短，1~2句就行，别用“有人吗”这种气氛组话术。';

    const prompt = `[当前时间: ${nowStr}]${todoBlock}${recentBlock}\n（主动冒泡机会：${sceneHint}）`;
    log(`触发主动找你聊: ${chatKey}`);

    let directSent = false;
    const reply = await llm.chat(chatKey, {
      text: prompt,
      persistText: `[${nowStr.slice(11, 16)}] （主动发起闲聊）`,
      toolContext: {
        chatKey,
        event: targetEvent,
        markDirectSent: () => {
          directSent = true;
        },
      },
    });

    if (reply && !directSent) {
      await sendReply(targetEvent, reply);
      log(`主动发言 ${chatKey}: ${reply.slice(0, 80)}`);
    }
  });
}

function startProactiveSchedulers() {
  if (!config.proactive?.enabled) return;
  const targets = [];

  if (config.proactive.privateEnabled !== false && config.ownerId) {
    const key = `private:${config.ownerId}`;
    lastActivityAt.set(key, Date.now());
    targets.push(key);
    scheduleProactiveCheck(key, {
      message_type: 'private',
      user_id: config.ownerId,
      self_id: config.snowluma.botId,
    });
  }

  for (const gid of config.proactive.groupIds || []) {
    const key = `group:${gid}`;
    lastActivityAt.set(key, Date.now());
    targets.push(key);
    scheduleProactiveCheck(key, {
      message_type: 'group',
      group_id: gid,
      self_id: config.snowluma.botId,
    });
  }

  if (targets.length > 0) {
    log(
      `已开启主动找你聊: ${targets.join(', ')}（免打扰 ${config.proactive.quietStartHour ?? 23}:00~${config.proactive.quietEndHour ?? 8}:00）`
    );
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
  if (!text && imageUrls.length === 0) return;

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
    text: recentRecordText || '[图片]',
  });

  let triggerReason = 'private';
  let matchedTopics = [];
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
      chatKey
    );
    triggerReason = triggerRes?.reason || null;
    matchedTopics = triggerRes?.matchedTopics || [];
    // 兜底：若群友引用的是机器人重启前发的旧消息（不在内存 myMessageIds 中），通过 get_msg 识别并唤醒
    if (!triggerReason && replyId && config.groupTrigger?.replyToMe !== false) {
      const selfId = String(event.self_id || config.snowluma.botId || '');
      const isOwner = String(event.user_id) === String(config.ownerId || '');
      const maxStreak = Number(config.groupTrigger?.maxConsecutiveWithoutOwner ?? 2);
      const streak = nonOwnerStreak.get(String(event.group_id)) || 0;
      if (isOwner || streak < maxStreak) {
        quotedMessage = await resolveQuotedMessage(chatKey, replyId);
        if (quotedMessage && selfId && quotedMessage.userId === selfId) {
          triggerReason = 'reply';
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
      text: text || '[图片]',
      ts: event.time ? Number(event.time) : Date.now() / 1000,
    }).then((r) => {
      if (r && !r.ok && !r.skipped) log('写入记忆库失败(收):', r.error || r);
    });
  }

  if (event.message_type === 'group' && !triggerReason) {
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
        contextPrefix += `\n${formatEmotionForPrompt()}`;
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
      let replyHint = '';
      if (replyId) {
        if (quotedMessage && quotedMessage.text) {
          const extraImgNote = quotedMessage.imageUrls?.length > 0 && quotedMessage.text !== '[图片]' ? '（含图片）' : '';
          if (quotedMessage.isForward || quotedMessage.text.startsWith('[合并转发')) {
            replyHint = ` [引用了 ${quotedMessage.sender} 的合并转发(id=${replyId})${extraImgNote}：\n${quotedMessage.text.slice(0, 1600)}\n]`;
          } else {
            const snippet = quotedMessage.text.replace(/\s+/g, ' ').slice(0, 220);
            replyHint = ` [引用了 ${quotedMessage.sender} 的消息(id=${replyId}): 「${snippet}」${extraImgNote}]`;
          }
        } else {
          replyHint = ` [引用了消息 id=${replyId}]`;
        }
      }
      const currentLine =
        event.message_type === 'group'
          ? `[当前消息 msg_id=${event.message_id || ''}][${speaker.label}(${event.user_id})]${replyHint} ${text || '（发了一张图片）'}`
          : `[当前消息 msg_id=${event.message_id || ''}][${speaker.label}]${replyHint} ${text || '（发了一张图片）'}`;

      const promptText = `${contextPrefix}\n${currentLine}`;

      log(`收到 ${chatKey} (${senderName}, ${triggerReason}): ${text || '[图片]'}`);

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
      const reply = await llm.chat(chatKey, {
        text: promptText,
        persistText: persistLine,
        images,
        toolContext,
      });

      if (reply && !directSent) {
        await sendReply(event, reply);
        if (event.message_type === 'group') {
          lastGroupBotReplyAt.set(String(event.group_id), Date.now());
        }
        log(`回复 ${chatKey}: ${reply.slice(0, 80)}${reply.length > 80 ? '...' : ''}`);
      } else if (directSent && event.message_type === 'group') {
        lastGroupBotReplyAt.set(String(event.group_id), Date.now());
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
      handleMessage(data);
    } catch {}
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
ensureMediaArchiveDir();
ensureDiaryDir(diaryDir);
ensureTodosFile();
onTodosChanged(() => scheduleNextTodoCheck());
log(`本地短期上下文库已就绪: ${getContextDbPath()}`);
log(`本地人物印象库已就绪: ${getImpressionsDbPath()}`);
initMemoryDb()
  .then((res) => {
    if (res?.ok) log(`本地记忆库已就绪: ${res.db}`);
    else log('本地记忆库初始化失败:', res?.error || res);
  })
  .finally(() => {
    connectSnowLuma();
    startProactiveSchedulers();
  });
