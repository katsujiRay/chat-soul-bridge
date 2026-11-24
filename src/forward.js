/**
 * OneBot v11 合并转发解析与消息转发工具（src/forward.js）
 *
 * 解决两个问题：
 *   1. 收到的合并转发（segment type="forward"）自动展开为人类与模型可读的聊天记录与图片列表，
 *      兼容 SnowLuma / NapCat / Lagrange 等 raw_message 为空、仅返回 message 段数组的协议端，
 *      支持嵌套合并转发（最多 2 层）并防止循环引用；
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
 * 将单条 OneBot 消息（数组段或 CQ 字符串）解析为纯文本、图片 URL 与嵌套转发 ID。
 */
export function extractSegmentsContent(messageOrRaw) {
  const textParts = [];
  const imageUrls = [];
  const nestedForwardIds = [];

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
        case 'face':
        case 'mface':
          textParts.push(d.summary ? `[表情${d.summary}]` : '[表情]');
          break;
        case 'forward':
          if (d.id) nestedForwardIds.push(String(d.id));
          textParts.push('[嵌套合并转发]');
          break;
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
  return { text, imageUrls, nestedForwardIds };
}

/**
 * 调用 OneBot get_forward_msg 展开合并转发，返回清晰可读的对话记录与附带图片 URL。
 */
export async function resolveForwardMessage(
  sendOneBot,
  forwardId,
  {
    maxItems = 25,
    maxDepth = 2,
    maxImages = 4,
    maxChars = 2600,
    formatIdentity = null,
    _depth = 0,
    _visited = new Set(),
  } = {}
) {
  const fid = String(forwardId || '').trim();
  if (!fid) return { ok: false, error: '缺少 forward_id' };
  if (_visited.has(fid)) {
    return { ok: true, forwardId: fid, totalCount: 0, shownCount: 0, lines: ['（循环引用已跳过）'], summaryText: '', compactText: '', imageUrls: [] };
  }
  _visited.add(fid);

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

  const totalCount = rawMsgs.length;
  const slice = rawMsgs.slice(0, Math.max(1, maxItems));
  const lines = [];
  const imageUrls = [];

  for (const m of slice) {
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
      if (imageUrls.length < maxImages && !imageUrls.includes(u)) {
        imageUrls.push(u);
      }
    }

    let lineText = parsed.text || (parsed.imageUrls.length > 0 ? '[图片]' : '（空消息）');
    if (lineText.length > 260) lineText = `${lineText.slice(0, 260)}...`;

    const prefix = tStr ? `${tStr} ` : '';
    lines.push(`${prefix}${displaySender}: ${lineText}`);

    // 如有嵌套合并转发，最多再展开一层
    if (parsed.nestedForwardIds.length > 0 && _depth + 1 < maxDepth) {
      for (const nestedId of parsed.nestedForwardIds.slice(0, 2)) {
        const nested = await resolveForwardMessage(sendOneBot, nestedId, {
          maxItems: 8,
          maxDepth,
          maxImages: Math.max(0, maxImages - imageUrls.length),
          maxChars: 800,
          formatIdentity,
          _depth: _depth + 1,
          _visited,
        });
        if (nested.ok && nested.lines.length > 0) {
          for (const nl of nested.lines) {
            lines.push(`  ↳ ${nl}`);
          }
          for (const nu of nested.imageUrls || []) {
            if (imageUrls.length < maxImages && !imageUrls.includes(nu)) {
              imageUrls.push(nu);
            }
          }
        }
      }
    }
  }

  const omitted = totalCount > slice.length ? `\n…（共 ${totalCount} 条，仅展示前 ${slice.length} 条）` : '';
  let body = `${lines.join('\n')}${omitted}`;
  if (body.length > maxChars) {
    body = `${body.slice(0, maxChars)}\n…（内容过长已截断）`;
  }

  const header = `[合并转发 id=${fid} 共${totalCount}条]`;
  const summaryText = `${header}\n${body}`;
  const compactLines = lines.slice(0, 8).join(' | ');
  const compactText =
    `${header} ${compactLines}${lines.length > 8 ? ` …共${totalCount}条` : ''}`.slice(0, 700);

  return {
    ok: true,
    forwardId: fid,
    totalCount,
    shownCount: slice.length,
    lines,
    summaryText,
    compactText,
    imageUrls,
  };
}

/** 构造 OneBot v11 兼容自定义合并转发节点（同时携带 uin/user_id 与 name/nickname 兼容各协议端） */
function buildCustomNode({ userId, nickname, content }) {
  const uid = String(userId || '10000');
  const name = String(nickname || 'QQ用户').slice(0, 40);
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
async function hydrateMessageIdsToCustomNodes(sendOneBot, messageIds, { botQQ, botName }) {
  const nodes = [];
  for (const rawId of messageIds) {
    const idStr = String(rawId || '').trim();
    if (!idStr) continue;
    const numId = /^-?\d+$/.test(idStr) ? Number(idStr) : idStr;
    try {
      const res = await sendOneBot('get_msg', { message_id: numId });
      const data = res?.data;
      if (!data) continue;
      const uid = String(data.sender?.user_id || data.user_id || botQQ || '10000');
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
    botQQ = '',
    botName = 'Bot',
  } = {}
) {
  const tid = Number(targetId);
  if (!Number.isFinite(tid) || tid <= 0) {
    return { ok: false, error: '目标群号或 QQ 号无效' };
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

    const hydrated = await hydrateMessageIdsToCustomNodes(sendOneBot, cleanIds, { botQQ, botName });
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
    const hydrated = await hydrateMessageIdsToCustomNodes(sendOneBot, cleanIds, { botQQ, botName });
    builtNodes.push(...hydrated);
  }
  for (const n of cleanNodes) {
    builtNodes.push(
      buildCustomNode({
        userId: n.sender_qq || botQQ || '10000',
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
