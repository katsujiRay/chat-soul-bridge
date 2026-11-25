/**
 * OneBot v11 合并转发解析与消息转发工具（src/forward.js）
 *
 * 解决两个问题：
 *   1. 收到的合并转发（segment type="forward"）自动展开为人类与模型可读的聊天记录与图片列表，
 *      兼容 SnowLuma / NapCat / Lagrange 等 raw_message 为空、仅返回 message 段数组的协议端，
 *      支持多层嵌套合并转发（默认最多 5 层，同时兼容 id 递归拉取与 data.content 内联节点数组）并防止循环引用；
 *   2. 让角色具备转发能力（单条直转 + 多条按 message_id 打包合并转发 + 自定义节点合并转发），
 *      自动处理跨聊 ID 节点被协议端拒绝时的 get_msg 回退重拼。
 */

let maxForwardNodes = 20;

/** 应用来自 config.json -> forward 的节点上限 */
export function configureForward({ maxSendNodes } = {}) {
  if (Number.isFinite(Number(maxSendNodes)) && Number(maxSendNodes) >= 1) {
    maxForwardNodes = Math.min(50, Math.round(Number(maxSendNodes)));
  }
}

function formatShortTime(tsSec) {
  const n = Number(tsSec || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n > 1e12 ? n : n * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function summarizeJsonCard(raw) {
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const prompt = String(obj?.prompt || '').trim();
    if (prompt) return `[卡片:${prompt.slice(0, 60)}]`;
    const meta = obj?.meta && typeof obj.meta === 'object' ? Object.values(obj.meta)[0] : null;
    const title = String(meta?.title || meta?.desc || '').trim();
    if (title) return `[卡片:${title.slice(0, 60)}]`;
  } catch {}
  return '[卡片消息]';
}

/**
 * 将单条 OneBot 消息（数组段或 CQ 字符串）解析为纯文本、图片 URL、嵌套转发 ID 与内联嵌套节点数组。
 */
export function extractSegmentsContent(messageOrRaw) {
  const textParts = [];
  const imageUrls = [];
  const nestedForwardIds = [];
  const nestedInlineForwards = [];

  if (Array.isArray(messageOrRaw)) {
    for (const seg of messageOrRaw) {
      if (!seg || typeof seg !== 'object') continue;
      const d = seg.data || {};
      switch (seg.type) {
        case 'text':
          if (d.text) textParts.push(String(d.text));
          break;
        case 'at': {
          const qq = String(d.qq ?? '').trim();
          const name = String(d.name || '').trim();
          if (qq === 'all') textParts.push('@全体成员');
          else if (name) textParts.push(`@${name}`);
          else if (qq) textParts.push(`@${qq}`);
          break;
        }
        case 'image': {
          const url = String(d.url || (typeof d.file === 'string' && /^https?:\/\//i.test(d.file) ? d.file : '')).trim();
          if (url) imageUrls.push(url);
          textParts.push(d.summary ? `[图片${d.summary}]` : '[图片]');
          break;
        }
        case 'mface': {
          const url = String(d.url || '').trim();
          if (url) imageUrls.push(url);
          textParts.push(d.summary ? `[表情${d.summary}]` : '[表情]');
          break;
        }
        case 'face':
          textParts.push(d.summary ? `[表情${d.summary}]` : '[表情]');
          break;
        case 'forward': {
          const inlineNodes = Array.isArray(d.content)
            ? d.content
            : Array.isArray(d.messages)
              ? d.messages
              : null;
          if (inlineNodes && inlineNodes.length > 0) {
            nestedInlineForwards.push(inlineNodes);
          } else if (d.id) {
            nestedForwardIds.push(String(d.id));
          }
          textParts.push('[嵌套合并转发]');
          break;
        }
        case 'node': {
          // 兼容部分协议端直接把嵌套转发节点数组放在 type="node" 段中的情况
          if (Array.isArray(d.content) && d.content.length > 0) {
            nestedInlineForwards.push([seg]);
            textParts.push('[嵌套合并转发]');
          } else if (d.id) {
            nestedForwardIds.push(String(d.id));
            textParts.push('[嵌套合并转发]');
          }
          break;
        }
        case 'video':
          textParts.push('[视频]');
          break;
        case 'record':
          textParts.push('[语音]');
          break;
        case 'file':
          textParts.push(`[文件:${String(d.name || d.file || '').slice(0, 40)}]`);
          break;
        case 'json':
          textParts.push(summarizeJsonCard(d.data));
          break;
        case 'xml':
          textParts.push('[卡片消息]');
          break;
        case 'reply':
          // 合并转发内的 reply 段通常紧跟 @昵称 文本，避免输出杂乱 ID
          break;
        default:
          break;
      }
    }
  } else if (typeof messageOrRaw === 'string') {
    let s = messageOrRaw.trim();
    for (const m of s.matchAll(/\[CQ:image,[^\]]*url=([^,\]]+)[^\]]*\]/g)) {
      const url = m[1].replace(/&amp;/g, '&');
      if (/^https?:\/\//i.test(url)) imageUrls.push(url);
    }
    for (const m of s.matchAll(/\[CQ:forward,[^\]]*id=([^,\]]+)[^\]]*\]/g)) {
      nestedForwardIds.push(String(m[1]));
    }
    s = s
      .replace(/\[CQ:reply,[^\]]*\]/g, '')
      .replace(/\[CQ:at,qq=all[^\]]*\]/g, '@全体成员')
      .replace(/\[CQ:at,qq=(\d+)[^\]]*\]/g, '@$1')
      .replace(/\[CQ:image,[^\]]*\]/g, '[图片]')
      .replace(/\[CQ:face,[^\]]*\]/g, '[表情]')
      .replace(/\[CQ:forward,[^\]]*\]/g, '[嵌套合并转发]')
      .trim();
    if (s) textParts.push(s);
  }

  const text = textParts.join('').replace(/\s+/g, ' ').trim();
  return { text, imageUrls, nestedForwardIds, nestedInlineForwards };
}

