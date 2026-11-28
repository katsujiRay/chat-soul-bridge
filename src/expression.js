/**
 * 动态表情包（meme）与原生小黄脸 / Emoji 触发引擎（src/expression.js）
 *
 * 设计核心（按需动态判断，拒绝每轮硬塞清单或刷屏）：
 *   1. 原生小黄脸双向解析（OneBot v11 `{ type: 'face', data: { id } }`）：
 *      - 收消息时把常见小黄脸 ID 转成 `[doge]`、`[吃瓜]` 等可读短码，让模型看懂对方表情；
 *      - 发消息时把模型写的 `[doge]`、`[捂脸]` 等短码自动转为真正的小黄脸段发送。
 *   2. 零轮次内联发图 `[meme:名字]`：
 *      - 模型只需在回复末尾顺手写 `[meme:文件名]`，桥接剥离标签后自动从 `tools/meme/` 发送真图，
 *        不额外消耗工具轮次，也不污染 `state/context.db`。
 *   3. 动态判断「这一句需不需要发 meme 或 emoji」（0ms、0 额外 LLM 成本）：
 *      - 严肃/报错/求助/极低落场景自动静音（0 字节不注入）；
 *      - 结合本会话发图冷却 + 当前消息情绪/梗词与 `tools/meme/` 标签匹配度动态算概率；
 *      - 只有命中时才临时把最贴切的几张备选表情包或小黄脸建议注入当轮，其余轮次 0 字节不占 token。
 */
import path from 'node:path';
import { listLocalMemes } from './meme.js';

// ── 精选高频标准 OneBot v11 小黄脸映射（face id） ────────────────────────────
export const FACE_NAME_TO_ID = {
  微笑: '14',
  撇嘴: '1',
  色: '2',
  发呆: '3',
  得意: '4',
  流泪: '5',
  害羞: '6',
  闭嘴: '7',
  睡: '8',
  大哭: '9',
  尴尬: '10',
  发怒: '11',
  调皮: '12',
  呲牙: '13',
  惊讶: '0',
  难过: '15',
  偷笑: '20',
  可爱: '21',
  白眼: '22',
  傲慢: '23',
  困: '25',
  惊恐: '26',
  流汗: '27',
  憨笑: '28',
  疑问: '32',
  嘘: '33',
  晕: '34',
  敲打: '38',
  再见: '39',
  擦汗: '97',
  抠鼻: '98',
  委屈: '106',
  坏笑: '107',
  阴险: '108',
  亲亲: '109',
  快哭了: '110',
  可怜: '111',
  爱心: '66',
  点赞: '76',
  抱拳: '118',
  ok: '124',
  OK: '124',
  斜眼笑: '178',
  滑稽: '178',
  doge: '179',
  狗头: '179',
  笑哭: '182',
  捂脸: '264',
  裂开: '265',
  吃瓜: '271',
  加油: '272',
  暗中观察: '277',
  沧桑: '285',
  破涕为笑: '289',
  无语: '297',
  牛: '299',
  摸头: '318',
  比心: '319',
};

export const FACE_ID_TO_NAME = {};
for (const [name, id] of Object.entries(FACE_NAME_TO_ID)) {
  if (!FACE_ID_TO_NAME[id]) {
    FACE_ID_TO_NAME[id] = name;
  }
}

/** 收消息时将 OneBot face id 转为可读短码（如 179 -> [doge]） */
export function formatIncomingFace(faceId) {
  const id = String(faceId ?? '').trim();
  if (!id) return '';
  const name = FACE_ID_TO_NAME[id];
  return name ? `[${name}]` : `[表情:${id}]`;
}

/**
 * 将回复文本中的 `[doge]` / `[吃瓜]` 等原生小黄脸短码拆分为 OneBot v11 消息段数组；
 * 若不含任何已知小黄脸且无需引用，直接返回原始字符串（保持向后兼容）。
 */
