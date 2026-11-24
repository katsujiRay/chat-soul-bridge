/**
 * 人物印象数据库（基于 Node 22 原生 node:sqlite，零外部依赖）
 *
 * 持久化位置：state/impressions.db（SQLite WAL 模式）
 *
 * 设计核心：
 *   1. 两张表分工：
 *      - user_profiles   ：按 (user_id, scope_key) 存储最新昵称、曾用名、互动次数、关系、标签与精炼总印象；
 *      - impression_logs ：记录每次印象变化的原因与时间，平时不注入 Prompt，仅在 chat_recall 翻旧账时按需附带。
 *   2. 严格隐私隔离（scope_key 分区）：
 *      - 管理员私聊 & 信任亲密小群共享 scope_key = 'private'；
 *      - 普通外部群严格锁死在 'group:<群号>'，绝不串群或泄露私密印象；
 *      - 非管理员私聊锁死在 'private:<账号>'。
 *   3. 大群防注意力飘移（O(1) 恒定上限）：
 *      - 每轮最多按优先级挑出 1~2 位直接相关者（当前发言者 -> 被引用者 -> @提及者 -> 文本点名熟人）；
 *      - 没有印象卡的纯路人 0 字注入，且印象行只用于当轮上下文、不落盘进 state/context.db。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { formatNow } from './memory.js';

const STATE_DIR = path.resolve(process.cwd(), 'state');
const DB_PATH = path.join(STATE_DIR, 'impressions.db');
const UPDATE_COOLDOWN_MS = 60 * 1000; // 同一对象 60 秒内避免重复刷库

let dbInstance = null;
const lastUpdateAt = new Map();

export function getImpressionsDbPath() {
  return DB_PATH;
}

function getDb() {
  if (dbInstance) return dbInstance;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      nickname TEXT NOT NULL DEFAULT '',
      aliases TEXT NOT NULL DEFAULT '[]',
      relation TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      impression TEXT NOT NULL DEFAULT '',
      interact_count INTEGER NOT NULL DEFAULT 0,
      first_seen_at INTEGER NOT NULL DEFAULT 0,
      last_seen_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, scope_key)
    );
    CREATE INDEX IF NOT EXISTS idx_profiles_scope_seen
      ON user_profiles(scope_key, last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS impression_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      impression TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_imp_logs_lookup
      ON impression_logs(user_id, scope_key, id DESC);
  `);
  dbInstance = db;
  return db;
}

export function ensureImpressionsDb() {
  const existed = fs.existsSync(DB_PATH);
  getDb();
  return existed;
}

/**
 * 启动时将 config.json 中的静态 aiBots 与旧版 knownUsers 幂等合并为 state/impressions.db 的初始种子：
 *   - 绝不覆盖聊天中已动态更新过的 relation / impression；
 *   - 自动把简短名字加入 nickname / aliases，让正文点名（如简称）立刻在动态印象库里命中。
 */