/** 递归渲染合并转发节点列表（统一支持 get_forward_msg 返回数组与协议端内联节点数组，共享总条数与图片配额） */
async function renderForwardNodes(
  sendOneBot,
  rawMsgs,
  { maxDepth = 5, formatIdentity = null, depth = 0, visited = new Set(), budget } = {}
) {
  const lines = [];
  const imageUrls = [];
  let shownInThisLevel = 0;
  let totalEncountered = Array.isArray(rawMsgs) ? rawMsgs.length : 0;
  const indent = depth > 0 ? `${'  '.repeat(depth)}↳ ` : '';

  for (const m of rawMsgs || []) {
    if (budget.remainingItems <= 0) break;
    budget.remainingItems -= 1;
    shownInThisLevel += 1;

    const rawUserId = String(m?.sender?.user_id || m?.user_id || m?.data?.uin || m?.data?.user_id || '').trim();
    const rawName = String(
      m?.sender?.card ||
        m?.sender?.nickname ||
        m?.data?.name ||
        m?.data?.nickname ||
        rawUserId ||
        '未知'
    ).trim();
    const displaySender =
      typeof formatIdentity === 'function' ? formatIdentity(rawUserId, rawName) : rawName;
    const tStr = formatShortTime(m?.time || m?.data?.time);

    // 优先解析结构化 message / data.content，兼容 SnowLuma raw_message 为空串的情况
    const bodySource =
      Array.isArray(m?.message) && m.message.length > 0
        ? m.message
        : m?.data?.content ?? (m?.raw_message || m?.message || '');
    const parsed = extractSegmentsContent(bodySource);

    for (const u of parsed.imageUrls) {
      if (budget.imageUrls.length < budget.maxImages && !budget.imageUrls.includes(u)) {
        budget.imageUrls.push(u);
      }
      if (!imageUrls.includes(u)) imageUrls.push(u);
    }

    let lineText = parsed.text || (parsed.imageUrls.length > 0 ? '[图片]' : '（空消息）');
    if (lineText.length > 400) lineText = `${lineText.slice(0, 400)}...`;

    const prefix = tStr ? `${tStr} ` : '';
    lines.push(`${indent}${prefix}${displaySender}: ${lineText}`);

    const hasNested = parsed.nestedInlineForwards.length > 0 || parsed.nestedForwardIds.length > 0;
    if (!hasNested) continue;

    if (depth + 1 >= maxDepth) {
      lines.push(`${'  '.repeat(depth + 1)}↳ （嵌套转发已达最大展开深度 ${maxDepth} 层）`);
      continue;
    }

    // 1. 先展开协议端直接内联在 data.content / data.messages 中的嵌套转发节点
    for (const inlineNodes of parsed.nestedInlineForwards) {
      if (budget.remainingItems <= 0) break;
      const sub = await renderForwardNodes(sendOneBot, inlineNodes, {
        maxDepth,
        formatIdentity,
        depth: depth + 1,
        visited,
        budget,
      });
      lines.push(...sub.lines);
      if (sub.omittedCount > 0) {
        lines.push(`${'  '.repeat(depth + 1)}↳ …（该内层转发还有 ${sub.omittedCount} 条未展示）`);
      }
    }

    // 2. 再递归拉取按 forward id 引用的嵌套合并转发
    for (const nestedId of parsed.nestedForwardIds) {
      if (budget.remainingItems <= 0) break;
      const nfid = String(nestedId || '').trim();
      if (!nfid) continue;
      if (visited.has(nfid)) {
        lines.push(`${'  '.repeat(depth + 1)}↳ （嵌套转发 id=${nfid} 循环引用已跳过）`);
        continue;
      }
      visited.add(nfid);
      try {
        const res = await sendOneBot('get_forward_msg', { id: nfid, message_id: nfid });
        const nestedMsgs = res?.data?.messages || res?.data?.message || res?.messages || [];
        if (Array.isArray(nestedMsgs) && nestedMsgs.length > 0) {
          const sub = await renderForwardNodes(sendOneBot, nestedMsgs, {
            maxDepth,
            formatIdentity,
            depth: depth + 1,
            visited,
            budget,
          });
          lines.push(...sub.lines);
          if (sub.omittedCount > 0) {
            lines.push(`${'  '.repeat(depth + 1)}↳ …（该内层转发共 ${nestedMsgs.length} 条，还有 ${sub.omittedCount} 条未展示）`);
          }
        } else {
          lines.push(`${'  '.repeat(depth + 1)}↳ （内层合并转发 id=${nfid} 无法获取或已过期）`);
        }
      } catch (err) {
        lines.push(`${'  '.repeat(depth + 1)}↳ （内层合并转发 id=${nfid} 拉取失败: ${err?.message || err}）`);
      }
    }
  }

  return {
    lines,
    imageUrls,
    shownInThisLevel,
    omittedCount: Math.max(0, totalEncountered - shownInThisLevel),
  };
}

