/**
 * 身份与场景认知模块（代码层按 QQ 号硬校验，防群名片冒充）
 *
 * 设计目标：
 *   1. 按 QQ 号识别管理员（ownerQQ）、机器人自身（botQQ）、可选熟人名录（identity.knownUsers）与普通群友；
 *   2. 给每条消息打上不可伪造的身份前缀（如「主人·昵称」「群友·昵称」），避免他人改群名片冒充管理员；
 *   3. 为每轮对话生成极简场景标签（管理员私聊 / 亲密小群 / 普通外部群），几乎零 token 负担。
 */

/** 获取管理员称呼（默认「主人」，可在 config.json 的 identity.ownerTitle 自定义为「管理员」等） */
export function getOwnerTitle(config) {
  const raw = String(config?.identity?.ownerTitle || '').trim();
  return raw || '主人';
}

/** 查找静态配置的同群 AI 伙伴（兼容新版 identity.aiBots 与旧版 identity.knownUsers） */
export function resolveAiBotEntry(config, userId) {
  const uid = String(userId || '').trim();
  if (!uid) return null;

  const aiBots = config?.identity?.aiBots;
  if (Array.isArray(aiBots)) {
    if (aiBots.map(String).includes(uid)) {
      return { name: '', relation: '同群AI伙伴', note: '同群的另一只AI伙伴' };
    }
  } else if (aiBots && typeof aiBots === 'object' && Object.prototype.hasOwnProperty.call(aiBots, uid)) {
    const v = aiBots[uid];
    if (typeof v === 'string') {
      return { name: v.trim(), relation: '同群AI伙伴', note: '同群的另一只AI伙伴' };
    }
    if (v && typeof v === 'object') {
      return {
        name: String(v.name || '').trim(),
        relation: String(v.relation || '同群AI伙伴').trim() || '同群AI伙伴',
        note: String(v.note || '同群的另一只AI伙伴').trim(),
      };
    }
    return { name: '', relation: '同群AI伙伴', note: '同群的另一只AI伙伴' };
  }

  const knownMap = config?.identity?.knownUsers;
  if (knownMap && typeof knownMap === 'object' && Object.prototype.hasOwnProperty.call(knownMap, uid)) {
    const entry = knownMap[uid];
    if (entry && typeof entry === 'object' && /ai|机器人|bot/i.test(String(entry.relation || ''))) {
      return {
        name: String(entry.name || '').trim(),
        relation: String(entry.relation || '同群AI伙伴').trim(),
        note: String(entry.note || '').trim(),
      };
    }
  }
  return null;
}

/**
 * 按 QQ 号解析发言人的权威身份标签（不信任昵称/群名片自称）
 *   - 静态硬校验：机器人自身(botQQ) / 管理员(ownerQQ) / 同群 AI 伙伴(identity.aiBots)
 *   - 动态熟人标签：来自 state/impressions.db 的 dynamicRelation（免改配置、热生效）
 * @returns {{ role: 'self'|'owner'|'known'|'member', tag: string, displayName: string, note: string, label: string, isAiBot: boolean }}
 */
export function resolveSpeakerIdentity(userId, fallbackNickname, config, botName = 'Bot', { dynamicRelation = '' } = {}) {
  const uid = String(userId || '').trim();
  const cleanFallback = String(fallbackNickname || uid || '未知').trim();
  const botQQ = String(config?.snowluma?.botQQ || '').trim();
  const ownerQQ = String(config?.ownerQQ || '').trim();
  const ownerTitle = getOwnerTitle(config);

  if (botQQ && uid === botQQ) {
    const name = String(botName || 'Bot').trim();
    return { role: 'self', tag: '我', displayName: name, note: '', label: `我·${name}`, isAiBot: false };
  }

  if (ownerQQ && uid === ownerQQ) {
    const customName = String(config?.identity?.ownerNickname || '').trim();
    const displayName = customName || cleanFallback;
    return {
      role: 'owner',
      tag: ownerTitle,
      displayName,
      note: '',
      label: `${ownerTitle}·${displayName}`,
      isAiBot: false,
    };
  }

  const aiBot = resolveAiBotEntry(config, uid);
  if (aiBot) {
    const displayName = aiBot.name || cleanFallback;
    return {
      role: 'known',
      tag: aiBot.relation,
      displayName,
      note: aiBot.note,
      label: `${aiBot.relation}·${displayName}`,
      isAiBot: true,
    };
  }

  const knownMap = config?.identity?.knownUsers;
  if (knownMap && typeof knownMap === 'object' && uid && Object.prototype.hasOwnProperty.call(knownMap, uid)) {
    const entry = knownMap[uid];
    if (entry && typeof entry === 'object') {
      const tag = String(entry.relation || '熟人').trim() || '熟人';
      const displayName = String(entry.name || cleanFallback).trim() || cleanFallback;
      const note = String(entry.note || '').trim();
      return { role: 'known', tag, displayName, note, label: `${tag}·${displayName}`, isAiBot: false };
    }
  }

  const cleanDynRel = String(dynamicRelation || '').trim();
  if (cleanDynRel) {
    const isAi = /ai|机器人|bot/i.test(cleanDynRel);
    return {
      role: 'known',
      tag: cleanDynRel,
      displayName: cleanFallback,
      note: '',
      label: `${cleanDynRel}·${cleanFallback}`,
      isAiBot: isAi,
    };
  }

  return {
    role: 'member',
    tag: '群友',
    displayName: cleanFallback,
    note: '',
    label: `群友·${cleanFallback}`,
    isAiBot: false,
  };
}

