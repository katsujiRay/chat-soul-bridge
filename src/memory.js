/**
 * 轻量记忆、每日 Markdown 日记本与群聊近期消息缓存
 *
 * 职责划分：
 *   - state/memory.json ：长期小本本（喜好、约定、群友印象），跨 /reset 永久保留，会热注入系统提示词；
 *   - tools/Diary/*.md  ：角色专属日记文件夹（按天生成 YYYY-MM-DD.md，同步写入 state/memory.db 的 diary_chunk）；
 *   - recentBuffers     ：内存环形缓存（每会话最多 30 条），用于群聊唤醒时附带现场上下文。
 */
import fs from 'node:fs';
import path from 'node:path';

const STATE_DIR = path.resolve(process.cwd(), 'state');
const MEMORY_FILE = path.join(STATE_DIR, 'memory.json');
const LEGACY_DIARY_FILE = path.join(STATE_DIR, 'diary.json');
const DEFAULT_DIARY_DIR = path.resolve(process.cwd(), 'tools', 'Diary');

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch {}
  return fallback;
}

function writeJson(file, data) {
  ensureStateDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

/** 格式化当前时间为易读中文时间戳（含星期与时段，供模型感知昼夜节奏） */
export function formatNow(date = new Date()) {
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const h = date.getHours();
  const period =
    h < 6 ? '凌晨' : h < 9 ? '早上' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜';
  return `${y}-${m}-${d} ${days[date.getDay()]} ${hh}:${mm} ${period}`;
}

// 长期记忆（跨 /reset 永久保留）
export function loadMemories() {
  return readJson(MEMORY_FILE, {});
}

export function saveMemory(key, value) {
  const memories = loadMemories();
  memories[String(key).trim()] = {
    value: String(value).trim(),
    updatedAt: formatNow(),
  };
  writeJson(MEMORY_FILE, memories);
  return memories;
}

export function deleteMemory(key) {
  const memories = loadMemories();
  const existed = Object.prototype.hasOwnProperty.call(memories, key);
  delete memories[key];
  writeJson(MEMORY_FILE, memories);
  return existed;
}

export function formatMemoriesForPrompt() {
  const entries = Object.entries(loadMemories());
  if (entries.length === 0) return '';
  const lines = entries.slice(-30).map(([k, v]) => `- ${k}: ${v.value}（记于 ${v.updatedAt}）`);
  return `\n\n【长期小本本记忆】\n${lines.join('\n')}`;
}

// 日记本（按天存为 tools/Diary/YYYY-MM-DD.md，人类可直接打开翻阅，同时向下兼容旧版 state/diary.json）
export function ensureDiaryDir(diaryDir = DEFAULT_DIARY_DIR) {
  const dir = path.resolve(diaryDir || DEFAULT_DIARY_DIR);
  const existed = fs.existsSync(dir);
  if (!existed) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return existed;
}

function parseDiaryMarkdown(fileName, rawText) {
  const text = String(rawText || '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];

  const baseName = fileName.replace(/\.(md|txt)$/i, '');
  const headingRegex = /^##\s+(.+)$/gm;
  const matches = [...text.matchAll(headingRegex)];

  if (matches.length === 0) {
    const body = text.replace(/^#\s+[^\n]*\n?/, '').trim();
    return body ? [{ time: baseName, file: fileName, content: body }] : [];
  }

  const entries = [];
  for (let i = 0; i < matches.length; i++) {
    const heading = matches[i][1].trim();
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const body = text.slice(start, end).trim();
    if (!body) continue;
    const time = heading.startsWith(baseName) ? heading : `${baseName} ${heading}`;
    entries.push({ time, file: fileName, content: body });
  }
  return entries;
}

export function writeDiary(content, diaryDir = DEFAULT_DIARY_DIR, date = new Date()) {
  const dir = path.resolve(diaryDir || DEFAULT_DIARY_DIR);
  fs.mkdirSync(dir, { recursive: true });

  const nowStr = formatNow(date);
  const day = nowStr.slice(0, 10);
  const weekday = nowStr.slice(11, 13);
  const clockPeriod = nowStr.slice(14);
  const clean = String(content || '').trim().slice(0, 1500);
  const fileName = `${day}.md`;
  const filePath = path.join(dir, fileName);

  const section = `## ${clockPeriod}\n${clean}\n`;
  if (!fs.existsSync(filePath) || !fs.readFileSync(filePath, 'utf8').trim()) {
    fs.writeFileSync(filePath, `# ${day} ${weekday}\n\n${section}`, 'utf8');
  } else {
    const existing = fs.readFileSync(filePath, 'utf8').replace(/\s+$/, '');
    fs.writeFileSync(filePath, `${existing}\n\n${section}`, 'utf8');
  }

  return {
    time: nowStr,
    file: fileName,
    path: filePath,
    content: clean,
  };
}

export function readDiary(limit = 5, diaryDir = DEFAULT_DIARY_DIR) {
  const dir = path.resolve(diaryDir || DEFAULT_DIARY_DIR);
  const n = Math.max(1, Math.min(20, Number(limit) || 5));

  const collected = [];
  if (fs.existsSync(dir)) {
    const files = fs
      .readdirSync(dir)
      .filter((f) => !f.startsWith('.') && /\.(md|txt)$/i.test(f))
      .sort()
      .reverse();

    for (const fileName of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, fileName), 'utf8');
        const entries = parseDiaryMarkdown(fileName, raw);
        for (let i = entries.length - 1; i >= 0; i--) {
          collected.push(entries[i]);
          if (collected.length >= n) break;
        }
      } catch {}
      if (collected.length >= n) break;
    }
  }

  if (collected.length > 0) {
    return collected.reverse();
  }

  // 向下兼容：若 tools/Diary 尚无日记文件，回退读取旧版 state/diary.json
  const legacy = readJson(LEGACY_DIARY_FILE, []);
  return Array.isArray(legacy) ? legacy.slice(-n) : [];
}

