/**
 * 本地短期对话上下文库（state/context.db）
 *
 * 作用：
 *   为每个聊天窗口（private:<ID> / group:<群号>）维护一份滑动窗口式的短期多轮对话记录，
 *   配合无状态 API 调用（如 Gemini store: false / OpenAI / Claude）实现：
 *   1. 永不受服务端会话过期时间限制；
 *   2. 切换主力/备用模型时上下文无缝延续；
 *   3. 自动按 maxTurns 裁剪上限，并按时间阶梯自然淡出（12h 内全量、12~48h 收窄保留最近 4 轮、超过 48h 自动淡出翻篇），
 *      既保留隔夜尾巴不失忆，又不让几天前的碎话污染当下注意力。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const STATE_DIR = path.resolve(process.cwd(), 'state');
const CONTEXT_DB_PATH = path.join(STATE_DIR, 'context.db');

let fullWindowSec = 12 * 3600; // 12 小时内保留完整滑窗
let maxAgeSec = 48 * 3600; // 超过 48 小时自然淡出（需要翻旧账时走 state/memory.db）
let overnightMaxRows = 4 * 2; // 12~48 小时隔夜段最多保留最近 4 轮（8 条）

/** 应用来自 config.json -> contextFade 的时间阶梯参数 */
export function configureContextFade({ fullWindowHours, overnightMaxTurns, maxAgeHours } = {}) {
  if (Number.isFinite(Number(fullWindowHours)) && Number(fullWindowHours) > 0) {
    fullWindowSec = Math.round(Number(fullWindowHours) * 3600);
  }
  if (Number.isFinite(Number(maxAgeHours)) && Number(maxAgeHours) > 0) {
    maxAgeSec = Math.max(fullWindowSec, Math.round(Number(maxAgeHours) * 3600));
  }
  if (Number.isFinite(Number(overnightMaxTurns)) && Number(overnightMaxTurns) >= 0) {
    overnightMaxRows = Math.round(Number(overnightMaxTurns)) * 2;
  }
}

fs.mkdirSync(STATE_DIR, { recursive: true });

let dbInstance = null;

/** 懒初始化 SQLite 连接（开启 WAL 模式提升并发读写性能） */
function getDb() {
  if (dbInstance) return dbInstance;
  const db = new DatabaseSync(CONTEXT_DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS context_turns (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_key TEXT NOT NULL,
      role     TEXT NOT NULL,
      text     TEXT NOT NULL,
      ts       REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ctx_chat_id ON context_turns(chat_key, id);
  `);
  dbInstance = db;
  return db;
}

export function getContextDbPath() {
  getDb();
  return CONTEXT_DB_PATH;
}

/**
 * 读取某个会话最近的原始对话记录（按时间升序，带 12h/48h 时间阶梯淡出）：
 *   - 超过 48 小时的陈旧记录自动过滤，当作全新开场；
 *   - 12~48 小时的隔夜记录最多保留末尾 4 轮（不丢昨晚尾巴，也不在续聊时复活几十条旧碎话）；
 *   - 12 小时内的活跃对话完整保留，总条数不超过 maxTurns * 2。
 */
export function loadContextMessages(chatKey, maxTurns = 20, nowSec = Date.now() / 1000) {
  const db = getDb();
  const maxRows = Math.max(2, Number(maxTurns || 20) * 2);
  const minValidTs = nowSec - maxAgeSec;
  const freshCutoffTs = nowSec - fullWindowSec;

  const rawRows = db
    .prepare(
      `SELECT role, text, ts FROM context_turns
       WHERE chat_key = ? AND ts >= ?
       ORDER BY id DESC LIMIT ?`
    )
    .all(String(chatKey), minValidTs, maxRows)
    .reverse();

  const olderRows = [];
  const freshRows = [];
  for (const row of rawRows) {
    if (Number(row.ts || 0) < freshCutoffTs) olderRows.push(row);
    else freshRows.push(row);
  }

  // 隔夜段最多保留末尾 overnightMaxRows 条，再拼接活跃对话，单调不反弹
  const keptOlder = overnightMaxRows > 0 ? olderRows.slice(-overnightMaxRows) : [];
  const rows = [...keptOlder, ...freshRows].slice(-maxRows);

  // 保证第一条是 user，避免历史截断后以 assistant/model 开头
  while (rows.length > 0 && rows[0].role !== 'user') {
    rows.shift();
  }
  return rows.map((row) => ({ role: row.role === 'model' ? 'model' : 'user', text: row.text }));
}

/** 读取某个会话最近的对话历史（按时间升序，转为 Gemini Interactions steps 格式） */
export function loadContextSteps(chatKey, maxTurns = 20) {
  return loadContextMessages(chatKey, maxTurns).map((row) => ({
    type: row.role === 'model' ? 'model_output' : 'user_input',
    content: [{ type: 'text', text: row.text }],
  }));
}

/** 写入一条对话记录并自动裁剪滑窗上限与超过 48 小时的过期记录 */
export function appendContextTurn(chatKey, role, text, maxTurns = 20, tsSec = Date.now() / 1000) {
  const clean = String(text || '').trim();
  if (!clean) return;
  const db = getDb();
  const key = String(chatKey);
  db.prepare('INSERT INTO context_turns (chat_key, role, text, ts) VALUES (?, ?, ?, ?)').run(
    key,
    role === 'model' ? 'model' : 'user',
    clean,
    tsSec
  );
  const maxRows = Math.max(4, Number(maxTurns || 20) * 2);
  const minValidTs = Date.now() / 1000 - maxAgeSec;
  db.prepare(
    `DELETE FROM context_turns
     WHERE chat_key = ?
       AND (
         ts < ?
         OR id NOT IN (
           SELECT id FROM context_turns WHERE chat_key = ? ORDER BY id DESC LIMIT ?
         )
       )`
  ).run(key, minValidTs, key, maxRows);
}

/** 清空某个会话的本地短期上下文（/reset） */
export function clearContext(chatKey) {
  const db = getDb();
  db.prepare('DELETE FROM context_turns WHERE chat_key = ?').run(String(chatKey));
}

/** 查询某个会话在本地短期上下文中的最后发言时间戳（毫秒；无记录返回 0） */
export function getLastContextTsMs(chatKey) {
  try {
    const db = getDb();
    const row = db
      .prepare('SELECT MAX(ts) AS last_ts FROM context_turns WHERE chat_key = ?')
      .get(String(chatKey));
    const sec = Number(row?.last_ts || 0);
    return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : 0;
  } catch {
    return 0;
  }
}