/**
 * 调用 OneBot get_forward_msg 展开合并转发，返回清晰可读的对话记录与附带图片 URL。
 * 支持多层套娃嵌套（id 递归 + data.content 内联节点双兼容）与共享总条数/图片配额。
 */
export async function resolveForwardMessage(
  sendOneBot,
  forwardId,
  {
    maxItems = 60,
    maxDepth = 5,
    maxImages = 4,
    maxChars = 5000,
    formatIdentity = null,
    _visited = null,
  } = {}
) {
  const fid = String(forwardId || '').trim();
  if (!fid) return { ok: false, error: '缺少 forward_id' };
  const visited = _visited instanceof Set ? _visited : new Set();
  if (visited.has(fid)) {
    return {
      ok: true,
      forwardId: fid,
      totalCount: 0,
      shownCount: 0,
      lines: ['（循环引用已跳过）'],
      summaryText: '',
      compactText: '',
      imageUrls: [],
    };
  }
  visited.add(fid);

  let res;
  try {
    res = await sendOneBot('get_forward_msg', { id: fid, message_id: fid });
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }

  const rawMsgs = res?.data?.messages || res?.data?.message || res?.messages || [];
  if (!Array.isArray(rawMsgs) || rawMsgs.length === 0) {
    return {
      ok: false,
      error: res?.wording || res?.message || '协议端未返回合并转发内容（可能已过期或无权限）',
    };
  }

  const safeMaxItems = Math.max(1, Math.min(200, Number(maxItems) || 60));
  const safeMaxDepth = Math.max(1, Math.min(8, Number(maxDepth) || 5));
  const safeMaxImages = Math.max(0, Number(maxImages) || 0);
  const safeMaxChars = Math.max(500, Number(maxChars) || 5000);

  const budget = {
    remainingItems: safeMaxItems,
    maxImages: safeMaxImages,
    imageUrls: [],
  };

  const rendered = await renderForwardNodes(sendOneBot, rawMsgs, {
    maxDepth: safeMaxDepth,
    formatIdentity,
    depth: 0,
    visited,
    budget,
  });

  const totalCount = rawMsgs.length;
  const shownCount = safeMaxItems - budget.remainingItems;
  const omitted =
    rendered.omittedCount > 0 ? `\n…（外层共 ${totalCount} 条，还有 ${rendered.omittedCount} 条因上限未展示）` : '';
  let body = `${rendered.lines.join('\n')}${omitted}`;
  if (body.length > safeMaxChars) {
    body = `${body.slice(0, safeMaxChars)}\n…（内容过长已截断）`;
  }

  const header = `[合并转发 id=${fid} 外层${totalCount}条/共展开${shownCount}条]`;
  const summaryText = `${header}\n${body}`;
  const compactLines = rendered.lines.slice(0, 8).join(' | ');
  const compactText =
    `${header} ${compactLines}${rendered.lines.length > 8 ? ` …共${shownCount}条` : ''}`.slice(0, 700);

  return {
    ok: true,
    forwardId: fid,
    totalCount,
    shownCount,
    lines: rendered.lines,
    summaryText,
    compactText,
    imageUrls: budget.imageUrls,
  };
}