export function seedImpressionsFromConfig(config) {
  const seeds = [];
  const seen = new Set();

  const aiBots = config?.identity?.aiBots;
  if (aiBots && typeof aiBots === 'object' && !Array.isArray(aiBots)) {
    for (const [uid, val] of Object.entries(aiBots)) {
      const id = String(uid || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (typeof val === 'string') {
        seeds.push({ userId: id, name: val.trim(), relation: '同群AI伙伴', note: '同群的另一只AI伙伴' });
      } else if (val && typeof val === 'object') {
        seeds.push({
          userId: id,
          name: String(val.name || '').trim(),
          relation: String(val.relation || '同群AI伙伴').trim(),
          note: String(val.note || '同群的另一只AI伙伴').trim(),
        });
      }
    }
  }

  const knownUsers = config?.identity?.knownUsers;
  if (knownUsers && typeof knownUsers === 'object') {
    for (const [uid, entry] of Object.entries(knownUsers)) {
      const id = String(uid || '').trim();
      if (!id || !entry || typeof entry !== 'object' || seen.has(id)) continue;
      seen.add(id);
      seeds.push({
        userId: id,
        name: String(entry.name || '').trim(),
        relation: String(entry.relation || '熟人').trim(),
        note: String(entry.note || '').trim(),
      });
    }
  }

  if (seeds.length === 0) return 0;
  const db = getDb();
  const now = Date.now();
  let seeded = 0;

  for (const s of seeds) {
    const existing = db
      .prepare('SELECT nickname, aliases, relation, impression FROM user_profiles WHERE user_id = ? AND scope_key = ?')
      .get(s.userId, 'private');
    if (!existing) {
      db.prepare(
        `INSERT INTO user_profiles
           (user_id, scope_key, nickname, aliases, relation, tags, impression, interact_count, first_seen_at, last_seen_at, updated_at)
         VALUES (?, 'private', ?, '[]', ?, '[]', ?, 0, ?, ?, ?)`
      ).run(s.userId, s.name || s.userId, s.relation.slice(0, 24), s.note.slice(0, 120), now, now, now);
      seeded += 1;
    } else {
      const aliases = safeParseArray(existing.aliases);
      if (s.name && s.name !== existing.nickname && !aliases.includes(s.name)) {
        aliases.push(s.name);
      }
      const nextRel = existing.relation || s.relation.slice(0, 24);
      const nextImp = existing.impression || s.note.slice(0, 120);
      if (
        nextRel !== existing.relation ||
        nextImp !== existing.impression ||
        JSON.stringify(aliases) !== (existing.aliases || '[]')
      ) {
        db.prepare(
          `UPDATE user_profiles
           SET aliases = ?, relation = ?, impression = ?, updated_at = ?
           WHERE user_id = ? AND scope_key = ?`
        ).run(JSON.stringify(aliases.slice(-8)), nextRel, nextImp, now, s.userId, 'private');
        seeded += 1;
      }
    }
  }
  return seeded;
}

/** 0.2ms 快速查询某 账号 在当前隐私分区下的动态关系标签（供 resolveSpeakerIdentity 实时生效，无需重启） */
export function getDynamicSpeakerRelation(userId, readScopes = ['private']) {
  const prof = loadBestProfileForUser(userId, readScopes);
  return prof?.relation ? String(prof.relation).trim() : '';
}

/**
 * 动态清空/删除某人的熟人关系、标签与印象（恢复为普通群友，保留互动计数与清空日志）
 */
export function clearUserImpression({ userId, scopeKey = 'private', reason = '' }) {
  const uid = String(userId || '').trim();
  if (!uid) return { ok: false, error: 'user_id 不能为空' };
  const db = getDb();
  const existing = db
    .prepare('SELECT nickname FROM user_profiles WHERE user_id = ? AND scope_key = ?')
    .get(uid, scopeKey);
  if (!existing) {
    return { ok: true, cleared: false, note: '该用户在当前分区原本就没有熟人档案' };
  }
  const now = Date.now();
  db.prepare(
    `UPDATE user_profiles
     SET relation = '', tags = '[]', impression = '', updated_at = ?
     WHERE user_id = ? AND scope_key = ?`
  ).run(now, uid, scopeKey);

  if (String(reason || '').trim()) {
    db.prepare(
      `INSERT INTO impression_logs (user_id, scope_key, reason, impression, created_at)
       VALUES (?, ?, ?, '', ?)`
    ).run(uid, scopeKey, `[已移除熟人档案] ${String(reason).trim().slice(0, 80)}`, formatNow());
  }
  return { ok: true, cleared: true, user_id: uid, scope: scopeKey };
}

function safeParseArray(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string' && x.trim()) : [];
  } catch {
    return [];
  }
}

/**
 * 根据当前会话事件计算印象库的读写分区（硬隐私隔离边界）
 * @returns {{ writeScope: string, readScopes: string[] }}
 */
