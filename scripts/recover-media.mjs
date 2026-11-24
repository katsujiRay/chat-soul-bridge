/**
 * 历史图片原图追回脚本（npm run recover-media）
 *
 * 作用：
 *   扫描 state/memory.db 中已有的历史 [图片] 记录（不改写旧消息文字描述），
 *   通过 OneBot get_msg 尝试拉取尚未过期的 QQ 原图链接并归档至 state/media/，
 *   让历史图片在 QQ 链接失效前得以本地留存，日后 qq_view_memory_image 可随时调回查看。
 */
import '../src/bootstrap.js';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { archiveImagesForMessage, ensureMediaArchiveDir, hasArchivedImages } from '../src/media-archive.js';
import { getBotRuntime } from '../src/runtime.js';

const runtime = getBotRuntime();
const ROOT = runtime.dataRoot;
const configPath = path.join(ROOT, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error(`[recover-media] 未找到 config.json (${configPath})`);
  process.exit(1);
}
const config = loadConfig(ROOT);
const DB_PATH = path.join(ROOT, 'state', 'memory.db');
if (!fs.existsSync(DB_PATH)) {
  console.error(`[recover-media] 未找到 state/memory.db (${DB_PATH})`);
  process.exit(1);
}

const PYTHON_BIN =
  config.paths?.pythonBin && fs.existsSync(config.paths.pythonBin)
    ? config.paths.pythonBin
    : process.env.PYTHON_BIN && fs.existsSync(process.env.PYTHON_BIN)
      ? process.env.PYTHON_BIN
      : process.platform === 'win32'
        ? 'python'
        : 'python3';

function listImageMessagesFromDb() {
  const py = [
    'import json, sqlite3, sys',
    'con = sqlite3.connect(sys.argv[1])',
    "rows = con.execute(\"SELECT scope, group_id, who, message_id FROM msg WHERE message_id != '' AND (text LIKE '%[图片%' OR text LIKE '%[画了一张图%') ORDER BY ts DESC LIMIT 300\").fetchall()",
    'con.close()',
    "print(json.dumps([{'scope': r[0], 'groupId': r[1], 'userId': r[2], 'messageId': r[3]} for r in rows]))",
  ].join('\n');

  return new Promise((resolve, reject) => {
    execFile(PYTHON_BIN, ['-c', py, DB_PATH], { encoding: 'utf8', windowsHide: true }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse((stdout || '[]').trim()));
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function callOneBot(action, payload) {
  const url = `${config.snowluma.httpUrl.replace(/\/$/, '')}/${action}`;
  const headers = { 'Content-Type': 'application/json' };
  if (config.snowluma.accessToken) headers.Authorization = `Bearer ${config.snowluma.accessToken}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function downloadImage(url, maxBytes) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    if (!ct.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > maxBytes) return null;
    return { data: buf.toString('base64'), mimeType: ct };
  } catch {
    return null;
  }
}

async function main() {
  ensureMediaArchiveDir();
  const rows = await listImageMessagesFromDb();
  const maxBytes = config.maxImageBytes || 5242880;
  const maxFiles = config.mediaArchive?.maxFiles ?? 300;
  const maxTotalMB = config.mediaArchive?.maxTotalMB ?? 200;

  let alreadyArchived = 0;
  let recovered = 0;
  let expiredOrMissing = 0;

  for (const row of rows) {
    const msgId = String(row.messageId || '').trim();
    if (!msgId) continue;
    if (hasArchivedImages(msgId)) {
      alreadyArchived += 1;
      continue;
    }

    try {
      const numId = /^-?\d+$/.test(msgId) ? Number(msgId) : msgId;
      const res = await callOneBot('get_msg', { message_id: numId });
      const segs = Array.isArray(res?.data?.message) ? res.data.message : [];
      const urls = segs.filter((s) => s?.type === 'image' && s.data?.url).map((s) => s.data.url);
      if (urls.length === 0) {
        expiredOrMissing += 1;
        continue;
      }

      const imgs = [];
      for (const u of urls.slice(0, 3)) {
        const img = await downloadImage(u, maxBytes);
        if (img) imgs.push(img);
      }
      if (imgs.length === 0) {
        expiredOrMissing += 1;
        continue;
      }

      const saved = archiveImagesForMessage({
        messageId: msgId,
        images: imgs,
        scope: row.scope,
        groupId: row.groupId,
        userId: row.userId,
        maxFiles,
        maxTotalMB,
      });
      if (saved.length > 0) recovered += 1;
      else expiredOrMissing += 1;
    } catch {
      expiredOrMissing += 1;
    }
  }

  console.log(
    JSON.stringify({
      status: 'success',
      scanned: rows.length,
      alreadyArchived,
      recovered,
      expiredOrMissing,
    })
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('[recover-media] 失败:', err?.message || err);
  process.exit(1);
});
