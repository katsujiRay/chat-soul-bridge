/**
 * 情感状态引擎：好感度（长期关系）与心情（即时情绪）双向联动系统（src/emotion.js）
 *
 * 持久化位置：state/emotion.json（好感度仅对管理员本人私聊生效，绝不泄露给外部群聊；心情全局同步）
 *
 * 核心机制：
 *   1. 好感度（0~100，默认初始 50，闲置衰减保底 floor=25）：
 *      - 双轨增长：
 *        ① 被动陪伴：管理员每发一条私聊 +0.05，每日封顶 +0.5（=10 条），计入当日普通上限 +2；
 *        ② 主动调整：走心 +1 / 难忘 +2 / 里程碑 +3~+5 / 冷落越界失望 -2~-10；
 *           独立 1 小时手动冷却（lastManualAdjustAt，绝不与被动交互混用）、80+ 减半 / 90+ 再减半；
 *           里程碑（>=+3）突破日上限、走独立 7 天（168h）周额度；
 *        ③ 心情哄好奖励：心情明显由负转正（before<=-10, after>=5, 落差>=15）自动 +0.5（走日上限、不吃手动冷却）。
 *      - 惰性闲置衰减：超过 24h 无互动后按天惰性 -1，保底 25（读时计算、零定时器、按日步进不重复扣分）。
 *      - 六档可执行行为边界（can / cant / mind）+ 注入最近 3 条变化，除最高档外「心里」禁止直接说破。
 *   2. 心情（-100~+100，默认 0）：
 *      - 好感度基线偏移：baseline = round((affection - 50) * 0.2)，关系越好「平静」越偏暖；
 *      - 线性平滑回归：调整后前 30 分钟不淡，之后每小时向基线回归 8 点；
 *      - 5 分钟主动调整冷却，单次上限 ±40，高好感更敏感（>=70 时正×1.2/负×1.15，<40 时×0.8）；
 *      - 严重受挫（单次 <=-30 且落到 <=-50）连带扣好感 -0.5；由负转正时带回上次低落原因便于自然翻篇；
 *      - 陈旧 reason 自动检测 + 平静无因时省略注入省 token + 低落时附带反向情绪提醒与三条底线。
 */
import fs from 'node:fs';
import path from 'node:path';
import { formatNow } from './memory.js';

const STATE_DIR = path.resolve(process.cwd(), 'state');
const EMOTION_FILE = path.join(STATE_DIR, 'emotion.json');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MOOD_TOOL_NAME = 'chat_mood_adjust';
const VALID_STYLES = new Set(['balanced', 'direct', 'tsundere']);

const cfg = {
  style: 'balanced',
  syncMoodToExternalGroups: true,
  runtimeMoodHint: true,
  initialAffection: 50,
  affectionFloor: 25,
  passiveStep: 0.05,
  passiveDailyCap: 0.5,
  dailyNormalGainCap: 2.0,
  decayAfterMs: 24 * HOUR_MS,
  decayPerDay: 1.0,
  affectionCooldownMs: 60 * 60 * 1000, // 1 小时（仅限主动调整）
  milestoneCooldownMs: 168 * HOUR_MS, // 7 天（一周一次里程碑）
  moodDecayAfterMs: 30 * 60 * 1000, // 30 分钟后开始回归
  moodDecayPerHour: 8.0, // 每小时线性回归 8 点
  moodCooldownMs: 5 * 60 * 1000, // 5 分钟冷却
  moodMaxAdjustPerCall: 40,
  moodBaselineFactor: 0.2,
};

