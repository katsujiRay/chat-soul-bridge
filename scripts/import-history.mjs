/**
 * QQ 历史聊天记录一键迁移脚本（npm run import-history）
 *
 * 作用：
 *   通过 OneBot v11 HTTP API（get_friend_msg_history / get_group_msg_history）
 *   分页拉取机器人已有的私聊与群聊历史，写入本地 state/memory.db 并建好 FTS5 索引。
 *   底层按 (scope, message_id) 自动去重，可随时安全重复执行。
 */
import '../src/bootstrap.js';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { closeMemoryDbWriter, configureMemoryDb, initMemoryDb, saveChatMessageToDb } from '../src/db.js';
import { loadPersona } from '../src/persona.js';
import { getBotRuntime, resolveBotResourcePath } from '../src/runtime.js';

const runtime = getBotRuntime();
const ROOT = runtime.dataRoot;
const config = loadConfig(ROOT);
configureMemoryDb({ pythonBin: config.paths.pythonBin });
const personaPath = resolveBotResourcePath(config.paths.personaFile || 'roles/persona.txt', ROOT, runtime.codeRoot);
const botDisplayName = loadPersona(personaPath).name;

/** 调用 OneBot v11 HTTP 接口 */
async function callOneBot(action, payload = {}) {
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

function extractText(msg) {
  if (Array.isArray(msg.message)) {
    const parts = [];
    let hasImage = false;
    for (const seg of msg.message) {
      if (seg.type === 'text' && seg.data?.text) parts.push(seg.data.text);
      else if (seg.type === 'image') hasImage = true;
      else if (seg.type === 'forward' && seg.data?.id) parts.push(`[合并转发 id=${seg.data.id}]`);
    }
    const text = parts.join('').trim();
    return text || (hasImage ? '[图片]' : '');
  }
  return String(msg.raw_message || '').trim();
}

async function fetchPaginated(action, basePayload, maxTotal = 500) {
  const collected = [];
  const seenSeq = new Set();
  let cursorSeq = 0;

  while (collected.length < maxTotal) {
    const body = { ...basePayload, count: 50, ...(cursorSeq ? { message_seq: cursorSeq } : {}) };
    const res = await callOneBot(action, body);
    const batch = res?.data?.messages || [];
    if (!Array.isArray(batch) || batch.length === 0) break;

    let added = 0;
    let minSeq = Infinity;
    for (const m of batch) {
      const seq = Number(m.message_seq || 0);
      if (seq && seq < minSeq) minSeq = seq;
      const key = `${m.message_id}:${seq}`;
      if (seenSeq.has(key)) continue;
      seenSeq.add(key);
      collected.push(m);
      added++;
    }

    if (added === 0 || !Number.isFinite(minSeq) || minSeq <= 1 || batch.length < 2) break;
    const nextSeq = minSeq - 1;
    if (nextSeq === cursorSeq) break;
    cursorSeq = nextSeq;
  }

  // 按时间升序入库
  collected.sort((a, b) => Number(a.time || 0) - Number(b.time || 0));
  return collected;
}

async function importMessages(scope, groupId, messages) {
  const botQQ = String(config.snowluma.botQQ || '');
  const ownerQQ = String(config.ownerQQ || '');
  let inserted = 0;
  let skippedDup = 0;

  for (const m of messages) {
    const text = extractText(m);
    if (!text || /^(\/reset|\/清空|重置记忆)$/i.test(text)) continue;

    const who = Number(m.user_id || m.sender?.user_id || 0);
    const isSelf = String(who) === botQQ;
    const whoName = isSelf ? botDisplayName : (m.sender?.card || m.sender?.nickname || String(who));
    const res = await saveChatMessageToDb({
      scope,
      groupId,
      messageId: String(m.message_id || ''),
      who,
      whoName,
      isSelf,
      isOwner: String(who) === ownerQQ,
      isTriggered: true,
      text,
      ts: m.time ? Number(m.time) : Date.now() / 1000,
    });

    if (res?.duplicate) skippedDup++;
    else if (res?.ok) inserted++;
  }
  return { total: messages.length, inserted, skippedDup };
}

async function main() {
  const initRes = await initMemoryDb();
  if (!initRes?.ok) {
    console.error('初始化数据库失败:', initRes);
    process.exit(1);
  }
  console.log('目标记忆库:', initRes.db);

  // 1. 导入私聊记录（主人 + 私聊白名单）
  const privateTargets = [...new Set([...(config.allow?.private || []), config.ownerQQ].filter(Boolean))];
  for (const uid of privateTargets) {
    try {
      const msgs = await fetchPaginated('get_friend_msg_history', { user_id: Number(uid) }, 500);
      const stat = await importMessages('private', null, msgs);
      console.log(`私聊 ${uid}: 拉取 ${stat.total} 条 -> 新入库 ${stat.inserted} 条，去重跳过 ${stat.skippedDup} 条`);
    } catch (err) {
      console.warn(`私聊 ${uid} 导入失败:`, err?.message || err);
    }
  }

  // 2. 自动发现机器人所在的全部群（合并 config 里的群号）
  const groupSet = new Set((config.allow?.groups || []).map(Number));
  try {
    const gl = await callOneBot('get_group_list');
    for (const g of gl?.data || []) {
      if (g?.group_id) groupSet.add(Number(g.group_id));
    }
  } catch {}

  for (const gid of groupSet) {
    try {
      const msgs = await fetchPaginated('get_group_msg_history', { group_id: gid }, 500);
      if (msgs.length === 0) continue;
      const stat = await importMessages('group', gid, msgs);
      console.log(`群聊 ${gid}: 拉取 ${stat.total} 条 -> 新入库 ${stat.inserted} 条，去重跳过 ${stat.skippedDup} 条`);
    } catch (err) {
      console.warn(`群聊 ${gid} 导入失败:`, err?.message || err);
    }
  }

  console.log('历史记录迁移完成！');
  await closeMemoryDbWriter();
  process.exit(0);
}

main();