// 每个会话的最近消息环形缓存（用于群聊上下文还原）
const recentBuffers = new Map();
const MAX_RECENT = 30;

export function recordRecentMessage(chatKey, item) {
  let list = recentBuffers.get(chatKey);
  if (!list) {
    list = [];
    recentBuffers.set(chatKey, list);
  }
  list.push(item);
  if (list.length > MAX_RECENT) {
    list.splice(0, list.length - MAX_RECENT);
  }
}

export function getRecentMessages(chatKey, limit = 15) {
  const list = recentBuffers.get(chatKey) || [];
  const n = Math.max(1, Math.min(MAX_RECENT, Number(limit) || 15));
  return list.slice(-n);
}

const CROSS_CHAT_STOPWORDS = new Set([
  '这个', '那个', '什么', '怎么', '为什么', '可以', '已经', '现在', '今天', '明天', '昨天',
  '晚上', '早上', '上午', '下午', '我们', '你们', '他们', '自己', '一下', '知道', '没有',
  '觉得', '应该', '就是', '不是', '还是', '或者', '因为', '所以', '但是', '不过', '如果',
  '虽然', '然后', '比较', '非常', '特别', '真的', '其实', '好像', '可能', '大概', '一般',
  '时候', '地方', '东西', '事情', '问题', '哈哈', '哈哈哈', '好的', '好嘞', '嗯嗯', '谢谢',
  '猫猫', '本喵', '老大', '主人', '群里', '私聊', '消息', '聊天',
]);

function extractSearchTokens(text) {
  const s = String(text || '').trim().toLowerCase();
  if (s.length < 2) return [];
  const tokens = new Set();

  // 英文/数字词（如 gemini / kolors / snowluma / 4090）
  for (const m of s.matchAll(/[a-z0-9_]{3,}/g)) {
    tokens.add(m[0]);
  }
  // 中文片段按 2~3 字切片（过滤高频停用词，避免把常见连接词当成关键词）
  for (const seg of s.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const chunk = seg[0];
    if (chunk.length <= 4 && !CROSS_CHAT_STOPWORDS.has(chunk)) {
      tokens.add(chunk);
    }
    for (let len = 3; len >= 2; len--) {
      for (let i = 0; i <= chunk.length - len; i++) {
        const gram = chunk.slice(i, i + len);
        if (!CROSS_CHAT_STOPWORDS.has(gram)) tokens.add(gram);
        if (tokens.size >= 40) break;
      }
      if (tokens.size >= 40) break;
    }
  }
  return [...tokens];
}

/**
 * 0.1ms 内存跨聊关键词联想（仅在已打通隐私白名单的会话之间使用，例如主人私聊 <-> 亲密小群）：
 *   当当前消息提到的关键词刚好命中另一侧近期 30 条内存对话时，返回最多 2 条极简参考（不落盘进 context.db）。
 */
export function findCrossChatRecentMatches(chatKeys = [], queryText = '', { maxHits = 2, maxChars = 180 } = {}) {
  const tokens = extractSearchTokens(queryText);
  if (tokens.length === 0) return [];

  const scored = [];
  for (const key of chatKeys || []) {
    const list = recentBuffers.get(key);
    if (!list || list.length === 0) continue;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      const hay = `${m.sender || ''} ${m.text || ''}`.toLowerCase();
      if (!hay || hay.includes('（主动发起闲聊）')) continue;
      let score = 0;
      for (const tok of tokens) {
        if (hay.includes(tok)) {
          score += tok.length >= 3 ? 2 : 1;
        }
      }
      if (score >= 2) {
        scored.push({
          score,
          recency: i,
          line: `${m.time} ${m.sender}: ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 65)}`,
        });
      }
    }
  }

  if (scored.length === 0) return [];
  scored.sort((a, b) => b.score - a.score || b.recency - a.recency);

  const picked = [];
  let totalLen = 0;
  for (const item of scored) {
    if (picked.length >= maxHits) break;
    if (picked.includes(item.line)) continue;
    if (totalLen + item.line.length > maxChars && picked.length > 0) break;
    picked.push(item.line);
    totalLen += item.line.length;
  }
  return picked;
}