export function resolveImpressionScope(
  event,
  { ownerId = null, trustedGroups = [], privateMemoryGroups = [] } = {}
) {
  const trustedSet = new Set((trustedGroups || []).map(String));
  const privateMemSet = new Set((privateMemoryGroups || []).map(String));
  const msgType = event?.message_type;

  if (msgType === 'private') {
    const uid = String(event?.user_id || '').trim();
    if (ownerId && uid === String(ownerId)) {
      // 管理员私聊：全库可读（含各群熟人档案），写入固定落 private 分区
      return { writeScope: 'private', readScopes: ['*'] };
    }
    const scope = `private:${uid || 'unknown'}`;
    return { writeScope: scope, readScopes: [scope] };
  }

  if (msgType === 'group') {
    const gid = String(event?.group_id || '').trim();
    const gScope = `group:${gid}`;
    if (trustedSet.has(gid)) {
      // 信任亲密小群与管理员私聊共享 'private' 分区，同时兼容读取历史群分区记录
      return { writeScope: 'private', readScopes: ['private', gScope] };
    }
    if (privateMemSet.has(gid)) {
      // 熟人互通群：可读私聊印象保持认识连贯，但写入严格留在当前群分区，不污染私聊档案
      return { writeScope: gScope, readScopes: [gScope, 'private'] };
    }
    return { writeScope: gScope, readScopes: [gScope] };
  }

  return { writeScope: 'private', readScopes: ['private'] };
}

/**
 * 被动记录一次人物互动（0 token 消耗）：自动累计互动次数、更新最新昵称并保存曾用名。
 */
export function touchUserInteraction({ userId, nickname = '', scopeKey = 'private' }) {
  const uid = String(userId || '').trim();
  if (!uid || !scopeKey) return;

  const db = getDb();
  const now = Date.now();
  const cleanNick = String(nickname || '').trim().slice(0, 40);

  const row = db
    .prepare('SELECT nickname, aliases, interact_count FROM user_profiles WHERE user_id = ? AND scope_key = ?')
    .get(uid, scopeKey);

  if (!row) {
    db.prepare(
      `INSERT INTO user_profiles
        (user_id, scope_key, nickname, aliases, relation, tags, impression, interact_count, first_seen_at, last_seen_at, updated_at)
       VALUES (?, ?, ?, '[]', '', '[]', '', 1, ?, ?, 0)`
    ).run(uid, scopeKey, cleanNick, now, now);
    return;
  }

  let aliases = safeParseArray(row.aliases);
  const prevNick = String(row.nickname || '').trim();
  const nextNick = cleanNick || prevNick;
  if (cleanNick && prevNick && cleanNick !== prevNick && !aliases.includes(prevNick)) {
    aliases.push(prevNick);
    if (aliases.length > 8) aliases = aliases.slice(-8);
  }

  db.prepare(
    `UPDATE user_profiles
     SET nickname = ?, aliases = ?, interact_count = interact_count + 1, last_seen_at = ?
     WHERE user_id = ? AND scope_key = ?`
  ).run(nextNick, JSON.stringify(aliases), now, uid, scopeKey);
}

/**
 * 主动更新人物印象（由模型工具 chat_impression_update 调用，带冷却与长度硬上限）
 */
