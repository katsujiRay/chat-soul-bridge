/**
 * 离线记忆库确定性同步门控（不依赖死等固定秒数，收敛落盘后明确返回 status: "success"）
 *
 * 解决两个实战痛点：
 *   1. 只开了 SnowLuma 还没登录 QQ 时，不会在 WS open 第 0 秒扑空，而是持续探测直到 QQ 真正在线；
 *   2. QQ 刚登录同步离线记录耗时不固定，采用“连续两轮快照指纹收敛检测”：
 *      - QQ 早就开着时约 2.5 秒即可收敛完成；
 *      - QQ 刚登录正在持续涌入离线记录时，自动续探直到最新 message_id 不再变化；
 *      - 逐条 await 写入 state/memory.db 并预热内存 recentBuffers，全部 commit 后返回 { status: "success", ... }，
 *        调用方收到 success 信号后再安全进入下一步（如离线未读补回）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { initMemoryDb, saveChatMessageToDb } from './db.js';
import { resolveForwardMessage } from './forward.js';
import { resolveSpeakerIdentity } from './identity.js';
import { resolveImpressionScope, touchUserInteraction } from './impressions.js';
import { formatNow, getRecentMessages } from './memory.js';

const STATE_DIR = path.resolve(process.cwd(), 'state');
const SYNC_STATE_FILE = path.join(STATE_DIR, 'sync-state.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadSyncState() {
  try {
    if (fs.existsSync(SYNC_STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SYNC_STATE_FILE, 'utf8'));
      return { lastHandled: parsed?.lastHandled || {} };
    }
  } catch {}
  return { lastHandled: {} };
}

function saveSyncState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(SYNC_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** 记录某会话已处理到的最新消息位置，避免重启或重连后重复补回同一条离线留言 */
export function markSyncHandled(chatKey, messageId = '', ts = Date.now() / 1000) {
  if (!chatKey) return;
  const st = loadSyncState();
  const prev = st.lastHandled[chatKey] || { ts: 0, messageId: '' };
  const nextTs = Math.max(Number(prev.ts || 0), Number(ts || 0));
  st.lastHandled[chatKey] = {
    ts: nextTs,
    messageId: messageId ? String(messageId) : prev.messageId || '',
    updatedAt: formatNow(),
  };
  saveSyncState(st);
}

/** 提取 OneBot 历史消息中的纯文本、@ 标记、合并转发 ID 与时间戳 */
function parseHistoryMessage(msg, botQQ) {
  let isAtMe = false;
  let text = '';
  const forwardIds = [];
  if (Array.isArray(msg.message)) {
    const parts = [];
    let hasImage = false;
    for (const seg of msg.message) {
      if (seg.type === 'text' && seg.data?.text) parts.push(seg.data.text);
      else if (seg.type === 'at' && botQQ && String(seg.data?.qq) === String(botQQ)) isAtMe = true;
      else if (seg.type === 'image') hasImage = true;
      else if (seg.type === 'forward' && seg.data?.id) {
        const fid = String(seg.data.id);
        forwardIds.push(fid);
        parts.push(`[合并转发 id=${fid}]`);
      }
    }
    text = parts.join('').trim() || (hasImage ? '[图片]' : '');
  } else {
    text = String(msg.raw_message || '').trim();
    if (botQQ && text.includes(`[CQ:at,qq=${botQQ}]`)) isAtMe = true;
    for (const m of text.matchAll(/\[CQ:forward,[^\]]*id=([^,\]]+)[^\]]*\]/g)) {
      forwardIds.push(String(m[1]));
    }
  }
  const who = Number(msg.user_id || msg.sender?.user_id || 0);
  const rawName = msg.sender?.card || msg.sender?.nickname || String(who || '未知');
  const ts = Number(msg.time || 0) || Date.now() / 1000;
  const messageId = String(msg.message_id || '');
  return { text, isAtMe, forwardIds, who, rawName, ts, messageId };
}

