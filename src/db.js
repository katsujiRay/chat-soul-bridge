/**
 * 全量 SQLite + FTS5 长期记忆库桥接层（对接 scripts/memory-db.py 与 scripts/recall.py）
 *
 * 为什么用 Python 读写 state/memory.db：
 *   Node 22 内置 node:sqlite 未编译 FTS5 扩展，而 Python 标准库 sqlite3 原生内置 FTS5。
 *   写入侧维护一个常驻 `--stdio` Python 子进程（串行队列），避免每条 聊天消息都冷启动进程；
 *   查询侧按需调用 recall.py（支持 FTS5 + LIKE + 可选向量 RRF 融合 + 隐私范围硬过滤）。
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { CODE_ROOT } from './runtime.js';

const MEMORY_DB_SCRIPT = path.join(CODE_ROOT, 'scripts', 'memory-db.py');
const RECALL_SCRIPT = path.join(CODE_ROOT, 'scripts', 'recall.py');
const DB_PATH = path.join(process.cwd(), 'state', 'memory.db');

/** 查找 Python 可执行文件（优先使用 config.paths.pythonBin 或 PYTHON_BIN 环境变量） */
function resolvePythonBin(customBin = '') {
  if (customBin && fs.existsSync(customBin)) {
    return customBin;
  }
  if (process.env.PYTHON_BIN && fs.existsSync(process.env.PYTHON_BIN)) {
    return process.env.PYTHON_BIN;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

let pythonBin = resolvePythonBin();

/** 应用来自 config.json -> paths.pythonBin 的自定义 Python 路径 */
export function configureMemoryDb({ pythonBin: customBin = '' } = {}) {
  if (customBin) {
    pythonBin = resolvePythonBin(String(customBin).trim());
  }
}

// 轻量常驻 Python 写入子进程（--stdio），省去每条 聊天消息都冷启动一次 Python
let writerProc = null;
let writerQueue = Promise.resolve();
let pendingResolvers = [];

function startWriter() {
  if (writerProc && !writerProc.killed) return writerProc;
  const proc = spawn(pythonBin, [MEMORY_DB_SCRIPT, '--stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', RECALL_DB: DB_PATH },
  });

  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    const resolve = pendingResolvers.shift();
    if (!resolve) return;
    try {
      resolve(JSON.parse(line));
    } catch {
      resolve({ ok: false, raw: line });
    }
  });

  proc.on('exit', () => {
    if (writerProc === proc) writerProc = null;
    while (pendingResolvers.length > 0) {
      const resolve = pendingResolvers.shift();
      resolve({ ok: false, error: 'db writer exited' });
    }
  });

  writerProc = proc;
  return proc;
}

function sendWriterOp(op, data) {
  const task = () =>
    new Promise((resolve) => {
      try {
        const proc = startWriter();
        pendingResolvers.push(resolve);
        proc.stdin.write(`${JSON.stringify({ op, data })}\n`);
      } catch (err) {
        resolve({ ok: false, error: err?.message || String(err) });
      }
    });
  writerQueue = writerQueue.then(task, task);
  return writerQueue;
}

/** 等待所有排队的写入操作（ingest-msg / ingest-diary）完成 SQLite commit，杜绝读写竞态 */
export function flushMemoryDbWrites() {
  return writerQueue.catch(() => {});
}

/** 优雅关闭常驻 Python 写入子进程（供独立 CLI 脚本退出前调用，防止进程残留） */
export async function closeMemoryDbWriter() {
  await flushMemoryDbWrites();
  if (writerProc && !writerProc.killed) {
    try {
      writerProc.stdin.end();
    } catch {}
    writerProc = null;
  }
}

/** 根据 聊天消息特征计算静态权重与分层 */
function scoreMessageWeight({ text = '', scope = 'private', isOwner = false, isSelf = false, isTriggered = false }) {
  const len = String(text).trim().length;
  let w = 0.45;
  if (scope === 'private') w += 0.15;
  if (isOwner) w += 0.1;
  if (isSelf) w += 0.05;
  if (isTriggered) w += 0.1;
  if (len >= 20) w += 0.1;
  else if (len <= 3) w -= 0.15;
  w = Math.max(0.2, Math.min(0.95, Number(w.toFixed(2))));
  const tier = w >= 0.7 ? 'core' : w < 0.35 ? 'archive' : 'normal';
  return { weight: w, tier };
}

