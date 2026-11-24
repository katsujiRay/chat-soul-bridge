/**
 * 轻量动态待办清单（state/todos.json）
 *
 * 设计核心：
 *   1. 内存缓存 + 变更落盘（平时 0 磁盘 I/O），完成即删，动态数组硬封顶 20 条；
 *   2. 零空转轮询：配合主入口的「单一精准预约 setTimeout」，全局最多只挂 1 个定时器，
 *      没定时待办时 0 定时器、0% CPU 占用；
 *   3. 7 天温柔确认机制：未完成的普通待办超过 7 天不擅自静默删掉，而是随口问主人一次
 *      “还要不要做”，标记 staleAskedAt 防反复催促，等主人确认不做后再由 qq_todo(done) 删掉；
 *   4. 严格隐私隔离：仅在管理员私聊与信任亲密小群生效，绝不泄露给外部普通群聊。
 */
import fs from 'node:fs';
import path from 'node:path';
import { formatNow } from './memory.js';

const STATE_DIR = path.resolve(process.cwd(), 'state');
const TODOS_FILE = path.join(STATE_DIR, 'todos.json');
let maxTodos = 20;
let staleDays = 7;
let staleDaysMs = staleDays * 24 * 60 * 60 * 1000;

/** 应用来自 config.json -> todos 的参数 */
export function configureTodos({ maxItems, staleDays: days } = {}) {
  if (Number.isFinite(Number(maxItems)) && Number(maxItems) >= 1) {
    maxTodos = Math.min(100, Math.round(Number(maxItems)));
  }
  if (Number.isFinite(Number(days)) && Number(days) >= 1) {
    staleDays = Math.round(Number(days));
    staleDaysMs = staleDays * 24 * 60 * 60 * 1000;
  }
}

let cachedTodos = null;
const changeListeners = new Set();

export function getTodosFilePath() {
  return TODOS_FILE;
}

export function onTodosChanged(fn) {
  if (typeof fn === 'function') changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

function notifyChanged() {
  for (const fn of changeListeners) {
    try {
      fn();
    } catch {}
  }
}

export function ensureTodosFile() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const existed = fs.existsSync(TODOS_FILE);
  if (!existed) {
    fs.writeFileSync(TODOS_FILE, '[]\n', 'utf8');
  }
  return existed;
}

function loadTodos() {
  if (cachedTodos) return cachedTodos;
  ensureTodosFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(TODOS_FILE, 'utf8'));
    cachedTodos = Array.isArray(parsed) ? parsed : [];
  } catch {
    cachedTodos = [];
  }
  return cachedTodos;
}