/** 构造 OneBot v11 兼容自定义合并转发节点（同时携带 uin/user_id 与 name/nickname 兼容各协议端） */
function buildCustomNode({ userId, nickname, content }) {
  const uid = String(userId || '10000');
  const name = String(nickname || '群友').slice(0, 40);
  const segs = Array.isArray(content)
    ? content
    : [{ type: 'text', data: { text: String(content || '').slice(0, 1000) } }];
  return {
    type: 'node',
    data: {
      uin: uid,
      user_id: uid,
      name,
      nickname: name,
      content: segs,
    },
  };
}

function isOneBotOk(res) {
  if (!res || typeof res !== 'object') return false;
  if (res.status === 'failed') return false;
  if (typeof res.retcode === 'number' && res.retcode !== 0) return false;
  return true;
}

/** 将一批 message_id 通过 get_msg 还原为自定义节点（用于跨群/跨聊 ID 节点被协议端拒绝时的自动兜底） */
async function hydrateMessageIdsToCustomNodes(sendOneBot, messageIds, { botId, botName }) {
  const nodes = [];
  for (const rawId of messageIds) {
    const idStr = String(rawId || '').trim();
    if (!idStr) continue;
    const numId = /^-?\d+$/.test(idStr) ? Number(idStr) : idStr;
    try {
      const res = await sendOneBot('get_msg', { message_id: numId });
      const data = res?.data;
      if (!data) continue;
      const uid = String(data.sender?.user_id || data.user_id || botId || '10000');
      const name = String(data.sender?.card || data.sender?.nickname || botName || uid);
      const parsed = extractSegmentsContent(
        Array.isArray(data.message) && data.message.length > 0 ? data.message : data.raw_message || ''
      );
      const segs = [];
      if (parsed.text) segs.push({ type: 'text', data: { text: parsed.text } });
      for (const u of parsed.imageUrls.slice(0, 2)) {
        segs.push({ type: 'image', data: { file: u } });
      }
      if (segs.length === 0) continue;
      nodes.push(buildCustomNode({ userId: uid, nickname: name, content: segs }));
    } catch {}
  }
  return nodes;
}

/**
 * 统一消息转发发送器：
 *   - 支持单条直转（forward_group_single_msg / forward_friend_single_msg，失败自动降级合并转发）；
 *   - 支持多条 message_id 打包合并转发（ID 节点失败自动拉取 get_msg 重拼自定义节点）；
 *   - 支持自定义 nodes 打包发送合并转发卡片。
 */
