/**
 * 离线记忆库同步脚本（npm run sync-memory）
 *
 * 作用：
 *   1. 检测 OneBot / Chat 客户端是否已真正登录在线（支持等待 客户端登录）；
 *   2. 拉取白名单私聊与群聊最新消息并通过快照指纹收敛检测确认 离线同步完成；
 *   3. 逐条 await 写入 state/memory.db，全部落盘成功后向 stdout 输出：
 *        {"status":"success","ok":true,...}
 *      并以退出码 0 结束，方便外部脚本或主程序拿到 success 信号后安全进入下一步。
 */
import '../src/bootstrap.js';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { closeMemoryDbWriter, configureMemoryDb } from '../src/db.js';
import { loadPersona } from '../src/persona.js';
import { getBotRuntime, resolveBotResourcePath } from '../src/runtime.js';
import { syncMemoryAndCatchup, waitForClientReady } from '../src/sync.js';

const runtime = getBotRuntime();
const ROOT = runtime.dataRoot;
const configPath = path.join(ROOT, 'config.json');
if (!fs.existsSync(configPath)) {
  console.log(JSON.stringify({ status: 'failed', ok: false, error: `未找到 config.json (${configPath})` }));
  process.exit(1);
}

const config = loadConfig(ROOT);
configureMemoryDb({ pythonBin: config.paths.pythonBin });
const personaPath = resolveBotResourcePath(config.paths.personaFile || 'roles/persona.txt', ROOT, runtime.codeRoot);

async function sendOneBot(action, payload = {}) {
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
  if (!res.ok) throw new Error(`OneBot HTTP ${res.status}`);
  return res.json();
}

function readArgInt(prefix, fallback) {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  if (!arg) return fallback;
  const n = Number(arg.slice(prefix.length));
  return Number.isFinite(n) ? n : fallback;
}

async function main() {
  const maxWaitMs = readArgInt('--wait-ms=', 60000);
  const count = readArgInt('--count=', config.startupCatchup?.preloadCount ?? 30);

  const ready = await waitForClientReady(sendOneBot, {
    pollIntervalMs: 3000,
    maxWaitMs,
    log: (...a) => console.error('[sync-memory]', ...a),
  });
  if (!ready.ok) {
    console.log(JSON.stringify({ status: 'failed', ok: false, error: ready.reason }));
    process.exit(1);
  }

  const res = await syncMemoryAndCatchup({
    config,
    sendOneBot,
    getPersona: () => loadPersona(personaPath),
    log: (...a) => console.error('[sync-memory]', ...a),
    count,
    probeIntervalMs: config.startupCatchup?.probeIntervalMs ?? 2500,
    maxProbes: config.startupCatchup?.maxProbes ?? 6,
    maxAgeMinutes: config.startupCatchup?.maxAgeMinutes ?? 120,
    mentionMaxAgeMinutes: config.startupCatchup?.mentionMaxAgeMinutes ?? 720,
    mentionReplyLastOnly: config.startupCatchup?.mentionReplyLastOnly !== false,
    maxUnreadPerChat: config.startupCatchup?.maxUnreadPerChat ?? 8,
  });

  // stdout 仅打印结构化结果，便于上层脚本直接判断 status === "success"
  console.log(
    JSON.stringify({
      status: res.status,
      ok: res.ok,
      convergedInProbes: res.convergedInProbes ?? 0,
      syncedChats: res.syncedChats ?? 0,
      inserted: res.inserted ?? 0,
      duplicates: res.duplicates ?? 0,
      unreadCount: Array.isArray(res.unreadTargets) ? res.unreadTargets.length : 0,
      ...(res.error ? { error: res.error } : {}),
    })
  );
  await closeMemoryDbWriter();
  process.exit(res.status === 'success' ? 0 : 1);
}

main().catch((err) => {
  console.log(JSON.stringify({ status: 'failed', ok: false, error: err?.message || String(err) }));
  process.exit(1);
});
