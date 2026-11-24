/**
 * 统一配置加载与默认值合并模块（src/config.js）
 *
 * 作用：
 *   1. 将全项目所有开关、阈值、冷却与相对路径统一收口到 config.json；
 *   2. 自动补全缺省字段的合理默认值（新手只填核心项也能稳稳启动，老手可全量精调）；
 *   3. 100% 向下兼容旧版顶层路径字段（personaFile / toolsPromptFile / memeDir / diaryDir / maxImageBytes）。
 */
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  snowluma: {
    wsUrl: 'ws://127.0.0.1:3001/',
    httpUrl: 'http://127.0.0.1:3000',
    accessToken: '',
    botId: 0,
  },
  llm: {
    active: 'gemini',
    temperature: 1.0,
    maxTokens: 1024,
    thinkingLevel: '',
    maxContextTurns: 20,
    providers: {},
  },
  proxyUrl: '',
  ownerId: 0,
  identity: {
    ownerTitle: '主人',
    ownerNickname: '',
    aiBots: {},
    knownUsers: {},
  },
  allowAllGroups: false,
  allowAllPrivate: false,
  allow: {
    private: [],
    groups: [],
  },
  deny: {
    private: [],
    groups: [],
  },
  groupTrigger: {
    atMention: true,
    replyToMe: true,
    keywords: [],
    topicKeywords: [],
    topicBoostStep: 0.25,
    topicMaxBoost: 0.45,
    ownerRandomReplyProbability: 0.55,
    ownerReplyCooldownMs: 10000,
    ownerFollowupWindowMs: 90000,
    randomReplyProbability: 0.3,
    botRandomReplyProbability: 0.15,
    randomReplyCooldownMs: 30000,
    maxConsecutiveWithoutOwner: 2,
  },
  proactive: {
    enabled: false,
    privateEnabled: true,
    groupIds: [],
    idleThresholdMs: 2700000,
    checkIntervalMinMs: 1800000,
    checkIntervalMaxMs: 3600000,
    probability: 0.35,
    quietStartHour: 23,
    quietEndHour: 8,
  },
  reply: {
    maxBurstParts: 4,
    maxImageBytes: 5242880,
  },
  contextFade: {
    fullWindowHours: 12,
    overnightMaxTurns: 4,
    maxAgeHours: 48,
  },
  emotion: {
    enabled: true,
    moodHalfLifeHours: 4,
    affectionCooldownMinutes: 60,
    milestoneCooldownHours: 24,
    dailyNormalGainCap: 2,
  },
  todos: {
    enabled: true,
    maxItems: 20,
    staleDays: 7,
    injectMaxItems: 5,
  },
  forward: {
    autoExpand: true,
    maxExpandItems: 25,
    maxExpandDepth: 2,
    maxExpandImages: 4,
    maxSendNodes: 20,
  },
  tools: {
    googleSearch: false,
    webSearch: true,
  },
  imageGen: {
    enabled: false,
    active: 'siliconflow',
    cooldownMs: 30000,
    providers: {},
  },
  memoryPrivacy: {
    trustedGroups: [],
    privateMemoryGroups: [],
  },
  impressions: {
    enabled: true,
    injectMaxUsers: 2,
    maxCharsPerUser: 60,
  },
  mediaArchive: {
    enabled: true,
    autoCaption: true,
    captionModel: '',
    maxFiles: 300,
    maxTotalMB: 200,
  },
  startupCatchup: {
    enabled: true,
    replyUnread: true,
    replyGroupOwner: true,
    preloadCount: 30,
    onlinePollMs: 3000,
    probeIntervalMs: 2500,
    maxProbes: 6,
    maxAgeMinutes: 120,
    mentionMaxAgeMinutes: 720,
    mentionReplyLastOnly: true,
    maxUnreadPerChat: 8,
  },
  paths: {
    personaFile: 'roles/persona.txt',
    toolsPromptFile: 'roles/persona-tools-detail.txt',
    memeDir: 'tools/meme',
    diaryDir: 'tools/Diary',
    pythonBin: '',
  },
};

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** 浅层合并配置块并忽略仅供人类阅读的 _comment* 字段 */
function mergeSection(defaults, rawSection) {
  const out = { ...defaults };
  if (!isPlainObject(rawSection)) return out;
  for (const [k, v] of Object.entries(rawSection)) {
    if (k.startsWith('_comment')) continue;
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** 清理字典对象里的 _comment* 键（例如 knownUsers / providers） */
function stripCommentKeys(obj) {
  if (!isPlainObject(obj)) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_comment')) continue;
    out[k] = v;
  }
  return out;
}

/** 从指定根目录加载并规范化 config.json */
export function loadConfig(rootDir = process.cwd(), configFilename = 'config.json') {
  const fullPath = path.resolve(rootDir, configFilename);
  const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));

  const paths = mergeSection(DEFAULT_CONFIG.paths, {
    ...(raw.personaFile !== undefined ? { personaFile: raw.personaFile } : {}),
    ...(raw.toolsPromptFile !== undefined ? { toolsPromptFile: raw.toolsPromptFile } : {}),
    ...(raw.memeDir !== undefined ? { memeDir: raw.memeDir } : {}),
    ...(raw.diaryDir !== undefined ? { diaryDir: raw.diaryDir } : {}),
    ...(raw.pythonBin !== undefined ? { pythonBin: raw.pythonBin } : {}),
    ...(isPlainObject(raw.paths) ? raw.paths : {}),
  });

  const reply = mergeSection(DEFAULT_CONFIG.reply, {
    ...(raw.maxImageBytes !== undefined ? { maxImageBytes: raw.maxImageBytes } : {}),
    ...(isPlainObject(raw.reply) ? raw.reply : {}),
  });

  const identity = mergeSection(DEFAULT_CONFIG.identity, raw.identity);
  if (Array.isArray(identity.aiBots)) {
    const map = {};
    for (const uid of identity.aiBots) {
      const k = String(uid || '').trim();
      if (k) map[k] = '';
    }
    identity.aiBots = map;
  } else {
    identity.aiBots = stripCommentKeys(identity.aiBots);
  }
  identity.knownUsers = stripCommentKeys(identity.knownUsers);

  const llm = mergeSection(DEFAULT_CONFIG.llm, raw.llm);
  if (isPlainObject(llm.providers)) {
    llm.providers = stripCommentKeys(llm.providers);
  }

  const imageGen = mergeSection(DEFAULT_CONFIG.imageGen, raw.imageGen);
  if (isPlainObject(imageGen.providers)) {
    imageGen.providers = stripCommentKeys(imageGen.providers);
  }

  const snowluma = mergeSection(DEFAULT_CONFIG.snowluma, raw.snowluma);
  if (!snowluma.botId && raw.snowluma?.botQQ) {
    snowluma.botId = raw.snowluma.botQQ;
  }

  return {
    ...raw,
    snowluma,
    llm,
    proxyUrl: typeof raw.proxyUrl === 'string' ? raw.proxyUrl.trim() : '',
    ownerId: raw.ownerId ?? raw.ownerQQ ?? DEFAULT_CONFIG.ownerId,
    identity,
    allowAllGroups: raw.allowAllGroups === true,
    allowAllPrivate: raw.allowAllPrivate === true,
    allow: mergeSection(DEFAULT_CONFIG.allow, raw.allow),
    deny: mergeSection(DEFAULT_CONFIG.deny, raw.deny),
    groupTrigger: mergeSection(DEFAULT_CONFIG.groupTrigger, raw.groupTrigger),
    proactive: mergeSection(DEFAULT_CONFIG.proactive, raw.proactive),
    reply,
    contextFade: mergeSection(DEFAULT_CONFIG.contextFade, raw.contextFade),
    emotion: mergeSection(DEFAULT_CONFIG.emotion, raw.emotion),
    todos: mergeSection(DEFAULT_CONFIG.todos, raw.todos),
    forward: mergeSection(DEFAULT_CONFIG.forward, raw.forward),
    tools: mergeSection(DEFAULT_CONFIG.tools, raw.tools),
    imageGen,
    memoryPrivacy: mergeSection(DEFAULT_CONFIG.memoryPrivacy, raw.memoryPrivacy),
    impressions: mergeSection(DEFAULT_CONFIG.impressions, raw.impressions),
    mediaArchive: mergeSection(DEFAULT_CONFIG.mediaArchive, raw.mediaArchive),
    startupCatchup: mergeSection(DEFAULT_CONFIG.startupCatchup, raw.startupCatchup),
    paths,
    // 向下兼容旧顶层字段读取
    personaFile: paths.personaFile,
    toolsPromptFile: paths.toolsPromptFile,
    memeDir: paths.memeDir,
    diaryDir: paths.diaryDir,
    maxImageBytes: reply.maxImageBytes,
  };
}