/** 生成极简场景认知标签（注入每轮上下文头部，10~20 字零负担） */
export function formatSceneTag(event, config, speakerIdentity) {
  const ownerTitle = getOwnerTitle(config);
  if (event?.message_type === 'private') {
    if (speakerIdentity?.role === 'owner') {
      return `[场景：与${ownerTitle}私聊]`;
    }
    return `[场景：私聊（${speakerIdentity?.label || '访客'}，非${ownerTitle}）]`;
  }

  if (event?.message_type === 'group') {
    const gid = String(event.group_id || '');
    const trusted = new Set((config?.memoryPrivacy?.trustedGroups || []).map(String));
    if (trusted.has(gid)) {
      return `[场景：亲密小群(${gid})，熟人环境]`;
    }
    const privateMemGroups = new Set((config?.memoryPrivacy?.privateMemoryGroups || []).map(String));
    if (privateMemGroups.has(gid)) {
      return `[场景：熟人互通群(${gid})，已打通${ownerTitle}私聊日常记忆供你心里有数，但群里有外人——绝对禁止泄露${ownerTitle}的隐私、私密心事、真实身份/住址/联系方式、账密或私聊中未公开的敏感内容]`;
    }
    return `[场景：普通外部群(${gid})，注意保密]`;
  }

  return '';
}

/**
 * 当本轮发言人/群聊近期发言中出现静态标注的同群 AI 伙伴（identity.aiBots）或旧版 knownUsers，
 * 或当前消息正文点名提到其名字/别名时，附带一行极简备注（动态熟人则自动走 state/impressions.db）。
 */
export function formatKnownUsersNote(config, userIds = [], text = '') {
  const entries = [];
  const seenUid = new Set();

  const aiBots = config?.identity?.aiBots;
  if (aiBots && typeof aiBots === 'object' && !Array.isArray(aiBots)) {
    for (const [uid, val] of Object.entries(aiBots)) {
      if (!uid || seenUid.has(uid)) continue;
      seenUid.add(uid);
      if (typeof val === 'string') {
        entries.push({ uid, name: val.trim() || uid, relation: '同群AI伙伴', note: '同群的另一只AI伙伴', aliases: [] });
      } else if (val && typeof val === 'object') {
        entries.push({
          uid,
          name: String(val.name || uid).trim(),
          relation: String(val.relation || '同群AI伙伴').trim(),
          note: String(val.note || '同群的另一只AI伙伴').trim(),
          aliases: Array.isArray(val.aliases) ? val.aliases : [],
        });
      }
    }
  }

  const knownMap = config?.identity?.knownUsers;
  if (knownMap && typeof knownMap === 'object') {
    for (const [uid, entry] of Object.entries(knownMap)) {
      if (!entry || typeof entry !== 'object' || seenUid.has(uid)) continue;
      seenUid.add(uid);
      entries.push({
        uid,
        name: String(entry.name || uid).trim(),
        relation: String(entry.relation || '').trim(),
        note: String(entry.note || '').trim(),
        aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
      });
    }
  }

  if (entries.length === 0) return '';
  const presentSet = new Set(
    (Array.isArray(userIds) ? userIds : []).map((rawId) => String(rawId || '').trim()).filter(Boolean)
  );
  const lowerText = String(text || '').toLowerCase();
  const notes = [];

  for (const item of entries) {
    if (!item.note && !item.relation) continue;
    let matched = presentSet.has(item.uid);
    if (!matched && lowerText.length >= 2) {
      const namesToCheck = [
        item.name,
        ...item.aliases.map((a) => String(a || '').trim()),
      ].filter((s) => s.length >= 2);
      matched = namesToCheck.some((n) => lowerText.includes(n.toLowerCase()));
    }
    if (!matched) continue;

    const head = item.relation ? `${item.name}(${item.relation})` : item.name;
    notes.push(item.note ? `${head}：${item.note}` : head);
    if (notes.length >= 4) break;
  }

  if (notes.length === 0) return '';
  return `[相关伙伴备注：${notes.join('；')}]`;
}