export function buildOneBotMessageWithFaces(text, { replyId = '', enableFace = true } = {}) {
  const str = String(text || '');
  const segments = [];
  if (replyId && /^-?\d+$/.test(String(replyId))) {
    segments.push({ type: 'reply', data: { id: String(replyId) } });
  }

  if (!enableFace) {
    if (segments.length === 0) return str;
    segments.push({ type: 'text', data: { text: str } });
    return segments;
  }

  const faceRe = /\[([\u4e00-\u9fa5A-Za-z]{1,8})\]/g;
  let lastIdx = 0;
  let matchedFace = false;
  let m;
  while ((m = faceRe.exec(str))) {
    const label = m[1];
    const faceId = FACE_NAME_TO_ID[label] || FACE_NAME_TO_ID[label.toLowerCase()];
    if (!faceId) continue;
    matchedFace = true;
    if (m.index > lastIdx) {
      segments.push({ type: 'text', data: { text: str.slice(lastIdx, m.index) } });
    }
    segments.push({ type: 'face', data: { id: faceId } });
    lastIdx = m.index + m[0].length;
  }

  if (!matchedFace) {
    if (segments.length === 0) return str;
    segments.push({ type: 'text', data: { text: str } });
    return segments;
  }

  if (lastIdx < str.length) {
    segments.push({ type: 'text', data: { text: str.slice(lastIdx) } });
  }
  return segments;
}

// ── 零轮次内联发图标签 `[meme:名字]` 解析与模糊匹配 ────────────────────────────

const INLINE_MEME_RE = /\[(?:meme|sticker|表情包)\s*[:：]\s*([^\]]+?)\]/gi;