/** 探测 QQ 客户端是否已通过 OneBot 真正登录在线（不只是 WS 端口通了） */
export async function checkQqOnline(sendOneBot) {
  try {
    const statusRes = await sendOneBot('get_status', {});
    const st = statusRes?.data || statusRes || {};
    const statusOnline = st.online === true;
    const statusGood = st.good === true;

    const loginRes = await sendOneBot('get_login_info', {});
    const loginData = loginRes?.data || {};
    const userId = String(loginData.user_id || '').trim();

    if ((statusOnline || statusGood) && userId && userId !== '0') {
      return { online: true, userId };
    }
    // 兼容部分未实现 get_status.online 但 get_login_info 正常的协议端
    if (st.online === undefined && userId && userId !== '0') {
      return { online: true, userId };
    }
    return { online: false, userId: '' };
  } catch {
    return { online: false, userId: '' };
  }
}

/**
 * 持续等待直到 QQ 客户端真正登录上线（支持 SnowLuma 先启动、QQ 稍后才扫码登录的场景）
 * @param {number} maxWaitMs 0 表示持续等待直到上线或 shouldStop() 返回 true
 */
export async function waitForQqReady(
  sendOneBot,
  { pollIntervalMs = 3000, maxWaitMs = 0, log = () => {}, shouldStop = () => false } = {}
) {
  const startAt = Date.now();
  let warnedWaiting = false;

  while (!shouldStop()) {
    const res = await checkQqOnline(sendOneBot);
    if (res.online) {
      return { ok: true, userId: res.userId };
    }
    if (!warnedWaiting) {
      log('SnowLuma 已连接，但 QQ 客户端尚未登录上线，等待 QQ 登录后再同步记忆库...');
      warnedWaiting = true;
    }
    if (maxWaitMs > 0 && Date.now() - startAt >= maxWaitMs) {
      return { ok: false, reason: '等待 QQ 客户端上线超时' };
    }
    await sleep(Math.max(1000, Number(pollIntervalMs) || 3000));
  }
  return { ok: false, reason: '同步被取消' };
}

/** 构建需要同步预热的私聊与群聊目标列表 */
function resolveSyncTargets(config) {
  const denyPriv = new Set((config.deny?.private || []).map(String));
  const denyGrp = new Set((config.deny?.groups || []).map(String));

  const privateIds = [...new Set([config.ownerQQ, ...(config.allow?.private || [])].filter(Boolean).map(String))]
    .filter((id) => !denyPriv.has(id));
  const groupIds = [
    ...new Set(
      [
        ...(config.allow?.groups || []),
        ...(config.memoryPrivacy?.trustedGroups || []),
        ...(config.memoryPrivacy?.privateMemoryGroups || []),
      ]
        .filter(Boolean)
        .map(String)
    ),
  ].filter((id) => !denyGrp.has(id));

  const targets = [];
  for (const uid of privateIds) {
    targets.push({ chatKey: `private:${uid}`, scope: 'private', userId: uid, groupId: null });
  }
  for (const gid of groupIds) {
    targets.push({ chatKey: `group:${gid}`, scope: 'group', userId: null, groupId: gid });
  }
  return targets;
}

/** 拉取所有目标会话的最新 count 条消息，并生成用于收敛检测的指纹 */
async function fetchSnapshot(targets, sendOneBot, count = 30) {
  const map = new Map();
  const fpParts = [];

  for (const t of targets) {
    try {
      const res =
        t.scope === 'private'
          ? await sendOneBot('get_friend_msg_history', { user_id: Number(t.userId), count })
          : await sendOneBot('get_group_msg_history', { group_id: Number(t.groupId), count });
      const list = Array.isArray(res?.data?.messages) ? res.data.messages : [];
      list.sort((a, b) => Number(a.time || 0) - Number(b.time || 0));
      map.set(t.chatKey, list);
      const last = list[list.length - 1];
      fpParts.push(`${t.chatKey}:${list.length}:${last?.message_id || ''}:${last?.time || 0}`);
    } catch {
      map.set(t.chatKey, []);
      fpParts.push(`${t.chatKey}:err`);
    }
  }

  return { map, fingerprint: fpParts.join('|') };
}

