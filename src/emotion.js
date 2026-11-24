/**
 * 情感状态引擎：好感度（长期关系）与心情（即时情绪）双向挂钩系统
 *
 * 持久化位置：state/emotion.json（仅针对主人 ownerId 生效，绝不泄露给外部群聊）
 *
 * 设计核心：
 *   1. 好感度（0~100，默认 50）：长期关系深浅，涨得慢、可涨可跌：
 *      - 每日正常私聊自动被动 +0.5（不占用手动上限）；
 *      - 主动调整受 1 小时冷却、普通日上限 +2、里程碑（+3~+5）每天最多一次、80+/90+ 衰减约束。
 *   2. 心情（-50~+50，默认 0）：当下情绪，按 4 小时半衰期自然回归平静：
 *      - 从明显低落（<-5）被哄好转为正向（>=5）时，返回上次低落原因，便于角色自然说开并翻篇。
 *   3. 双向挂钩：
 *      - 好感度 -> 心情：好感越高越在意主人（>=70 时正涨幅 ×1.2、负冲击 ×1.15；<40 时波动 ×0.8）；
 *      - 心情 -> 好感度：被严重伤到（单次 <=-20 且落到 <=-25）会顺带轻微扣减好感 -0.5；
 *        主动冒泡也会参考当前心情（极低落时不强行活跃）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { formatNow } from './memory.js';

const STATE_DIR = path.resolve(process.cwd(), 'state');
const EMOTION_FILE = path.join(STATE_DIR, 'emotion.json');

let moodHalfLifeHours = 4.0;
let affectionCooldownMs = 60 * 60 * 1000; // 1 小时
let milestoneCooldownMs = 24 * 60 * 60 * 1000; // 1 天（一天最多一次里程碑）
let dailyNormalGainCap = 2.0;

/** 应用来自 config.json -> emotion 的情感参数 */
export function configureEmotion({
  moodHalfLifeHours: halfLife,
  affectionCooldownMinutes,
  milestoneCooldownHours,
  dailyNormalGainCap: gainCap,
} = {}) {
  if (Number.isFinite(Number(halfLife)) && Number(halfLife) > 0) {
    moodHalfLifeHours = Number(halfLife);
  }
  if (Number.isFinite(Number(affectionCooldownMinutes)) && Number(affectionCooldownMinutes) >= 0) {
    affectionCooldownMs = Math.round(Number(affectionCooldownMinutes) * 60 * 1000);
  }
  if (Number.isFinite(Number(milestoneCooldownHours)) && Number(milestoneCooldownHours) >= 0) {
    milestoneCooldownMs = Math.round(Number(milestoneCooldownHours) * 3600 * 1000);
  }
  if (Number.isFinite(Number(gainCap)) && Number(gainCap) > 0) {
    dailyNormalGainCap = Number(gainCap);
  }
}

function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function defaultState() {
  return {
    affection: {
      score: 50,
      dailyGainDate: '',
      dailyGain: 0,
      lastAdjustAt: 0,
      lastMilestoneAt: 0,
      lastPassiveDate: '',
      history: [],
    },
    mood: {
      value: 0,
      reason: '',
      updatedAt: 0,
      lastNegativeReason: '',
      history: [],
    },
  };
}

export function getEmotionFilePath() {
  return EMOTION_FILE;
}

export function ensureEmotionFile() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (!fs.existsSync(EMOTION_FILE)) {
    fs.writeFileSync(EMOTION_FILE, `${JSON.stringify(defaultState(), null, 2)}\n`, 'utf8');
    return false;
  }
  return true;
}