/** 提取文本里的 `[meme:xxx]` 标签（最多 1 张防刷屏），同时返回剥离标签后的干净纯文本 */
export function extractInlineMemeDirectives(text) {
  const raw = String(text || '');
  const queries = [];
  const cleaned = raw
    .replace(INLINE_MEME_RE, (_, q) => {
      const cleanQ = String(q || '').trim();
      if (cleanQ && queries.length < 1) queries.push(cleanQ);
      return '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: cleaned, memeQueries: queries };
}

/** 仅用于剥离落盘文本中的 `[meme:...]` 标记，避免污染 state/context.db */
export function stripInlineMemeTag(text) {
  return extractInlineMemeDirectives(text).text;
}

/** 按文件名、去后缀名、描述或标签匹配本地 `tools/meme/` 中的具体文件 */
export function resolveLocalMemeFilename(memeDir, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return '';
  const { memes } = listLocalMemes(memeDir, { limit: 50 });
  if (!Array.isArray(memes) || memes.length === 0) return '';

  for (const m of memes) {
    const fn = String(m.filename || '');
    const stem = path.basename(fn, path.extname(fn));
    if (fn.toLowerCase() === q || stem.toLowerCase() === q) return fn;
  }
  let best = '';
  let bestScore = 0;
  for (const m of memes) {
    const fn = String(m.filename || '');
    const stem = path.basename(fn, path.extname(fn)).toLowerCase();
    const desc = String(m.desc || '').toLowerCase();
    const tags = (m.tags || []).map((t) => String(t).toLowerCase());
    let score = 0;
    if (stem.includes(q) || q.includes(stem)) score += 5;
    if (tags.some((t) => t === q || t.includes(q) || q.includes(t))) score += 4;
    if (desc.includes(q)) score += 2;
    if (score > bestScore) {
      bestScore = score;
      best = fn;
    }
  }
  return bestScore > 0 ? best : '';
}

// ── 动态情绪/场景判断：本轮需不需要推 meme 或 emoji ─────────────────────────────

const SERIOUS_OR_DISTRESS_RE =
  /(?:报错|异常|bug|代码|怎么修|帮我写|翻译|计算|攻略|教程|难受|崩溃|烦死了|累死了|委屈|生病|发烧|住院|吵架|分手|去世|焦虑|失眠|加班到|压力好大|帮我查)/i;

const EXPLICIT_MEME_ASK_RE = /(?:表情包|斗图|发个图|发张表情|来张图|贴纸)/i;

const SCENE_TO_TAG_HINTS = [
  { re: /[?？]{1,}|啥意思|什么意思|不懂|疑惑|啊这|啊\?|哈\?|真的假的|尊嘟假嘟/, tags: ['问号', '疑惑', '懵', '问'] },
  { re: /哈哈|笑死|xswl|草生|乐死|看好戏|吃瓜|乐子|活该|打脸|翻车|嘲笑/, tags: ['笑', '看戏', '嘲笑', '吃瓜', '得意', '乐'] },
  { re: /零食|炸鸡|开心|太棒|好耶|赢麻|厉害|牛逼|夸我|炫耀|全归/, tags: ['开心', '得意', '炫耀', '可爱', '好耶'] },
  { re: /无语|离谱|离大谱|裂开|汗流浃背|红温|破防|绷不住|下头/, tags: ['无语', '裂开', '汗', '吐槽', '白眼'] },
  { re: /呜呜|委屈|求饶|对不起|原谅|贴贴|撒娇|抱抱|摸头/, tags: ['委屈', '可爱', '撒娇', '可怜', '卖萌'] },
];

const chatTurnCounter = new Map();
const lastMemeSentTurn = new Map();
const lastMemeSentAt = new Map();
const lastEmojiHintTurn = new Map();

export function recordMemeSent(chatKey) {
  const key = String(chatKey || '');
  if (!key) return;
  lastMemeSentTurn.set(key, chatTurnCounter.get(key) || 0);
  lastMemeSentAt.set(key, Date.now());
}

function pickRelevantMemes(memeDir, rawText, slangHits = [], maxSuggest = 6) {
  const { memes } = listLocalMemes(memeDir, { limit: 50 });
  if (!Array.isArray(memes) || memes.length === 0) return { items: [], matchedTag: false };

  const targetTags = new Set();
  const text = String(rawText || '');
  for (const rule of SCENE_TO_TAG_HINTS) {
    if (rule.re.test(text)) {
      for (const t of rule.tags) targetTags.add(t);
    }
  }
  if (Array.isArray(slangHits) && slangHits.length > 0) {
    targetTags.add('笑');
    targetTags.add('看戏');
    targetTags.add('得意');
    targetTags.add('吐槽');
  }

  const scored = memes.map((m) => {
    const stem = path.basename(m.filename, path.extname(m.filename));
    const hay = `${stem} ${m.desc || ''} ${(m.tags || []).join(' ')}`.toLowerCase();
    let score = 0;
    for (const t of targetTags) {
      if (hay.includes(t.toLowerCase())) score += 2;
    }
    const spans = text.match(/[\u4e00-\u9fa5]{2,}/g) || [];
    for (const sp of spans) {
      if (sp.length >= 2 && hay.includes(sp.slice(0, 3).toLowerCase())) {
        score += 3;
        break;
      }
    }
    return { ...m, stem, score };
  });

  scored.sort((a, b) => b.score - a.score || (b.tags?.length || 0) - (a.tags?.length || 0));
  const picked = [];
  const seenKey = new Set();
  for (const item of scored) {
    const normDesc = String(item.desc || item.stem).replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '').slice(0, 12);
    if (normDesc && seenKey.has(normDesc)) continue;
    if (normDesc) seenKey.add(normDesc);
    picked.push(item);
    if (picked.length >= Math.max(1, Number(maxSuggest) || 6)) break;
  }

  return { items: picked, matchedTag: picked.some((p) => p.score > 0) };
}

/**
 * 动态判断本轮回复需不需要发 meme 或点缀 emoji / 原生小黄脸。
 * 不需要时返回空字符串（0 字节不占 token），需要时返回极简 1~2 行当轮提示。
 */
export function decideExpressionHint({
  chatKey,
  rawText = '',
  slangHits = [],
  mood = 0,
  memeDir = '',
  expressionConfig = {},
  isProactive = false,
} = {}) {
  if (expressionConfig?.enabled === false) return '';
  const key = String(chatKey || '');
  const turn = (chatTurnCounter.get(key) || 0) + 1;
  chatTurnCounter.set(key, turn);

  const text = String(rawText || '').trim();
  const explicitAsk = !isProactive && EXPLICIT_MEME_ASK_RE.test(text);

  if (!explicitAsk && (Number(mood) <= -40 || (!isProactive && SERIOUS_OR_DISTRESS_RE.test(text)))) {
    return '';
  }

  const lines = [];
  const memeEnabled = expressionConfig?.memeEnabled !== false && Boolean(memeDir);
  if (memeEnabled) {
    const cooldownTurns = Math.max(0, Number(expressionConfig?.memeCooldownTurns ?? 3));
    const cooldownMs = Math.max(0, Number(expressionConfig?.memeCooldownMs ?? 120000));
    const prevTurn = lastMemeSentTurn.get(key) ?? -999;
    const prevAt = lastMemeSentAt.get(key) || 0;
    const coolReady =
      explicitAsk || isProactive || (turn - prevTurn >= cooldownTurns && Date.now() - prevAt >= cooldownMs);

    if (coolReady) {
      const { items, matchedTag } = pickRelevantMemes(
        memeDir,
        text,
        slangHits,
        expressionConfig?.maxSuggestMemes ?? 6
      );
      if (items.length > 0) {
        const baseChance = Math.max(0, Math.min(1, Number(expressionConfig?.memeBaseChance ?? 0.28)));
        const boost = Math.max(0, Math.min(1, Number(expressionConfig?.memeTagMatchBoost ?? 0.45)));
        const chance = explicitAsk
          ? 1
          : isProactive
            ? Math.min(0.65, baseChance + 0.15 + (matchedTag ? 0.15 : 0))
            : Math.min(0.85, baseChance + (matchedTag ? boost : 0));
        if (Math.random() < chance) {
          const listStr = items
            .map((m) => {
              const brief = (m.tags && m.tags.length > 0 ? m.tags.slice(0, 3).join('/') : m.desc || '').slice(0, 18);
              return brief ? `${m.stem}(${brief})` : m.stem;
            })
            .join('、');
          const proExtra = isProactive ? '（主动破冰时也可以只丢 1 句短话配图，或者直接单丢一张贴景表情包）' : '';
          lines.push(
            `【本轮适合顺手配张表情包（可选）】兜里有：${listStr}。若觉得贴景，直接在回复最后写 [meme:名字]（如 [meme:${items[0].stem}]）即可顺手发出真图，不贴景就别硬发${proExtra}。`
          );
        }
      }
    }
  }

  const emojiChance = Math.max(0, Math.min(1, Number(expressionConfig?.emojiChance ?? 0.38)));
  const lastEmojiTurn = lastEmojiHintTurn.get(key) ?? -999;
  const hasFunVibe =
    isProactive ||
    (Array.isArray(slangHits) && slangHits.length > 0) ||
    SCENE_TO_TAG_HINTS.some((r) => r.re.test(text));
  const effEmojiChance = Math.min(0.75, emojiChance + (hasFunVibe ? 0.2 : 0));

  if ((isProactive || turn - lastEmojiTurn >= 2) && Math.random() < effEmojiChance) {
    lastEmojiHintTurn.set(key, turn);
    const facePart =
      expressionConfig?.faceEnabled !== false
        ? '或原生小黄脸短码（如 [doge] [吃瓜] [笑哭] [捂脸] [委屈] [得意] [偷笑] [白眼] [摸头]）'
        : '';
    lines.push(
      `【表情点缀（可选）】这句气氛挺合适，可以顺手带 1 个贴合语气的 emoji（如 😏😭🤣🐱✨）${facePart}，最多 1 个别刷屏。`
    );
  }

  return lines.join('\n');
}