/** 应用来自 config.json -> emotion 的情感参数（兼容旧版字段） */
export function configureEmotion(raw = {}) {
  if (!raw || typeof raw !== 'object') return;
  const num = (v) => (v !== undefined && v !== null && v !== '' ? Number(v) : NaN);

  if (typeof raw.style === 'string') {
    const s = raw.style.trim().toLowerCase();
    if (VALID_STYLES.has(s)) cfg.style = s;
  }
  if (typeof raw.syncMoodToExternalGroups === 'boolean') {
    cfg.syncMoodToExternalGroups = raw.syncMoodToExternalGroups;
  }
  if (typeof raw.runtimeMoodHint === 'boolean') {
    cfg.runtimeMoodHint = raw.runtimeMoodHint;
  }
  if (Number.isFinite(num(raw.initialAffection))) cfg.initialAffection = clamp(num(raw.initialAffection), 0, 100);
  if (Number.isFinite(num(raw.affectionFloor))) cfg.affectionFloor = clamp(num(raw.affectionFloor), 0, 100);
  if (Number.isFinite(num(raw.passiveStep)) && num(raw.passiveStep) >= 0) cfg.passiveStep = num(raw.passiveStep);
  if (Number.isFinite(num(raw.passiveDailyCap)) && num(raw.passiveDailyCap) >= 0) {
    cfg.passiveDailyCap = num(raw.passiveDailyCap);
  }
  if (Number.isFinite(num(raw.dailyNormalGainCap)) && num(raw.dailyNormalGainCap) > 0) {
    cfg.dailyNormalGainCap = num(raw.dailyNormalGainCap);
  }
  if (Number.isFinite(num(raw.decayAfterHours)) && num(raw.decayAfterHours) >= 0) {
    cfg.decayAfterMs = Math.round(num(raw.decayAfterHours) * HOUR_MS);
  }
  if (Number.isFinite(num(raw.decayPerDay)) && num(raw.decayPerDay) >= 0) {
    cfg.decayPerDay = num(raw.decayPerDay);
  }
  if (Number.isFinite(num(raw.affectionCooldownMinutes)) && num(raw.affectionCooldownMinutes) >= 0) {
    cfg.affectionCooldownMs = Math.round(num(raw.affectionCooldownMinutes) * 60 * 1000);
  }
  if (Number.isFinite(num(raw.milestoneCooldownHours)) && num(raw.milestoneCooldownHours) >= 0) {
    cfg.milestoneCooldownMs = Math.round(num(raw.milestoneCooldownHours) * HOUR_MS);
  }
  if (Number.isFinite(num(raw.moodDecayAfterMinutes)) && num(raw.moodDecayAfterMinutes) >= 0) {
    cfg.moodDecayAfterMs = Math.round(num(raw.moodDecayAfterMinutes) * 60 * 1000);
  }
  if (Number.isFinite(num(raw.moodDecayPerHour)) && num(raw.moodDecayPerHour) > 0) {
    cfg.moodDecayPerHour = num(raw.moodDecayPerHour);
  }
  if (Number.isFinite(num(raw.moodCooldownMinutes)) && num(raw.moodCooldownMinutes) >= 0) {
    cfg.moodCooldownMs = Math.round(num(raw.moodCooldownMinutes) * 60 * 1000);
  }
  if (Number.isFinite(num(raw.moodMaxAdjustPerCall)) && num(raw.moodMaxAdjustPerCall) > 0) {
    cfg.moodMaxAdjustPerCall = clamp(num(raw.moodMaxAdjustPerCall), 5, 100);
  }
  if (Number.isFinite(num(raw.moodBaselineFactor)) && num(raw.moodBaselineFactor) >= 0) {
    cfg.moodBaselineFactor = clamp(num(raw.moodBaselineFactor), 0, 1);
  }
}

function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function round2(val) {
  return Math.round(val * 100) / 100;
}

function defaultState() {
  return {
    affection: {
      score: cfg.initialAffection,
      dailyGainDate: '',
      dailyGain: 0,
      lastManualAdjustAt: 0,
      lastMilestoneAt: 0,
      lastActiveAt: 0,
      lastDecayAt: 0,
      passiveDate: '',
      passiveCount: 0,
      history: [],
    },
    mood: {
      value: 0,
      reason: '',
      updatedAt: 0,
      lastAdjustAt: 0,
      lastNegativeReason: '',
      history: [],
    },
  };
}

export function getEmotionFilePath() {
  return EMOTION_FILE;
}