export function initMemoryDb() {
  return new Promise((resolve) => {
    execFile(
      pythonBin,
      [MEMORY_DB_SCRIPT, 'init'],
      {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', RECALL_DB: DB_PATH },
      },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, error: err.message });
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          resolve({ ok: true, db: DB_PATH });
        }
      }
    );
  });
}

export function saveChatMessageToDb({
  scope,
  groupId = null,
  messageId = '',
  who,
  whoName = '',
  isSelf = false,
  isOwner = false,
  isTriggered = false,
  text,
  ts = Date.now() / 1000,
  kind = 'message',
}) {
  const clean = String(text || '').trim();
  if (!clean) return Promise.resolve({ ok: false, skipped: true });
  const { weight, tier } = scoreMessageWeight({ text: clean, scope, isOwner, isSelf, isTriggered });
  const tags = scope === 'group' && groupId ? `group:${groupId}` : `private:${who}`;
  return sendWriterOp('ingest-msg', {
    scope,
    group_id: groupId,
    message_id: String(messageId || ''),
    who: Number(who || 0),
    who_name: String(whoName || ''),
    is_self: Boolean(isSelf),
    text: clean,
    weight,
    tier,
    ts,
    kind,
    tags,
  });
}

export function saveDiaryToDb({ content, day }) {
  return sendWriterOp('ingest-diary', { content, day });
}

/** 回填更新 state/memory.db 中某条消息的正文（例如补写图片文字图注并重建 FTS5 索引） */
export function updateChatMessageTextInDb({ scope, messageId, text }) {
  const clean = String(text || '').trim();
  const mid = String(messageId || '').trim();
  if (!clean || !mid) return Promise.resolve({ ok: false, skipped: true });
  return sendWriterOp('update-msg-text', {
    scope: scope === 'group' ? 'group' : 'private',
    message_id: mid,
    text: clean,
  });
}

export async function recallFromDb({
  keyword = '',
  scope,
  groupId,
  allowPrivateAndGroup,
  who,
  since,
  until,
  limit = 6,
  source = 'chat',
  tier = 'default',
  semantic = 'off',
} = {}) {
  // 查询前先排空待落盘的写入队列，确保刚刚收发的消息立刻可被 chat_recall 检索到
  await flushMemoryDbWrites();

  const args = [RECALL_SCRIPT];
  if (keyword) args.push('--keyword', String(keyword));
  if (scope === 'private' || scope === 'group') args.push('--scope', scope);
  if (groupId !== undefined && groupId !== null && String(groupId).trim() !== '') {
    args.push('--group-id', String(groupId));
  }
  if (
    allowPrivateAndGroup !== undefined &&
    allowPrivateAndGroup !== null &&
    String(allowPrivateAndGroup).trim() !== ''
  ) {
    args.push('--allow-private-and-group', String(allowPrivateAndGroup));
  }
  if (who !== undefined && who !== null && String(who).trim() !== '') args.push('--who', String(who));
  if (since) args.push('--since', String(since));
  if (until) args.push('--until', String(until));
  if (limit) args.push('--limit', String(Math.max(1, Math.min(20, Number(limit) || 6))));
  if (['chat', 'diary', 'all'].includes(source)) args.push('--source', source);
  if (['default', 'all', 'core', 'normal', 'archive'].includes(tier)) args.push('--tier', tier);
  if (['on', 'off', 'only'].includes(semantic)) args.push('--semantic', semantic);

  return new Promise((resolve) => {
    execFile(
      pythonBin,
      args,
      {
        encoding: 'utf8',
        timeout: 25000,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', RECALL_DB: DB_PATH },
      },
      (err, stdout, stderr) => {
        const raw = (stdout || '').trim();
        if (raw) {
          try {
            resolve(JSON.parse(raw));
            return;
          } catch {}
        }
        resolve({
          ok: false,
          error: err?.message || stderr?.trim() || 'recall.py 执行失败',
        });
      }
    );
  });
}