export async function sendForwardMessages(
  sendOneBot,
  {
    targetType = 'group',
    targetId,
    messageIds = [],
    nodes = [],
    asBundle = false,
    botId = '',
    botName = 'Bot',
  } = {}
) {
  const tid = Number(targetId);
  if (!Number.isFinite(tid) || tid <= 0) {
    return { ok: false, error: '目标群号或 账号无效' };
  }
  const isGroup = targetType === 'group';
  const forwardAction = isGroup ? 'send_group_forward_msg' : 'send_private_forward_msg';
  const targetPayload = isGroup ? { group_id: tid } : { user_id: tid };

  const cleanIds = (Array.isArray(messageIds) ? messageIds : [])
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .slice(0, maxForwardNodes);

  const cleanNodes = (Array.isArray(nodes) ? nodes : [])
    .filter((n) => n && String(n.content || '').trim())
    .slice(0, maxForwardNodes);

  if (cleanIds.length === 0 && cleanNodes.length === 0) {
    return { ok: false, error: '请提供要转发的 message_ids 或自定义 nodes 内容' };
  }

  // 情况 1：单条已有消息直接转发
  if (cleanIds.length === 1 && cleanNodes.length === 0 && !asBundle) {
    const singleAction = isGroup ? 'forward_group_single_msg' : 'forward_friend_single_msg';
    const numMid = /^-?\d+$/.test(cleanIds[0]) ? Number(cleanIds[0]) : cleanIds[0];
    try {
      const res = await sendOneBot(singleAction, { ...targetPayload, message_id: numMid });
      if (isOneBotOk(res)) {
        return {
          ok: true,
          mode: 'single',
          targetType,
          targetId: tid,
          messageId: String(res?.data?.message_id || ''),
          forwardedCount: 1,
        };
      }
    } catch {}
    // 协议端不支持单条直转或跨聊失败 -> 自动降级到合并转发节点
  }

  // 情况 2：按 message_ids 打包合并转发（优先 ID 节点，失败自动 get_msg 兜底重拼）
  if (cleanIds.length > 0 && cleanNodes.length === 0) {
    const idNodes = cleanIds.map((id) => ({ type: 'node', data: { id } }));
    try {
      const res = await sendOneBot(forwardAction, { ...targetPayload, messages: idNodes });
      if (isOneBotOk(res)) {
        return {
          ok: true,
          mode: 'bundle_by_id',
          targetType,
          targetId: tid,
          messageId: String(res?.data?.message_id || res?.data || ''),
          forwardedCount: cleanIds.length,
        };
      }
    } catch {}

    const hydrated = await hydrateMessageIdsToCustomNodes(sendOneBot, cleanIds, { botId, botName });
    if (hydrated.length === 0) {
      return { ok: false, error: '无法通过 message_id 拉取原消息内容进行转发（消息可能已过期或编号不对）' };
    }
    const fallbackRes = await sendOneBot(forwardAction, { ...targetPayload, messages: hydrated });
    if (!isOneBotOk(fallbackRes)) {
      return {
        ok: false,
        error: fallbackRes?.wording || fallbackRes?.message || '发送合并转发失败',
      };
    }
    return {
      ok: true,
      mode: 'bundle_hydrated',
      targetType,
      targetId: tid,
      messageId: String(fallbackRes?.data?.message_id || fallbackRes?.data || ''),
      forwardedCount: hydrated.length,
    };
  }

  // 情况 3：自定义节点合并转发（可同时混合前面指定的 message_ids）
  const builtNodes = [];
  if (cleanIds.length > 0) {
    const hydrated = await hydrateMessageIdsToCustomNodes(sendOneBot, cleanIds, { botId, botName });
    builtNodes.push(...hydrated);
  }
  for (const n of cleanNodes) {
    builtNodes.push(
      buildCustomNode({
        userId: n.sender_id || botId || '10000',
        nickname: n.sender_name || botName || 'Bot',
        content: String(n.content).trim(),
      })
    );
  }
  const res = await sendOneBot(forwardAction, { ...targetPayload, messages: builtNodes });
  if (!isOneBotOk(res)) {
    return { ok: false, error: res?.wording || res?.message || '发送合并转发失败' };
  }
  return {
    ok: true,
    mode: 'bundle_custom',
    targetType,
    targetId: tid,
    messageId: String(res?.data?.message_id || res?.data || ''),
    forwardedCount: builtNodes.length,
  };
}