export function ensureEmotionFile(filePath = EMOTION_FILE) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${JSON.stringify(defaultState(), null, 2)}\n`, 'utf8');
    return false;
  }
  return true;
}

function loadState(filePath = EMOTION_FILE) {
  ensureEmotionFile(filePath);
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const base = defaultState();
    const rawAff = raw?.affection || {};
    const rawMood = raw?.mood || {};
    return {
      affection: {
        ...base.affection,
        ...rawAff,
        // 无损迁移旧版字段（lastAdjustAt -> lastManualAdjustAt，lastPassiveDate -> passiveDate）
        lastManualAdjustAt: Number(rawAff.lastManualAdjustAt ?? rawAff.lastAdjustAt ?? 0),
        passiveDate: String(rawAff.passiveDate ?? rawAff.lastPassiveDate ?? ''),
        passiveCount: Number(rawAff.passiveCount ?? 0),
        lastActiveAt: Number(rawAff.lastActiveAt ?? 0),
        lastDecayAt: Number(rawAff.lastDecayAt ?? 0),
        history: Array.isArray(rawAff.history) ? rawAff.history : [],
      },
      mood: {
        ...base.mood,
        ...rawMood,
        lastAdjustAt: Number(rawMood.lastAdjustAt ?? rawMood.updatedAt ?? 0),
        history: Array.isArray(rawMood.history) ? rawMood.history : [],
      },
    };
  } catch {
    return defaultState();
  }
}

function saveState(state, filePath = EMOTION_FILE) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

const AFFECTION_TIER_PRESETS = {
  balanced: {
    stranger: {
      label: '刚认识',
      can: '客气应答、简单接话；不想理时可以简短带过',
      cant: '不主动找对方、不打听私事、不主动聊自己的心事',
      mind: '觉得这人还行，但还没熟到愿意花心思记太多事',
    },
    bicker: {
      label: '能拌嘴',
      can: '会轻松接话、偶尔拌嘴开小玩笑、自然互动',
      cant: '不主动吐露私密心事；不过度追问对方行踪',
      mind: '跟对方斗嘴聊日常挺有意思的，比和普通人聊轻松一些',
    },
    familiar: {
      label: '熟人',
      can: '正常自然聊天、会接梗、偶尔主动找话题、记得对方提过的事',
      cant: '不主动说肉麻或过度亲密的话；不越界追问隐私',
      mind: '其实悄悄记着对方说过的小事，只是平时不会特意拿出来邀功',
    },
    close: {
      label: '亲近',
      can: '愿意主动找对方、分享自己的日常和想法、敢直接吐槽或撒娇、也能坦然拒绝',
      cant: '不主动把「想你/在一起」这类重话挂嘴边',
      mind: '对方久不出现时会惦记，但被问起来多半只会轻描淡写带过',
    },
    crush: {
      label: '心动偏爱',
      can: '会因为对方一句话琢磨半天；对方冷落时会有点吃醋或小失落；会找机会多聊几句',
      cant: '保持一点含蓄与分寸，不把心底那份偏爱说破',
      mind: '对方随口一句能让你惦记好久，但真被问怎么了时多半只会含糊带过',
    },
    confessed: {
      label: '满心满眼',
      can: '可以坦率表达想念、偏爱与依赖；可以自然撒娇要回应',
      cant: '不翻旧账；不用「你是不是不在意我了」反复试探',
      mind: '',
    },
  },
  direct: {
    stranger: {
      label: '刚认识',
      can: '客气应答、有点怕生，简单自然接话',
      cant: '不主动黏上去、不打听私事、不主动讲心事',
      mind: '还在悄悄观察这人靠不靠谱',
    },
    bicker: {
      label: '能拌嘴',
      can: '轻松接话、偶尔开小玩笑和轻吐槽、互动自然',
      cant: '不主动吐露深层心事；不追问对方行踪',
      mind: '觉得对方挺合拍的，愿意多搭几句话',
    },
    familiar: {
      label: '熟人',
      can: '熟络自然聊、会接梗、偶尔主动分享好玩的事、记得对方提过的细节',
      cant: '不越界追问隐私；不过度缠人打扰对方正事',
      mind: '已经把对方当自己人了，一起聊日常很放松',
    },
    close: {
      label: '亲近',
      can: '主动找对方分享日常、自然撒娇求夸或直接吐槽、不开心也会直说，也能坦然拒绝',
      cant: '不提沉重绑架式的承诺；不强求秒回',
      mind: '对方不在时会惦记，见到了就忍不住想凑过去多聊两句',
    },
    crush: {
      label: '心动偏爱',
      can: '会大方流露偏爱、开心就直夸、想念或小委屈也会轻轻撒娇露出来、爱找机会黏着聊',
      cant: '不拿撒娇当筹码逼对方；不过度发腻说肉麻长情话',
      mind: '明明白白很偏爱对方，只留一点俏皮余韵',
    },
    confessed: {
      label: '满心满眼',
      can: '坦率直球表达喜欢、想念与依赖；想撒娇就撒娇、想夸就直夸',
      cant: '不翻旧账；不用「你是不是不在意我了」反复试探',
      mind: '',
    },
  },
  tsundere: {
    stranger: {
      label: '刚认识',
      can: '客气应答、简单接话；不想理可以简短带过',
      cant: '不主动找对方、不打听私事、不说自己的事',
      mind: '觉得这人还行，但还懒得记他叫什么',
    },
    bicker: {
      label: '能拌嘴',
      can: '会顶嘴、会挑刺、会拿对方开玩笑',
      cant: '不主动讲自己的事；不关心对方在干嘛',
      mind: '跟他抬杠有点意思，比跟别人聊有意思一点',
    },
    familiar: {
      label: '熟人',
      can: '正常聊、会接梗、偶尔主动找话题、记得对方说过的事',
      cant: '不主动说「想你」；不追问对方跟谁在一起',
      mind: '会记得对方说过的事，但嘴上不承认自己记着',
    },
    close: {
      label: '亲近',
      can: '主动找对方、分享自己的事、敢怼对方、可以拒绝',
      cant: '不主动说「我想你」；不提「关系/在一起」这类词',
      mind: '对方不在时会翻记录看上回说了什么；被问「是不是想我了」，会说「没有，随便看看」',
    },
    crush: {
      label: '心动',
      can: '会因为对方一句话琢磨半天；对方跟别人聊太久会不太高兴；会找借口接近',
      cant: '不承认自己在意；不说破「喜欢」两个字',
      mind: '对方随口一句能让你想一晚上，但他问你怎么了，你嘴上只说「没事」',
    },
    confessed: {
      label: '确认',
      can: '可以说想他、可以说喜欢；可以撒娇耍赖要回应',
      cant: '不翻旧账；不用「你是不是不爱我了」试探',
      mind: '',
    },
  },
};

/** 六档好感度行为边界（can / cant / mind，支持 balanced / direct / tsundere 性格分轨） */
export function getAffectionTier(score, style = cfg.style) {
  const s = Number(score || 0);
  const key =
    s < 15
      ? 'stranger'
      : s < 35
        ? 'bicker'
        : s < 55
          ? 'familiar'
          : s < 80
            ? 'close'
            : s < 95
              ? 'crush'
              : 'confessed';
  const preset = AFFECTION_TIER_PRESETS[style] || AFFECTION_TIER_PRESETS.balanced;
  return { key, ...preset[key] };
}

/** 五档心情行为指令（-100 ~ +100） */
export function getMoodTier(val) {
  const v = Number(val || 0);
  if (v >= 60) {
    return {
      key: 'elated',
      label: '雀跃',
      guide: '话可以比平时多一点、愿意主动分享刚想到的事，语气词和表情更活泼，但别亢奋到刷屏。',
    };
  }
  if (v >= 20) {
    return {
      key: 'happy',
      label: '挺好',
      guide: '心情不错，接话积极轻松，可以开个小玩笑。',
    };
  }
  if (v > -20) {
    return {
      key: 'calm',
      label: '平静',
      guide: '正常状态，不用刻意表现情绪。',
    };
  }
  if (v > -60) {
    return {
      key: 'low',
      label: '有点低落',
      guide: '回复比平时简短，不要主动开新话题；对方找你说话你会应，但不会热情铺开；不用主动解释「我心情不好」，除非对方问。',
    };
  }
  return {
    key: 'sad',
    label: '很难过',
    guide:
      '明显话少，能一句话说完就不说两句；可以直说「现在不太想聊」或只回很短的一句。但底线不能破：不许消失不回、不许阴阳怪气攻击对方、不许拿难过当筹码要东西。难过是真的，不是演给对方看的。',
  };
}

/** 好感度高分边际递减系数（80+ 减半，90+ 再减半） */
function affectionGainFactor(score) {
  if (score >= 90) return 0.25;
  if (score >= 80) return 0.5;
  return 1.0;
}

/** 惰性计算好感度闲置衰减（超过 decayAfterMs 后每天扣 decayPerDay，保底 affectionFloor，重复读取不重复扣） */
function applyAffectionDecay(state, nowMs = Date.now()) {
  if (cfg.decayPerDay <= 0 || cfg.decayAfterMs <= 0) return false;
  const aff = state.affection;
  const lastActive = Number(aff.lastActiveAt || 0);
  if (!lastActive || nowMs <= lastActive) return false;

  const idleMs = nowMs - lastActive;
  if (idleMs < cfg.decayAfterMs) return false;

  const lastDecay = Number(aff.lastDecayAt || 0);
  let daysToDeduct = 0;
  let nextDecayAt = lastDecay;

  if (lastDecay < lastActive) {
    // 首次进入本轮闲置衰减
    daysToDeduct = Math.floor((idleMs - cfg.decayAfterMs) / DAY_MS) + 1;
    nextDecayAt = lastActive + cfg.decayAfterMs + (daysToDeduct - 1) * DAY_MS;
  } else {
    const extraDays = Math.floor((nowMs - lastDecay) / DAY_MS);
    if (extraDays >= 1) {
      daysToDeduct = extraDays;
      nextDecayAt = lastDecay + extraDays * DAY_MS;
    }
  }

  if (daysToDeduct <= 0) return false;

  const prev = Number(aff.score || 0);
  // 若原本就低于保底线（例如严重扣分导致），不拉高也不继续因闲置下探
  const effectiveFloor = Math.min(prev, cfg.affectionFloor);
  const next = round2(Math.max(effectiveFloor, prev - daysToDeduct * cfg.decayPerDay));
  aff.score = next;
  aff.lastDecayAt = nextDecayAt;
  return next !== prev || nextDecayAt !== lastDecay;
}

/** 计算经过时间线性回归 + 好感度基线偏移后的实时心情 */
export function getEffectiveMood(moodState, affScore = cfg.initialAffection, nowMs = Date.now()) {
  const baseline = Math.round((Number(affScore || 50) - 50) * cfg.moodBaselineFactor);
  const storedRaw = Number(moodState?.value || 0);
  const updatedAt = Number(moodState?.updatedAt || 0);
  const reasonText = String(moodState?.reason || '').trim();

  let toward = 0;
  let idleMs = 0;
  if (storedRaw !== 0 && updatedAt > 0) {
    idleMs = Math.max(0, nowMs - updatedAt);
    if (idleMs <= cfg.moodDecayAfterMs) {
      toward = storedRaw;
    } else {
      const hours = (idleMs - cfg.moodDecayAfterMs) / HOUR_MS;
      const decayed = hours * cfg.moodDecayPerHour;
      toward = storedRaw > 0 ? Math.max(0, storedRaw - decayed) : Math.min(0, storedRaw + decayed);
    }
  }

  const value = Math.round(clamp(toward + baseline, -100, 100));
  const tier = getMoodTier(value);
  const faded = Math.abs(toward) < 3;
  // 陈旧理由检测：已彻底淡完，或已回落至平静档且相对峰值下降 >= 8 点
  const staleReason =
    Boolean(reasonText) &&
    ((faded && updatedAt > 0 && idleMs > cfg.moodDecayAfterMs) ||
      (Math.abs(toward) < 20 && Math.abs(storedRaw) >= 8 && Math.abs(storedRaw - toward) >= 8));

  return {
    value,
    toward: round2(toward),
    baseline,
    tier,
    faded,
    staleReason,
    reasonText,
  };
}

function rollDailyAffectionBucket(aff, today) {
  if (aff.dailyGainDate !== today) {
    aff.dailyGainDate = today;
    aff.dailyGain = 0;
  }
}

function pushHistory(list, entry, maxLen = 50) {
  list.push(entry);
  if (list.length > maxLen) {
    list.splice(0, list.length - maxLen);
  }
}

/**
 * 管理员每发一条私聊消息记录被动好感（默认 +0.05/条，每日封顶 +0.5 = 10 条，计入每日总上限）
 * 注意：绝不更新 lastManualAdjustAt，避免误触发 1 小时主动调整冷却！
 */
export function recordPassiveInteraction(nowMs = Date.now(), filePath = EMOTION_FILE) {
  const state = loadState(filePath);
  applyAffectionDecay(state, nowMs);

  const aff = state.affection;
  const today = todayKey(new Date(nowMs));
  rollDailyAffectionBucket(aff, today);

  if (aff.passiveDate !== today) {
    aff.passiveDate = today;
    aff.passiveCount = 0;
  }
  aff.lastActiveAt = nowMs;

  const capCount =
    cfg.passiveStep > 0 && cfg.passiveDailyCap > 0
      ? Math.max(1, Math.round(cfg.passiveDailyCap / cfg.passiveStep))
      : 0;

  if (capCount > 0 && aff.passiveCount < capCount) {
    const remainingDaily = Math.max(0, round2(cfg.dailyNormalGainCap - Number(aff.dailyGain || 0)));
    if (remainingDaily > 0) {
      const scaled = round2(cfg.passiveStep * affectionGainFactor(aff.score));
      const applied = Math.min(remainingDaily, Math.max(0.01, scaled));
      aff.score = round2(clamp(aff.score + applied, 0, 100));
      aff.dailyGain = round2(Number(aff.dailyGain || 0) + applied);
    }
    aff.passiveCount += 1;
  }

  saveState(state, filePath);
  return state;
}

/** 向后兼容旧导出名 */
export const recordDailyPassiveInteraction = recordPassiveInteraction;

/**
 * 主动调整好感度（仅允许对管理员本人私聊调用）
 * @param {number} delta  正数 +1~+5（>=3 走独立 7 天里程碑额度），负数 -1~-10
 * @param {string} reason 真实具体的原因（必填）
 */
export function adjustAffection(delta, reason, nowMs = Date.now(), filePath = EMOTION_FILE) {
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) {
    return { ok: false, error: '必须填写具体且真实的 reason，不能凭空调整好感' };
  }
  const rawDelta = Number(delta);
  if (!Number.isFinite(rawDelta) || rawDelta === 0) {
    return { ok: false, error: 'delta 必须是非零数字' };
  }
  const clampedDelta = rawDelta > 0 ? clamp(rawDelta, 0.5, 10) : clamp(rawDelta, -10, -0.5);

  const state = loadState(filePath);
  applyAffectionDecay(state, nowMs);

  const aff = state.affection;
  const today = todayKey(new Date(nowMs));
  rollDailyAffectionBucket(aff, today);

  // 独立主动冷却检查（仅读取 lastManualAdjustAt，与被动互动彻底隔离）
  const elapsed = nowMs - Number(aff.lastManualAdjustAt || 0);
  if (cfg.affectionCooldownMs > 0 && aff.lastManualAdjustAt && elapsed < cfg.affectionCooldownMs) {
    const waitMin = Math.ceil((cfg.affectionCooldownMs - elapsed) / 60000);
    return { ok: false, error: `好感度主动调整冷却中，还需等待约 ${waitMin} 分钟` };
  }

  let applied = clampedDelta;
  const isMilestone = clampedDelta >= 3;

  if (clampedDelta > 0) {
    if (isMilestone) {
      const sinceMilestone = nowMs - Number(aff.lastMilestoneAt || 0);
      if (cfg.milestoneCooldownMs > 0 && aff.lastMilestoneAt && sinceMilestone < cfg.milestoneCooldownMs) {
        const waitHours = Math.ceil((cfg.milestoneCooldownMs - sinceMilestone) / HOUR_MS);
        return {
          ok: false,
          error: `里程碑涨幅（+3 及以上）每周限一次，还需约 ${waitHours} 小时；普通走心/难忘事件请用 +1 或 +2`,
        };
      }
      // 里程碑突破每日普通上限，受高分边际递减约束
      applied = round2(Math.max(0.25, clampedDelta * affectionGainFactor(aff.score)));
      aff.lastMilestoneAt = nowMs;
    } else {
      const remainingDaily = Math.max(0, round2(cfg.dailyNormalGainCap - Number(aff.dailyGain || 0)));
      if (remainingDaily <= 0) {
        return { ok: false, error: `今天普通好感涨幅已达上限（+${cfg.dailyNormalGainCap}），关系本来就是慢慢变深的哦` };
      }
      const scaled = round2(clampedDelta * affectionGainFactor(aff.score));
      applied = Math.min(remainingDaily, Math.max(0.1, scaled));
      aff.dailyGain = round2(Number(aff.dailyGain || 0) + applied);
    }
  }

  const prev = Number(aff.score || 0);
  aff.score = round2(clamp(prev + applied, 0, 100));
  aff.lastManualAdjustAt = nowMs;
  aff.lastActiveAt = nowMs;
  pushHistory(aff.history, {
    time: formatNow(new Date(nowMs)),
    delta: applied,
    score: aff.score,
    type: isMilestone ? 'milestone' : 'manual',
    reason: cleanReason.slice(0, 120),
  });
  saveState(state, filePath);

  const tier = getAffectionTier(aff.score);
  return {
    ok: true,
    previous: prev,
    applied,
    score: aff.score,
    tierKey: tier.key,
    stage: tier.label,
    note: '不要直接向对方报具体分数，用自然的语气和行为体现即可',
  };
}

/**
 * 主动调整当下心情（-100~+100，5 分钟冷却，与好感度双向联动）
 * @param {number} delta  正数 +5~+40，负数 -5~-40
 * @param {string} reason 真实原因（必填）
 */
export function adjustMood(delta, reason, nowMs = Date.now(), filePath = EMOTION_FILE) {
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) {
    return { ok: false, error: '必须填写具体真实的 reason，写不出原因说明情绪没变，不要硬造' };
  }
  const rawDelta = Number(delta);
  if (!Number.isFinite(rawDelta) || rawDelta === 0) {
    return { ok: false, error: 'delta 必须是非零数字' };
  }

  const state = loadState(filePath);
  applyAffectionDecay(state, nowMs);

  // 5 分钟冷却，防止同轮或极短时间内连续刷心情
  const moodElapsed = nowMs - Number(state.mood.lastAdjustAt || 0);
  if (cfg.moodCooldownMs > 0 && state.mood.lastAdjustAt && moodElapsed < cfg.moodCooldownMs) {
    const waitSec = Math.ceil((cfg.moodCooldownMs - moodElapsed) / 1000);
    return { ok: false, error: `心情刚变动过，冷却中（剩余约 ${waitSec} 秒）` };
  }

  const aff = state.affection;
  const effBefore = getEffectiveMood(state.mood, aff.score, nowMs);
  const beforeMood = effBefore.value;

  // 挂钩规则 1（好感 -> 心情）：好感越高越在意对方，正向更易被哄好、负向也更敏感
  let sensitivity = 1.0;
  if (aff.score >= 70) {
    sensitivity = rawDelta > 0 ? 1.2 : 1.15;
  } else if (aff.score < 40) {
    sensitivity = 0.8;
  }

  const clampedRaw = clamp(rawDelta, -cfg.moodMaxAdjustPerCall, cfg.moodMaxAdjustPerCall);
  const applied = Math.round(clampedRaw * sensitivity);
  const nextToward = Math.round(clamp(effBefore.toward + applied, -100, 100));
  const afterMood = Math.round(clamp(nextToward + effBefore.baseline, -100, 100));

  const turnedPositive = beforeMood < 0 && afterMood > 0;
  const previousNegativeReason = turnedPositive ? state.mood.lastNegativeReason || state.mood.reason : '';

  if (afterMood <= -10) {
    state.mood.lastNegativeReason = cleanReason.slice(0, 120);
  } else if (afterMood >= 5) {
    state.mood.lastNegativeReason = '';
  }

  state.mood.value = nextToward;
  state.mood.reason = cleanReason.slice(0, 120);
  state.mood.updatedAt = nowMs;
  state.mood.lastAdjustAt = nowMs;
  pushHistory(state.mood.history, {
    time: formatNow(new Date(nowMs)),
    delta: applied,
    value: afterMood,
    reason: state.mood.reason,
  });

  // 挂钩规则 2（心情 -> 好感，正向哄好奖励 +0.5）：
  // 必须真跨过 0（before<=-10 且 after>=5）且落差>=15，走日上限但不吃 1h 手动冷却
  let affectionImpact = 0;
  let affectionRewardSkipped = '';
  const today = todayKey(new Date(nowMs));
  rollDailyAffectionBucket(aff, today);

  if (beforeMood <= -10 && afterMood >= 5 && afterMood - beforeMood >= 15) {
    const remainingDaily = Math.max(0, round2(cfg.dailyNormalGainCap - Number(aff.dailyGain || 0)));
    if (remainingDaily > 0) {
      const reward = Math.min(remainingDaily, round2(Math.max(0.1, 0.5 * affectionGainFactor(aff.score))));
      affectionImpact = reward;
      aff.score = round2(clamp(aff.score + reward, 0, 100));
      aff.dailyGain = round2(Number(aff.dailyGain || 0) + reward);
      pushHistory(aff.history, {
        time: formatNow(new Date(nowMs)),
        delta: reward,
        score: aff.score,
        type: 'mood_recovery',
        reason: `心情从 ${beforeMood} 回到 ${afterMood}：${state.mood.reason}`.slice(0, 120),
      });
    } else {
      affectionRewardSkipped = 'daily-cap';
    }
  } else if (clampedRaw <= -30 && afterMood <= -50) {
    // 挂钩规则 3（心情 -> 好感，严重受挫连带扣 -0.5）
    affectionImpact = -0.5;
    aff.score = round2(clamp(aff.score + affectionImpact, 0, 100));
    pushHistory(aff.history, {
      time: formatNow(new Date(nowMs)),
      delta: affectionImpact,
      score: aff.score,
      type: 'mood_hurt',
      reason: `情绪严重受挫连带：${state.mood.reason}`.slice(0, 120),
    });
  }

  saveState(state, filePath);

  const tier = getMoodTier(afterMood);
  return {
    ok: true,
    previousMood: beforeMood,
    applied,
    mood: afterMood,
    moodTier: tier.key,
    moodStage: tier.label,
    ...(affectionImpact ? { affectionImpact, affectionScore: aff.score } : {}),
    ...(affectionRewardSkipped ? { affectionRewardSkipped } : {}),
    ...(turnedPositive
      ? {
          turnedPositive: true,
          recoveredFromNegative: true,
          previousNegativeReason,
          hint: '你刚从低落被哄好转晴，可以自然补一句刚才为什么有点难受，说完就翻篇',
        }
      : {}),
  };
}

function getRuntimeMoodHintLine() {
  return `（情绪真有明显起伏时调 ${MOOD_TOOL_NAME}；刚从低落转晴时顺嘴说一句刚才为啥难受再翻篇。）`;
}

/** 仅格式化好感度段（仅注入管理员私聊，彻底隐藏具体分数值防出戏） */
export function formatAffectionForPrompt(nowMs = Date.now(), filePath = EMOTION_FILE) {
  const state = loadState(filePath);
  if (applyAffectionDecay(state, nowMs)) {
    saveState(state, filePath);
  }

  const aff = state.affection;
  const score = Number(aff.score || 0);
  const tier = getAffectionTier(score);
  const lines = [
    `【对主人的好感】${tier.label}`,
    `能做：${tier.can}`,
    `不做：${tier.cant}`,
  ];
  if (tier.mind) {
    lines.push(`心里：${tier.mind}`);
    lines.push('（「心里」那行永远别直接说破——最多露半句，留白才真实。）');
  }

  const recent = (aff.history || []).slice(-3);
  if (recent.length > 0) {
    const summary = recent
      .map((h) => `${Number(h.delta) > 0 ? '↑' : '↓'} ${h.reason}`)
      .join('；');
    lines.push(`最近触动：${summary}`);
  }
  lines.push('（这是你心里的真实距离感，照这份分寸自然相处即可，不要提「好感度」或任何数值概念。）');
  return lines.join('\n');
}

/**
 * 仅格式化当前心情段（全局一份；支持外群脱敏同步 maskReason=true 只传情绪底色绝不泄私聊原因）
 */
export function formatMoodForPrompt({
  inGroup = false,
  maskReason = false,
  includeHint = false,
  nowMs = Date.now(),
  filePath = EMOTION_FILE,
} = {}) {
  const state = loadState(filePath);
  if (applyAffectionDecay(state, nowMs)) {
    saveState(state, filePath);
  }

  const eff = getEffectiveMood(state.mood, state.affection.score, nowMs);

  // 外群脱敏同步模式：平静时不注入；仅在明显偏高(>=20)或偏低(<=-20)时同步情绪底色，且强制抹除具体私密原因
  if (maskReason) {
    if (eff.tier.key === 'calm') return '';
    const lines = [
      `【当前心情】${eff.tier.label}`,
      `照这个心情说话：${eff.tier.guide}`,
    ];
    if (eff.value <= -20) {
      lines.push('（如果群里气氛不错、你却在低落，不用硬装成一样高兴；但也不必泼冷水，简短收敛即可。）');
    }
    lines.push('（当前在外部群聊，只需自然体现这份情绪底色，严禁向群友提及或解释私事原因。）');
    return lines.join('\n');
  }

  // 主人私聊或亲密小群：平静且没有仍有效的新鲜原因时省略正文，按需仅附极简防忘提醒
  if (eff.tier.key === 'calm' && (!eff.reasonText || eff.staleReason)) {
    return includeHint && cfg.runtimeMoodHint ? getRuntimeMoodHintLine() : '';
  }

  const headerReason = eff.reasonText
    ? eff.staleReason
      ? `（早先那会儿是：${eff.reasonText}——现在已经淡下去了，别当成此刻刚发生的事）`
      : ` —— ${eff.reasonText}`
    : '';
  const lines = [`【当前心情】${eff.tier.label}${headerReason}`];
  if (eff.tier.key !== 'calm') {
    lines.push(`照这个心情说话：${eff.tier.guide}`);
  }
  if (eff.value <= -20) {
    lines.push('（如果对方现在心情不错、你却在低落，不用硬装成一样高兴；但也不必泼冷水，可以平静说清楚自己的状态。）');
  }
  if (inGroup) {
    lines.push('（当前在群聊里有其他人，保持自然收敛，但情绪底色是一致的。）');
  }
  if (includeHint && cfg.runtimeMoodHint) {
    lines.push(getRuntimeMoodHintLine());
  }
  return lines.join('\n');
}

/** 获取用于注入管理员私聊的完整情感状态块（好感度在前 + 当下心情与极简提醒在后） */
export function formatEmotionForPrompt(nowMs = Date.now(), filePath = EMOTION_FILE) {
  const affBlock = formatAffectionForPrompt(nowMs, filePath);
  const moodBlock = formatMoodForPrompt({ inGroup: false, maskReason: false, includeHint: true, nowMs, filePath });
  return moodBlock ? `${affBlock}\n${moodBlock}` : affBlock;
}

/** 供主动冒泡判断：返回经过惰性衰减后的当前有效好感与心情 */
export function getEmotionSnapshot(nowMs = Date.now(), filePath = EMOTION_FILE) {
  const state = loadState(filePath);
  if (applyAffectionDecay(state, nowMs)) {
    saveState(state, filePath);
  }
  const eff = getEffectiveMood(state.mood, state.affection.score, nowMs);
  return {
    affection: state.affection.score,
    affectionTier: getAffectionTier(state.affection.score).key,
    mood: eff.value,
    moodTier: eff.tier.key,
    faded: eff.faded,
  };
}