export function updateUserImpression({
  userId,
  scopeKey = 'private',
  nickname = '',
  relation = '',
  impression = '',
  tags = [],
  reason = '',
  bypassCooldown = false,
}) {
  const uid = String(userId || '').trim();
  if (!uid) return { ok: false, error: 'user_id 不能为空' };

  const cleanImp = String(impression || '').trim().slice(0, 100);
  const cleanRel = String(relation || '').trim().slice(0, 20);
  const cleanNick = String(nickname || '').trim().slice(0, 40);
  const cleanReason = String(reason || '').trim().slice(0, 120);
  const cleanTags = (Array.isArray(tags) ? tags : String(tags || '').split(/[,，、|]+/))
    .map((t) => String(t || '').trim().slice(0, 12))
    .filter(Boolean)
    .slice(0, 6);

  if (!cleanImp && !cleanRel && cleanTags.length === 0) {
    return { ok: false, error: 'impression、relation、tags 至少需要提供一项有效内容' };
  }

  const cdKey = `${scopeKey}:${uid}`;
  const now = Date.now();
  const prevAt = lastUpdateAt.get(cdKey) || 0;
  if (!bypassCooldown && prevAt && now - prevAt < UPDATE_COOLDOWN_MS) {
    return { ok: false, error: '刚更新过这个人的印象，不用在同一轮里重复修改哦' };
  }

  const db = getDb();
  const row = db
    .prepare('SELECT * FROM user_profiles WHERE user_id = ? AND scope_key = ?')
    .get(uid, scopeKey);

  const nextNick = cleanNick || row?.nickname || '';
  const nextRel = cleanRel || row?.relation || '';
  const nextImp = cleanImp || row?.impression || '';
  const nextTags = cleanTags.length > 0 ? [...new Set(cleanTags)] : safeParseArray(row?.tags);
  let aliases = safeParseArray(row?.aliases);
  if (cleanNick && row?.nickname && cleanNick !== row.nickname && !aliases.includes(row.nickname)) {
    aliases.push(row.nickname);
    if (aliases.length > 8) aliases = aliases.slice(-8);
  }

  if (!row) {
    db.prepare(
      `INSERT INTO user_profiles
        (user_id, scope_key, nickname, aliases, relation, tags, impression, interact_count, first_seen_at, last_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
    ).run(uid, scopeKey, nextNick, JSON.stringify(aliases), nextRel, JSON.stringify(nextTags), nextImp, now, now, now);
  } else {
    db.prepare(
      `UPDATE user_profiles
       SET nickname = ?, aliases = ?, relation = ?, tags = ?, impression = ?, updated_at = ?
       WHERE user_id = ? AND scope_key = ?`
    ).run(nextNick, JSON.stringify(aliases), nextRel, JSON.stringify(nextTags), nextImp, now, uid, scopeKey);
  }

  db.prepare(
    `INSERT INTO impression_logs (user_id, scope_key, reason, impression, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(uid, scopeKey, cleanReason || '日常聊天印象更新', nextImp || nextTags.join('、') || nextRel, formatNow());

  // 每人每分区最多保留最近 30 条演变日志
  db.prepare(
    `DELETE FROM impression_logs
     WHERE user_id = ? AND scope_key = ? AND id NOT IN (
       SELECT id FROM impression_logs
       WHERE user_id = ? AND scope_key = ?
       ORDER BY id DESC LIMIT 30
     )`
  ).run(uid, scopeKey, uid, scopeKey);

  lastUpdateAt.set(cdKey, now);
  return {
    ok: true,
    profile: {
      user_id: uid,
      scope: scopeKey,
      nickname: nextNick,
      relation: nextRel,
      tags: nextTags,
      impression: nextImp,
    },
  };
}

function loadBestProfileForUser(userId, readScopes) {
  const uid = String(userId || '').trim();
  const scopes = (readScopes || []).filter(Boolean);
  if (!uid || scopes.length === 0) return null;

  const db = getDb();
  if (scopes.includes('*')) {
    const row = db
      .prepare(
        `SELECT * FROM user_profiles
         WHERE user_id = ?
         ORDER BY CASE WHEN scope_key = 'private' THEN 0 ELSE 1 END,
                  CASE WHEN impression != '' THEN 0 ELSE 1 END,
                  interact_count DESC,
                  updated_at DESC
         LIMIT 1`
      )
      .get(uid);
    if (!row) return null;
    return {
      user_id: row.user_id,
      scope: row.scope_key,
      nickname: row.nickname || '',
      aliases: safeParseArray(row.aliases),
      relation: row.relation || '',
      tags: safeParseArray(row.tags),
      impression: row.impression || '',
      interact_count: Number(row.interact_count || 0),
      updated_at: Number(row.updated_at || 0),
    };
  }

  for (const sc of scopes) {
    const row = db
      .prepare('SELECT * FROM user_profiles WHERE user_id = ? AND scope_key = ?')
      .get(uid, sc);
    if (row) {
      return {
        user_id: row.user_id,
        scope: row.scope_key,
        nickname: row.nickname || '',
        aliases: safeParseArray(row.aliases),
        relation: row.relation || '',
        tags: safeParseArray(row.tags),
        impression: row.impression || '',
        interact_count: Number(row.interact_count || 0),
        updated_at: Number(row.updated_at || 0),
      };
    }
  }
  return null;
}

function hasMeaningfulImpression(profile) {
  if (!profile) return false;
  return Boolean(profile.impression || profile.relation || (profile.tags && profile.tags.length > 0));
}

/**
 * 供 chat_recall 搭车调用：查询某位用户的完整印象档案与最近演变日志（严格遵循 readScopes 隔离）
 */
export function getUserImpressionDetail({ userId, readScopes = ['private'], logLimit = 3 }) {
  const profile = loadBestProfileForUser(userId, readScopes);
  if (!profile || (!hasMeaningfulImpression(profile) && profile.interact_count < 2)) {
    return null;
  }

  const db = getDb();
  const limit = Math.max(1, Math.min(10, Number(logLimit) || 3));
  const logs = db
    .prepare(
      `SELECT created_at, reason, impression FROM impression_logs
       WHERE user_id = ? AND scope_key = ?
       ORDER BY id DESC LIMIT ?`
    )
    .all(profile.user_id, profile.scope, limit)
    .reverse();

  return {
    user_id: profile.user_id,
    nickname: profile.nickname,
    aliases: profile.aliases,
    relation: profile.relation,
    tags: profile.tags,
    impression: profile.impression,
    interact_count: profile.interact_count,
    recent_changes: logs,
  };
}

/**
 * 供 chat_recall 按 账号或昵称/曾用名搭车查询人物印象详档与演变记录（严格遵循 readScopes 隐私边界）
 */
export function findUserImpressionByQuery({ query = '', fallbackUserId = '', readScopes = ['private'], logLimit = 3 }) {
  const scopes = (readScopes || []).filter(Boolean);
  if (scopes.length === 0) return null;

  const q = String(query || '').trim();
  if (/^\d{5,}$/.test(q)) {
    return getUserImpressionDetail({ userId: q, readScopes: scopes, logLimit });
  }

  if (q.length >= 2) {
    const db = getDb();
    let rows;
    if (scopes.includes('*')) {
      rows = db
        .prepare(
          `SELECT user_id, scope_key, nickname, aliases FROM user_profiles
           ORDER BY CASE WHEN scope_key = 'private' THEN 0 ELSE 1 END, last_seen_at DESC LIMIT 100`
        )
        .all();
    } else {
      const placeholders = scopes.map(() => '?').join(', ');
      rows = db
        .prepare(
          `SELECT user_id, scope_key, nickname, aliases FROM user_profiles
           WHERE scope_key IN (${placeholders})
           ORDER BY last_seen_at DESC LIMIT 80`
        )
        .all(...scopes);
    }
    const qLower = q.toLowerCase();
    for (const row of rows) {
      const names = [row.nickname, ...safeParseArray(row.aliases)]
        .map((s) => String(s || '').trim().toLowerCase())
        .filter((s) => s.length >= 2);
      if (names.some((n) => n === qLower || n.includes(qLower) || qLower.includes(n))) {
        return getUserImpressionDetail({ userId: row.user_id, readScopes: [row.scope_key], logLimit });
      }
    }
  }

  if (fallbackUserId) {
    return getUserImpressionDetail({ userId: fallbackUserId, readScopes: scopes, logLimit });
  }
  return null;
}

/**
 * 1ms 精准捞取本轮相关人物的极简印象行（大群 O(1) 硬封顶，最多 1~2 人，无印象纯路人 0 字注入）
 *
 * 优先级：
 *   1. 当前直接说话的发言人（speakerId）；
 *   2. 被引用消息的作者（quotedUserId）；
 *   3. 本条消息里 @ 提及的人（mentionedUserIds）；
 *   4. 本条消息文本中按名字/曾用名直接点名提到的本分区已建档熟人。
 */
export function findRelevantImpressions({
  speakerId = '',
  quotedUserId = '',
  mentionedUserIds = [],
  botId = '',
  text = '',
  readScopes = ['private'],
  maxUsers = 2,
  maxCharsPerUser = 60,
}) {
  const cap = Math.max(0, Math.min(4, Number(maxUsers) || 0));
  if (cap === 0) return '';

  const scopes = (readScopes || []).filter(Boolean);
  if (scopes.length === 0) return '';

  const selfStr = String(botId || '').trim();
  const orderedIds = [];
  const seen = new Set();
  const pushId = (raw) => {
    const id = String(raw || '').trim();
    if (!id || id === selfStr || seen.has(id)) return;
    seen.add(id);
    orderedIds.push(id);
  };

  pushId(speakerId);
  pushId(quotedUserId);
  for (const mid of mentionedUserIds || []) pushId(mid);

  const selected = [];
  for (const uid of orderedIds) {
    if (selected.length >= cap) break;
    const prof = loadBestProfileForUser(uid, scopes);
    if (hasMeaningfulImpression(prof)) {
      selected.push(prof);
    }
  }

  // 若还有名额，检查文本里是否点名提到了本分区（或主人私聊全库）已有互动的熟人
  // 支持：完整昵称、曾用名，以及 4 字以上中文昵称的前 3 字简称（例如 “橘子汽水冰” 命中 “橘子汽”）
  const cleanText = String(text || '').toLowerCase();
  if (selected.length < cap && cleanText.length >= 2) {
    const db = getDb();
    let rows;
    if (scopes.includes('*')) {
      rows = db
        .prepare(
          `SELECT * FROM user_profiles
           WHERE impression != '' OR relation != '' OR tags != '[]' OR interact_count >= 3
           ORDER BY CASE WHEN scope_key = 'private' THEN 0 ELSE 1 END,
                    CASE WHEN impression != '' THEN 0 ELSE 1 END,
                    interact_count DESC,
                    last_seen_at DESC
           LIMIT 100`
        )
        .all();
    } else {
      const placeholders = scopes.map(() => '?').join(', ');
      rows = db
        .prepare(
          `SELECT * FROM user_profiles
           WHERE scope_key IN (${placeholders})
             AND (impression != '' OR relation != '' OR tags != '[]' OR interact_count >= 3)
           ORDER BY CASE WHEN impression != '' THEN 0 ELSE 1 END,
                    interact_count DESC,
                    last_seen_at DESC
           LIMIT 80`
        )
        .all(...scopes);
    }

    for (const row of rows) {
      if (selected.length >= cap) break;
      const uid = String(row.user_id || '');
      if (!uid || uid === selfStr || seen.has(uid)) continue;
      const rawNames = [row.nickname, ...safeParseArray(row.aliases)]
        .map((s) => String(s || '').trim())
        .filter((s) => s.length >= 2);

      const candidates = new Set();
      for (const n of rawNames) {
        candidates.add(n.toLowerCase());
        // 4 字以上纯中文/中英昵称提取前 3 字简称以兼容日常简称点名
        const cjkPrefix = n.match(/^[\u4e00-\u9fff]{3}/);
        if (n.length >= 4 && cjkPrefix) {
          candidates.add(cjkPrefix[0].toLowerCase());
        }
      }

      if ([...candidates].some((name) => cleanText.includes(name))) {
        seen.add(uid);
        selected.push({
          user_id: uid,
          scope: row.scope_key,
          nickname: row.nickname || uid,
          aliases: safeParseArray(row.aliases),
          relation: row.relation || '',
          tags: safeParseArray(row.tags),
          impression: row.impression || '',
          interact_count: Number(row.interact_count || 0),
        });
      }
    }
  }

  if (selected.length === 0) return '';

  const maxLen = Math.max(20, Math.min(120, Number(maxCharsPerUser) || 60));
  const parts = selected.map((p) => {
    const headBits = [];
    if (p.relation) headBits.push(p.relation);
    if (p.interact_count >= 3) headBits.push(`聊过${p.interact_count}次`);
    const head = headBits.length ? `${p.nickname || p.user_id}(${headBits.join('·')})` : p.nickname || p.user_id;

    const bodyBits = [];
    if (p.impression) bodyBits.push(p.impression);
    if (p.tags && p.tags.length > 0 && bodyBits.join('').length < maxLen - 10) {
      bodyBits.push(`标签:${p.tags.slice(0, 4).join('/')}`);
    }
    const body = bodyBits.length
      ? bodyBits.join('；').slice(0, maxLen)
      : '认识的熟人/群友（细节可用 chat_recall 翻看往事）';
    return `${head}：${body}`;
  });

  return `[相关人物印象：${parts.join(' | ')}]`;
}