function loadState() {
  ensureEmotionFile();
  try {
    const raw = JSON.parse(fs.readFileSync(EMOTION_FILE, 'utf8'));
    const base = defaultState();
    return {
      affection: { ...base.affection, ...(raw.affection || {}) },
      mood: { ...base.mood, ...(raw.mood || {}) },
    };
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(EMOTION_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function round1(val) {
  return Math.round(val * 10) / 10;
}

/** 计算经过时间衰减后的实时心情值 */
export function getEffectiveMood(moodState, nowMs = Date.now()) {
  const raw = Number(moodState?.value || 0);
  const updatedAt = Number(moodState?.updatedAt || 0);
  if (!raw || !updatedAt) return { value: 0, faded: true };
  const hours = Math.max(0, (nowMs - updatedAt) / 3600000);
  const decayed = raw * Math.pow(0.5, hours / moodHalfLifeHours);
  if (Math.abs(decayed) < 3) {
    return { value: 0, faded: true };
  }
  return { value: Math.round(decayed), faded: false };
}

function affectionLabel(score) {
  if (score >= 90) return '满心满眼、极度依恋';
  if (score >= 80) return '心动偏爱、很黏人';
  if (score >= 65) return '非常信任依赖、敢撒娇敢互怼';
  if (score >= 45) return '熟络亲近、自然轻松';
  if (score >= 25) return '普通熟人、客气略克制';
  return '有点疏远防备、话少偏冷';
}

function moodLabel(val) {
  if (val >= 25) return '超级开心雀跃（话可以多一点、轻快活泼）';
  if (val >= 10) return '心情不错（放松愉悦）';
  if (val <= -25) return '很难过或气鼓鼓（话短、收起玩笑，但不冷暴力不攻击）';
  if (val <= -10) return '有点低落或小委屈（话少一点、不主动开新话题）';
  return '平静自然';
}

/** 好感度高分衰减系数（80+ 减半，90+ 再减半） */
function affectionGainFactor(score) {
  if (score >= 90) return 0.25;
  if (score >= 80) return 0.5;
  return 1.0;
}

/** 每日与主人正常私聊一次自动记录被动好感 +0.5 */
export function recordDailyPassiveInteraction() {
  const state = loadState();
  const today = todayKey();
  if (state.affection.lastPassiveDate === today) return state;

  if (state.affection.dailyGainDate !== today) {
    state.affection.dailyGainDate = today;
    state.affection.dailyGain = 0;
  }

  const gain = round1(0.5 * affectionGainFactor(state.affection.score));
  state.affection.score = round1(clamp(state.affection.score + gain, 0, 100));
  state.affection.lastPassiveDate = today;
  saveState(state);
  return state;
}

/**
 * 主动调整好感度（仅允许对主人本人私聊调用）
 * @param {number} delta  正数 +1~+5，负数 -1~-8
 * @param {string} reason 真实具体的原因（必填）
 */
export function adjustAffection(delta, reason) {
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) {
    return { ok: false, error: '必须填写具体且真实的 reason，不能凭空调整好感' };
  }
  const rawDelta = Number(delta);
  if (!Number.isFinite(rawDelta) || rawDelta === 0) {
    return { ok: false, error: 'delta 必须是非零数字' };
  }
  const clampedDelta = rawDelta > 0 ? clamp(rawDelta, 0.5, 5) : clamp(rawDelta, -8, -0.5);

  const state = loadState();
  const now = Date.now();
  const today = todayKey();

  if (state.affection.dailyGainDate !== today) {
    state.affection.dailyGainDate = today;
    state.affection.dailyGain = 0;
  }

  // 冷却限制
  const elapsed = now - Number(state.affection.lastAdjustAt || 0);
  if (affectionCooldownMs > 0 && state.affection.lastAdjustAt && elapsed < affectionCooldownMs) {
    const waitMin = Math.ceil((affectionCooldownMs - elapsed) / 60000);
    return { ok: false, error: `好感度冷却中，还需等待约 ${waitMin} 分钟再主动调整` };
  }

  let applied = clampedDelta;
  const isMilestone = clampedDelta >= 3;

  if (clampedDelta > 0) {
    if (isMilestone) {
      const sinceMilestone = now - Number(state.affection.lastMilestoneAt || 0);
      if (milestoneCooldownMs > 0 && state.affection.lastMilestoneAt && sinceMilestone < milestoneCooldownMs) {
        return {
          ok: false,
          error: '里程碑涨幅（+3 及以上）仍在冷却中，普通暖心事件请用 +1 或 +2',
        };
      }
      applied = round1(clampedDelta * affectionGainFactor(state.affection.score));
      state.affection.lastMilestoneAt = now;
    } else {
      const remainingDaily = Math.max(0, round1(dailyNormalGainCap - state.affection.dailyGain));
      if (remainingDaily <= 0) {
        return { ok: false, error: `今天普通好感涨幅已达上限（+${dailyNormalGainCap}），关系本来就是慢慢变深的哦` };
      }
      const scaled = round1(clampedDelta * affectionGainFactor(state.affection.score));
      applied = Math.min(remainingDaily, Math.max(0.1, scaled));
      state.affection.dailyGain = round1(state.affection.dailyGain + applied);
    }
  }

  const prev = state.affection.score;
  state.affection.score = round1(clamp(prev + applied, 0, 100));
  state.affection.lastAdjustAt = now;
  state.affection.history.push({
    time: formatNow(),
    delta: applied,
    score: state.affection.score,
    reason: cleanReason.slice(0, 120),
  });
  if (state.affection.history.length > 50) {
    state.affection.history.splice(0, state.affection.history.length - 50);
  }
  saveState(state);

  return {
    ok: true,
    previous: prev,
    applied,
    score: state.affection.score,
    stage: affectionLabel(state.affection.score),
    note: '不要直接向对方报具体分数，用自然的语气和行为体现即可',
  };
}

/**
 * 主动调整当下心情（与好感度双向挂钩）
 * @param {number} delta  正数 +5~+25，负数 -5~-30
 * @param {string} reason 真实原因（必填）
 */
export function adjustMood(delta, reason) {
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) {
    return { ok: false, error: '必须填写具体真实的 reason，写不出原因说明情绪没变，不要硬造' };
  }
  const rawDelta = Number(delta);
  if (!Number.isFinite(rawDelta) || rawDelta === 0) {
    return { ok: false, error: 'delta 必须是非零数字' };
  }

  const state = loadState();
  const now = Date.now();
  const eff = getEffectiveMood(state.mood, now);
  const prevMood = eff.value;
  const affScore = state.affection.score;

  // 挂钩规则 1（好感 -> 心情）：好感越高越在意对方，正向更易被哄好、负向也更敏感
  let sensitivity = 1.0;
  if (affScore >= 70) {
    sensitivity = rawDelta > 0 ? 1.2 : 1.15;
  } else if (affScore < 40) {
    sensitivity = 0.8;
  }

  const applied = Math.round(clamp(rawDelta, -30, 30) * sensitivity);
  const nextMood = Math.round(clamp(prevMood + applied, -50, 50));

  const recoveredFromNegative = prevMood <= -5 && nextMood >= 5;
  const previousNegativeReason = recoveredFromNegative ? state.mood.lastNegativeReason || state.mood.reason : '';

  if (nextMood <= -5) {
    state.mood.lastNegativeReason = cleanReason.slice(0, 120);
  } else if (nextMood >= 5) {
    state.mood.lastNegativeReason = '';
  }

  state.mood.value = nextMood;
  state.mood.reason = cleanReason.slice(0, 120);
  state.mood.updatedAt = now;
  state.mood.history.push({
    time: formatNow(),
    delta: applied,
    value: nextMood,
    reason: state.mood.reason,
  });
  if (state.mood.history.length > 50) {
    state.mood.history.splice(0, state.mood.history.length - 50);
  }

  // 挂钩规则 2（心情 -> 好感）：被严重伤到（单次 <= -20 且心情跌至 <= -25）轻微连带扣好感 -0.5
  let affectionImpact = 0;
  if (rawDelta <= -20 && nextMood <= -25) {
    affectionImpact = -0.5;
    state.affection.score = round1(clamp(state.affection.score + affectionImpact, 0, 100));
    state.affection.history.push({
      time: formatNow(),
      delta: affectionImpact,
      score: state.affection.score,
      reason: `情绪严重受挫连带：${state.mood.reason}`,
    });
    if (state.affection.history.length > 50) {
      state.affection.history.splice(0, state.affection.history.length - 50);
    }
  }

  saveState(state);

  return {
    ok: true,
    previousMood: prevMood,
    applied,
    mood: nextMood,
    moodStage: moodLabel(nextMood),
    ...(affectionImpact ? { affectionImpact, affectionScore: state.affection.score } : {}),
    ...(recoveredFromNegative
      ? {
          recoveredFromNegative: true,
          previousNegativeReason,
          hint: '你刚从低落被哄好转晴，可以自然补一句刚才为什么有点难受，说完就翻篇',
        }
      : {}),
  };
}

/** 获取用于注入主人私聊提示的状态摘要行（绝不注入陌生群聊） */
export function formatEmotionForPrompt() {
  const state = loadState();
  const aff = state.affection.score;
  const eff = getEffectiveMood(state.mood);

  let moodText;
  if (eff.faded) {
    moodText = state.mood.reason
      ? `平静自然（早先曾因「${state.mood.reason}」有波动，现在已经淡下去了，别再提它）`
      : '平静自然';
  } else {
    moodText = `${eff.value > 0 ? '+' : ''}${eff.value}（${moodLabel(eff.value)}；原因：${state.mood.reason || '日常波动'}）`;
  }

  return `[内部情感状态（勿直接报数字，照此语气说话）] 对主人的好感：${aff}（${affectionLabel(aff)}） | 当前心情：${moodText}`;
}

/** 供主动冒泡判断：返回当前有效心情与好感度 */
export function getEmotionSnapshot() {
  const state = loadState();
  const eff = getEffectiveMood(state.mood);
  return {
    affection: state.affection.score,
    mood: eff.value,
    faded: eff.faded,
  };
}