/**
 * 执行确定性离线同步并落盘 state/memory.db：
 *   1. 确保 state/memory.db 已初始化就绪；
 *   2. 连续探测直到 OneBot 拉回的最新消息指纹稳定（不再依赖固定死等 12 秒）；
 *   3. 逐条 await 写入 state/memory.db + 预热内存 recentBuffers + 去重更新人物互动；
 *   4. 全部落盘成功后明确返回 { status: 'success', ok: true, ... } 及待处理的离线未读目标。
 */
export async function syncMemoryAndCatchup({
  config,
  sendOneBot,
  getPersona = () => ({ name: 'Bot', keywords: [] }),
  log = () => {},
  recordRecentMessage = null,
  shouldStop = () => false,
  count = 30,
  probeIntervalMs = 2500,
  maxProbes = 6,
  maxAgeMinutes = 120,
  mentionMaxAgeMinutes = 720,
  mentionReplyLastOnly = true,
  maxUnreadPerChat = 8,
}) {
  const initRes = await initMemoryDb();
  if (!initRes?.ok) {
    return { status: 'failed', ok: false, error: `初始化记忆库失败: ${initRes?.error || 'unknown'}` };
  }

  const targets = resolveSyncTargets(config);
  if (targets.length === 0) {
    return {
      status: 'success',
      ok: true,
      convergedInProbes: 0,
      syncedChats: 0,
      inserted: 0,
      duplicates: 0,
      unreadTargets: [],
    };
  }

  // 收敛探测：连续两次快照指纹一致即判定 QQ 离线同步已完成，立刻进入落盘阶段
  let latestSnap = await fetchSnapshot(targets, sendOneBot, count);
  let probeCount = 1;
  while (probeCount < Math.max(2, maxProbes) && !shouldStop()) {
    await sleep(Math.max(800, Number(probeIntervalMs) || 2500));
    if (shouldStop()) {
      return { status: 'cancelled', ok: false, error: '同步被中断' };
    }
    const nextSnap = await fetchSnapshot(targets, sendOneBot, count);
    probeCount += 1;
    const same = nextSnap.fingerprint === latestSnap.fingerprint;
    latestSnap = nextSnap;
    if (same) break;
  }

  const botQQ = String(config.snowluma?.botQQ || '');
  const ownerQQ = String(config.ownerQQ || '');
  const persona = getPersona();
  const botName = persona?.name || 'Bot';
  // 合并人设角色名（排除默认占位 Bot）+ 人设唤醒关键词 + 配置追加关键词，统一用于离线未读唤醒判定
  const wakeKeywords = [
    ...new Set([
      ...(botName && botName !== 'Bot' ? [botName] : []),
      ...(persona?.keywords || []),
      ...(config.groupTrigger?.keywords || []),
    ]),
  ]
    .map((k) => String(k || '').trim().toLowerCase())
    .filter(Boolean);

  const syncState = loadSyncState();
  const nowSec = Date.now() / 1000;
  const maxAgeSec = Math.max(5, Number(maxAgeMinutes) || 120) * 60;
  const mentionMaxAgeSec = Math.max(maxAgeSec, Math.max(5, Number(mentionMaxAgeMinutes) || 720) * 60);
  const replyLastMentionOnly = mentionReplyLastOnly !== false;
  const unreadCap = Math.max(1, Math.min(30, Number(maxUnreadPerChat) || 8));

  let inserted = 0;
  let duplicates = 0;
  const unreadTargets = [];

  for (const t of targets) {
    const rawList = latestSnap.map.get(t.chatKey) || [];
    if (rawList.length === 0) continue;

    // 现有内存 recentBuffers 中已有的 message_id，避免重复灌入
    const existingRecentIds = new Set(
      (recordRecentMessage ? getRecentMessages(t.chatKey, 30) : []).map((m) => String(m.message_id || ''))
    );

    let lastSelfTs = 0;
    const parsedItems = [];

    for (const rawMsg of rawList) {
      const p = parseHistoryMessage(rawMsg, botQQ);
      if (!p.text || /^(\/reset|\/清空|重置记忆)$/i.test(p.text)) continue;

      let displayText = p.text;
      let compactText = p.text;
      if (p.forwardIds.length > 0) {
        for (const fid of p.forwardIds.slice(0, 2)) {
          const resolved = await resolveForwardMessage(sendOneBot, fid, {
            maxItems: 20,
            maxDepth: 2,
            maxImages: 0,
            maxChars: 2000,
            formatIdentity: (uid, rName) => resolveSpeakerIdentity(uid, rName, config, botName).label,
          });
          if (resolved.ok && resolved.summaryText) {
            const token = `[合并转发 id=${fid}]`;
            displayText = displayText.includes(token)
              ? displayText.replace(token, resolved.summaryText)
              : `${displayText}\n${resolved.summaryText}`.trim();
            compactText = compactText.includes(token)
              ? compactText.replace(token, resolved.compactText)
              : `${compactText} ${resolved.compactText}`.trim();
          }
        }
      }

      const isSelf = Boolean(botQQ) && String(p.who) === botQQ;
      const isOwner = Boolean(ownerQQ) && String(p.who) === ownerQQ;
      if (isSelf && p.ts > lastSelfTs) lastSelfTs = p.ts;

      const speaker = resolveSpeakerIdentity(p.who, p.rawName, config, botName);
      parsedItems.push({ ...p, text: displayText, isSelf, isOwner, speaker });

      // 1) 同步 await 落盘 state/memory.db（确保返回 success 前每条都已 commit）
      const dbRes = await saveChatMessageToDb({
        scope: t.scope,
        groupId: t.groupId ? Number(t.groupId) : null,
        messageId: p.messageId,
        who: p.who,
        whoName: isSelf ? botName : p.rawName,
        isSelf,
        isOwner,
        isTriggered: true,
        text: displayText,
        ts: p.ts,
      });

      if (dbRes?.duplicate) {
        duplicates += 1;
      } else if (dbRes?.ok) {
        inserted += 1;
        // 仅对新补录的非自发消息累计人物互动次数，防重复统计
        if (!isSelf && p.who) {
          try {
            const pseudoEv =
              t.scope === 'group'
                ? { message_type: 'group', group_id: Number(t.groupId), user_id: p.who }
                : { message_type: 'private', user_id: p.who };
            const impScope = resolveImpressionScope(pseudoEv, {
              ownerQQ: config.ownerQQ,
              trustedGroups: config.memoryPrivacy?.trustedGroups || [],
              privateMemoryGroups: config.memoryPrivacy?.privateMemoryGroups || [],
            });
            touchUserInteraction({
              userId: p.who,
              nickname: p.rawName,
              scopeKey: impScope.writeScope,
            });
          } catch {}
        }
      }

      // 2) 预热内存 recentBuffers（确保重启刚上线也知道刚才聊到哪儿）
      if (recordRecentMessage && (!p.messageId || !existingRecentIds.has(p.messageId))) {
        const dt = new Date(p.ts * 1000);
        const hhmm = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
        recordRecentMessage(t.chatKey, {
          message_id: p.messageId || (isSelf ? 'self' : ''),
          time: hhmm,
          user_id: String(p.who || ''),
          sender: speaker.label,
          text: compactText.slice(0, p.forwardIds.length > 0 ? 700 : 120),
        });
        if (p.messageId) existingRecentIds.add(p.messageId);
      }
    }

    // 3) 筛选本会话的“真正离线未读消息”（严格在本喵最后发言 & 上次已处理位置之后）
    //    - 普通未读走 maxAgeMinutes（默认 2 小时防挖坟）；
    //    - 明确 @本喵 或提到角色名/唤醒关键词的消息放宽到 mentionMaxAgeMinutes（默认 12 小时），且只采取最后那一条。
    const handledTs = Number(syncState.lastHandled?.[t.chatKey]?.ts || 0);
    const handledMsgId = String(syncState.lastHandled?.[t.chatKey]?.messageId || '');
    const baseCutoffTs = Math.max(lastSelfTs, handledTs);
    const normalCutoffTs = Math.max(baseCutoffTs, nowSec - maxAgeSec);
    const mentionCutoffTs = Math.max(baseCutoffTs, nowSec - mentionMaxAgeSec);

    const afterMentionCutoff = parsedItems.filter(
      (item) => !item.isSelf && item.ts > mentionCutoffTs && (!handledMsgId || item.messageId !== handledMsgId)
    );
    if (afterMentionCutoff.length === 0) continue;

    const isMentioningMe = (m) => {
      if (m.isAtMe) return true;
      const lower = m.text.toLowerCase();
      return wakeKeywords.some((kw) => lower.includes(kw));
    };

    let selectedMessages = [];
    let catchupMode = '';

    if (t.scope === 'private') {
      const ownerEligible = afterMentionCutoff.filter((m) => m.isOwner || t.userId === ownerQQ);
      const afterNormal = ownerEligible.filter((m) => m.ts > normalCutoffTs);
      if (afterNormal.length > 0) {
        selectedMessages = afterNormal.slice(-unreadCap);
        catchupMode = 'private';
      } else {
        const mentionHits = ownerEligible.filter(isMentioningMe);
        if (mentionHits.length > 0) {
          selectedMessages = replyLastMentionOnly
            ? [mentionHits[mentionHits.length - 1]]
            : mentionHits.slice(-unreadCap);
          catchupMode = replyLastMentionOnly ? 'mention_latest' : 'private';
        }
      }
    } else {
      // 群聊：mentionMaxAgeMinutes 内若有人 @我 或喊角色名/触发唤醒关键词，默认只采取最后那一条（可由 mentionReplyLastOnly 控制）；
      // 否则回退到普通 maxAgeMinutes 窗口检查管理员是否发过言，四项全未命中则静默入库不惊动全群
      const mentionHits = afterMentionCutoff.filter(isMentioningMe);
      if (mentionHits.length > 0) {
        selectedMessages = replyLastMentionOnly
          ? [mentionHits[mentionHits.length - 1]]
          : afterMentionCutoff.slice(-unreadCap);
        catchupMode = replyLastMentionOnly ? 'mention_latest' : 'group_mention';
      } else {
        const replyOwnerGroup = config.startupCatchup?.replyGroupOwner !== false;
        const afterNormal = afterMentionCutoff.filter((m) => m.ts > normalCutoffTs);
        if (replyOwnerGroup && afterNormal.some((m) => m.isOwner)) {
          selectedMessages = afterNormal.slice(-unreadCap);
          catchupMode = 'group_owner';
        }
      }
    }

    if (selectedMessages.length > 0) {
      const newestInChat = afterMentionCutoff[afterMentionCutoff.length - 1];
      const focusMsg = selectedMessages[selectedMessages.length - 1];
      unreadTargets.push({
        chatKey: t.chatKey,
        scope: t.scope,
        groupId: t.groupId ? Number(t.groupId) : null,
        userId: t.scope === 'private' ? Number(t.userId) : focusMsg.who,
        latestMsgId: newestInChat.messageId,
        latestTs: newestInChat.ts,
        catchupMode,
        messages: selectedMessages,
      });
    }
  }

  log(
    `离线记忆库同步完成 (status=success，收敛探测 ${probeCount} 轮，新入库 ${inserted} 条，去重 ${duplicates} 条，待补回会话 ${unreadTargets.length} 个)`
  );

  return {
    status: 'success',
    ok: true,
    convergedInProbes: probeCount,
    syncedChats: targets.length,
    inserted,
    duplicates,
    unreadTargets,
  };
}