function saveTodos(list) {
  cachedTodos = list;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(TODOS_FILE, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
  notifyChanged();
}

/**
 * 解析友好的到期时间字符串，支持：
 *   - 相对时间："+30m" / "+2h" / "+1d" / "30分钟后" / "2小时后"
 *   - 完整日期："2026-11-24 10:00" / "2026/11/24 10:00" / ISO 字符串
 *   - 缺省年份："11-24 10:00"
 *   - 口语日期："今天 22:30" / "明天 09:00" / "后天 14:30"
 * 返回 { dueAtMs, dueAtLabel } 或 null。
 */
export function parseDueAt(raw, nowMs = Date.now()) {
  const s = String(raw || '').trim();
  if (!s) return null;

  const formatLabel = (ms) => {
    const d = new Date(ms);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day} ${hh}:${mm}`;
  };

  // 1. 相对时间：+30m / +2h / +1d / 30分钟后 / 2小时后
  const relEn = s.match(/^\+?\s*(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i);
  if (relEn) {
    const n = Number(relEn[1]);
    const unit = relEn[2].toLowerCase();
    const mult = unit.startsWith('d') ? 86400000 : unit.startsWith('h') ? 3600000 : 60000;
    const ms = Math.round(nowMs + n * mult);
    return { dueAtMs: ms, dueAtLabel: formatLabel(ms) };
  }
  const relCn = s.match(/^(\d+(?:\.\d+)?)\s*(分钟|小时|个小时|天)\s*后?$/);
  if (relCn) {
    const n = Number(relCn[1]);
    const unit = relCn[2];
    const mult = unit === '天' ? 86400000 : unit.includes('小时') ? 3600000 : 60000;
    const ms = Math.round(nowMs + n * mult);
    return { dueAtMs: ms, dueAtLabel: formatLabel(ms) };
  }

  // 2. 口语相对天：今天/明天/后天 HH:mm
  const cnDay = s.match(/^(今天|明天|后天)\s*(\d{1,2})[:：](\d{2})$/);
  if (cnDay) {
    const offsetDays = cnDay[1] === '明天' ? 1 : cnDay[1] === '后天' ? 2 : 0;
    const d = new Date(nowMs);
    d.setDate(d.getDate() + offsetDays);
    d.setHours(Number(cnDay[2]), Number(cnDay[3]), 0, 0);
    return { dueAtMs: d.getTime(), dueAtLabel: formatLabel(d.getTime()) };
  }

  // 3. 完整日期 YYYY-MM-DD HH:mm 或 YYYY/MM/DD HH:mm
  const full = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s]+(\d{1,2})[:：](\d{2}))?/);
  if (full) {
    const d = new Date(
      Number(full[1]),
      Number(full[2]) - 1,
      Number(full[3]),
      full[4] != null ? Number(full[4]) : 9,
      full[5] != null ? Number(full[5]) : 0,
      0,
      0
    );
    if (Number.isFinite(d.getTime())) {
      return { dueAtMs: d.getTime(), dueAtLabel: formatLabel(d.getTime()) };
    }
  }

  // 4. 缺省年份 MM-DD HH:mm
  const shortMd = s.match(/^(\d{1,2})[-/](\d{1,2})\s+(\d{1,2})[:：](\d{2})$/);
  if (shortMd) {
    const now = new Date(nowMs);
    const d = new Date(
      now.getFullYear(),
      Number(shortMd[1]) - 1,
      Number(shortMd[2]),
      Number(shortMd[3]),
      Number(shortMd[4]),
      0,
      0
    );
    if (d.getTime() < nowMs - 86400000) {
      d.setFullYear(d.getFullYear() + 1);
    }
    return { dueAtMs: d.getTime(), dueAtLabel: formatLabel(d.getTime()) };
  }

  // 5. 兜底尝试标准 Date.parse
  const parsedMs = Date.parse(s);
  if (Number.isFinite(parsedMs)) {
    return { dueAtMs: parsedMs, dueAtLabel: formatLabel(parsedMs) };
  }
  return null;
}

export function listTodos() {
  return [...loadTodos()];
}

export function addTodo({ content, dueAt = '' }, nowMs = Date.now()) {
  const clean = String(content || '').trim().slice(0, 80);
  if (!clean) return { ok: false, error: '待办内容 content 不能为空' };

  const list = [...loadTodos()];
  if (list.length >= maxTodos) {
    return { ok: false, error: `待办清单已满（上限 ${maxTodos} 条），请先完成或删掉旧条目` };
  }

  // 去重：避免模型重复添加完全一样的待办
  const dup = list.find((item) => item.content === clean);
  if (dup) {
    return { ok: true, duplicate: true, item: dup, total: list.length };
  }

  let dueAtMs = 0;
  let dueAtLabel = '';
  if (String(dueAt || '').trim()) {
    const parsed = parseDueAt(dueAt, nowMs);
    if (!parsed) {
      return {
        ok: false,
        error: `无法识别到期时间 "${dueAt}"，请使用如 "2026-11-24 10:00"、"明天 09:00" 或 "+30m" 格式`,
      };
    }
    dueAtMs = parsed.dueAtMs;
    dueAtLabel = parsed.dueAtLabel;
  }

  const nextId = list.reduce((max, it) => Math.max(max, Number(it.id || 0)), 0) + 1;
  const item = {
    id: nextId,
    content: clean,
    ...(dueAtMs ? { dueAt: dueAtLabel, dueAtMs } : {}),
    createdAt: formatNow(new Date(nowMs)),
    createdAtMs: nowMs,
    staleAskedAt: 0,
  };
  list.push(item);
  saveTodos(list);
  return { ok: true, item, total: list.length };
}

/** 完成或取消某条待办（支持按 id 或关键词匹配，完成即从动态数组删除） */
export function completeTodo({ id, content = '' }) {
  const list = [...loadTodos()];
  const numId = Number(id || 0);
  let idx = -1;

  if (Number.isFinite(numId) && numId > 0) {
    idx = list.findIndex((it) => Number(it.id) === numId);
  }
  if (idx === -1 && String(content || '').trim()) {
    const needle = String(content).trim().toLowerCase();
    idx = list.findIndex((it) => String(it.content || '').toLowerCase().includes(needle));
  }
  if (idx === -1) {
    return { ok: false, error: '未在待办清单中找到对应条目' };
  }

  const [removed] = list.splice(idx, 1);
  saveTodos(list);
  return { ok: true, removed, remaining: list.length };
}

/** 批量删除指定 ID 的待办（用于到点提醒发出后自动清理） */
export function removeTodosByIds(ids = []) {
  const idSet = new Set(ids.map((x) => Number(x)));
  if (idSet.size === 0) return [];
  const list = [...loadTodos()];
  const removed = [];
  const kept = [];
  for (const it of list) {
    if (idSet.has(Number(it.id))) removed.push(it);
    else kept.push(it);
  }
  if (removed.length > 0) saveTodos(kept);
  return removed;
}

/** 标记超过 7 天的待办已向主人确认过一次（防止反复催问，等主人确认不做后再删） */
export function markTodosStaleAsked(ids = [], nowMs = Date.now()) {
  const idSet = new Set(ids.map((x) => Number(x)));
  if (idSet.size === 0) return;
  const list = [...loadTodos()];
  let changed = false;
  for (const it of list) {
    if (idSet.has(Number(it.id)) && !it.staleAskedAt) {
      it.staleAskedAt = nowMs;
      changed = true;
    }
  }
  if (changed) saveTodos(list);
}

/**
 * 供「单一精准预约 setTimeout」计算下一次触发时间与当前到期/满 7 天条目：
 *   - dueItems  ：带明确 dueAtMs 且已到点的定时提醒；
 *   - staleItems：超过 7 天仍未完成且尚未确认过的待办（随口问一句还要不要做）；
 *   - nextWakeAtMs：下一次需要唤醒的精确时间戳（若无任何未来定时或未确认待办，返回 0 表示 0 定时器！）
 */
export function inspectTodoSchedule(nowMs = Date.now()) {
  const list = loadTodos();
  const dueItems = [];
  const staleItems = [];
  let nextWakeAtMs = 0;

  const consider = (ts) => {
    if (!ts || ts <= 0) return;
    if (nextWakeAtMs === 0 || ts < nextWakeAtMs) nextWakeAtMs = ts;
  };

  for (const it of list) {
    const dueMs = Number(it.dueAtMs || 0);
    if (dueMs > 0) {
      if (dueMs <= nowMs) {
        dueItems.push(it);
      } else {
        consider(dueMs);
      }
      continue;
    }

    // 无明确截止时间的普通待办：满 staleDays 天且尚未询问过 -> 加入温柔确认列表
    if (!it.staleAskedAt) {
      const staleAt = Number(it.createdAtMs || nowMs) + staleDaysMs;
      if (staleAt <= nowMs) {
        staleItems.push(it);
      } else {
        consider(staleAt);
      }
    }
  }

  return { dueItems, staleItems, nextWakeAtMs };
}

/**
 * 生成当轮极简 1 行待办胶囊（空列表返回 '' 即 0 字注入；最多展示 5 条，走去噪通道不落盘进 context.db）
 */
export function formatTodosForPrompt(maxItems = 5, nowMs = Date.now()) {
  const list = loadTodos();
  if (list.length === 0) return '';

  // 排序：有截止时间的按最近到期排前面，其余按创建时间先后
  const sorted = [...list].sort((a, b) => {
    const da = Number(a.dueAtMs || 0);
    const db = Number(b.dueAtMs || 0);
    if (da && db) return da - db;
    if (da) return -1;
    if (db) return 1;
    return Number(a.createdAtMs || 0) - Number(b.createdAtMs || 0);
  });

  const shown = sorted.slice(0, Math.max(1, maxItems));
  const parts = shown.map((it) => {
    const extra = [];
    if (it.dueAt) extra.push(`定时:${it.dueAt.slice(5)}`);
    else if (nowMs - Number(it.createdAtMs || nowMs) >= staleDaysMs) {
      extra.push(`已超${staleDays}天,可随口问还要不要做`);
    }
    return `#${it.id} ${it.content}${extra.length ? `(${extra.join(',')})` : ''}`;
  });
  const more = list.length > shown.length ? ` 等共${list.length}条` : '';
  return `[待办小纸条（办完或主人确认不做时调 qq_todo done 删掉）：${parts.join('；')}${more}]`;
}
