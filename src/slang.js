/**
 * 本地梗/热词数据库与自动嗅梗引擎（基于 Node 22 原生 node:sqlite，零外部依赖）
 *
 * 持久化位置：state/slang.db（SQLite WAL 模式）
 *
 * 核心能力：
 *   1. 0.1ms 本地命中（findMatchingSlang）：每轮触发回复前扫描已入库的网络热梗与群内私有梗，
 *      哪怕嵌在长句里也能瞬间认出，并注入「含义 + 口语接法」提示（严禁科普出处）；
 *   2. 自动嗅梗入库（extractAbruptSlangCandidate + sniffAndLearnSlang）：
 *      针对突然跳戏的 2~12 字短语（与近 5 条上下文无实词重合、非日常寒暄），
 *      由桥接主动限时搜索「<词> 是什么梗 空耳 萌娘百科」，确认是热梗即自动入库 global，
 *      非热梗写入 24h 负缓存避免重复搜索；
 *   3. 严格隐私隔离（scope_key 分区）：
 *      - 网络公开热梗存入 'global'（全聊通用）；
 *      - 群内自造梗/私密梗按 'private'（主人私聊/亲密小群）或 'group:<群号>' 隔离，绝不跨外群泄露。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const STATE_DIR = path.resolve(process.cwd(), 'state');
const DB_PATH = path.join(STATE_DIR, 'slang.db');

let dbInstance = null;
let cachedEntries = null; // 内存缓存，upsert/delete 时自动失效，保证查询 <0.1ms

export function getSlangDbPath() {
  return DB_PATH;
}

function getDb() {
  if (dbInstance) return dbInstance;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS slang_entries (
      term TEXT NOT NULL,
      scope_key TEXT NOT NULL DEFAULT 'global',
      aliases TEXT NOT NULL DEFAULT '[]',
      meaning TEXT NOT NULL DEFAULT '',
      reply_guide TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'web',
      hit_count INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (term, scope_key)
    );
    CREATE INDEX IF NOT EXISTS idx_slang_scope_hits
      ON slang_entries(scope_key, hit_count DESC, updated_at DESC);

    CREATE TABLE IF NOT EXISTS slang_miss_cache (
      query TEXT PRIMARY KEY,
      checked_at INTEGER NOT NULL DEFAULT 0
    );
  `);
  dbInstance = db;
  return db;
}

export function ensureSlangDb() {
  const existed = fs.existsSync(DB_PATH);
  getDb();
  return existed;
}

function parseJsonArray(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.map((s) => String(s || '').trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function invalidateCache() {
  cachedEntries = null;
}

function loadAllEntriesCached() {
  if (cachedEntries) return cachedEntries;
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT term, scope_key, aliases, meaning, reply_guide, source, hit_count, created_at, updated_at
         FROM slang_entries
        ORDER BY length(term) DESC, hit_count DESC, updated_at DESC`
    )
    .all();
  cachedEntries = rows.map((r) => {
    const aliases = parseJsonArray(r.aliases);
    const matchers = [...new Set([r.term, ...aliases].map((s) => String(s || '').trim()).filter((s) => s.length >= 2))]
      .sort((a, b) => b.length - a.length);
    return {
      term: r.term,
      scopeKey: r.scope_key,
      aliases,
      matchers,
      meaning: r.meaning,
      replyGuide: r.reply_guide,
      source: r.source,
      hitCount: Number(r.hit_count || 0),
      createdAt: Number(r.created_at || 0),
      updatedAt: Number(r.updated_at || 0),
    };
  });
  return cachedEntries;
}

/** 计算当前会话允许读取/写入的梗库分区（公开网络梗始终在 global，群内私有梗严格按群隔离） */
export function resolveSlangScope(
  event,
  { ownerId = null, ownerQQ = null, trustedGroups = [], privateMemoryGroups = [] } = {}
) {
  const ownerStr = String(ownerId ?? ownerQQ ?? '');
  const trustedSet = new Set((trustedGroups || []).map(String));
  const privateMemSet = new Set((privateMemoryGroups || []).map(String));

  if (event?.message_type === 'private') {
    const uid = String(event.user_id || '');
    if (ownerStr && uid === ownerStr) {
      return { writeScope: 'private', readScopes: ['global', 'private'] };
    }
    const ownScope = `private:${uid}`;
    return { writeScope: ownScope, readScopes: ['global', ownScope] };
  }

  const gid = String(event?.group_id || '');
  if (gid && trustedSet.has(gid)) {
    return { writeScope: 'private', readScopes: ['global', 'private'] };
  }
  const grpScope = `group:${gid}`;
  if (gid && privateMemSet.has(gid)) {
    return { writeScope: grpScope, readScopes: ['global', grpScope, 'private'] };
  }
  return { writeScope: grpScope, readScopes: ['global', grpScope] };
}

/** 写入或更新一条梗记录（同名同分区自动合并别名与内容） */
export function upsertSlangEntry({
  term,
  aliases = [],
  meaning = '',
  replyGuide = '',
  source = 'group',
  scopeKey = 'global',
}) {
  const cleanTerm = String(term || '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 40);
  if (cleanTerm.length < 2) {
    return { ok: false, error: '梗词条至少需要 2 个字' };
  }
  const cleanScope = String(scopeKey || 'global').trim() || 'global';
  const cleanMeaning = String(meaning || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const cleanGuide = String(replyGuide || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const cleanAliases = (Array.isArray(aliases) ? aliases : String(aliases || '').split(/[,，/、|]/))
    .map((s) => String(s || '').trim())
    .filter((s) => s.length >= 2 && s !== cleanTerm)
    .slice(0, 8);

  const db = getDb();
  const now = Date.now();
  const existing = db
    .prepare('SELECT aliases, meaning, reply_guide, hit_count, created_at FROM slang_entries WHERE term = ? AND scope_key = ?')
    .get(cleanTerm, cleanScope);

  if (existing) {
    const mergedAliases = [...new Set([...parseJsonArray(existing.aliases), ...cleanAliases])].slice(0, 10);
    const nextMeaning = cleanMeaning || existing.meaning;
    const nextGuide = cleanGuide || existing.reply_guide;
    db.prepare(
      `UPDATE slang_entries
          SET aliases = ?, meaning = ?, reply_guide = ?, source = ?, hit_count = hit_count + 1, updated_at = ?
        WHERE term = ? AND scope_key = ?`
    ).run(JSON.stringify(mergedAliases), nextMeaning, nextGuide, String(source || 'group'), now, cleanTerm, cleanScope);
    invalidateCache();
    return {
      ok: true,
      updated: true,
      entry: {
        term: cleanTerm,
        scopeKey: cleanScope,
        aliases: mergedAliases,
        meaning: nextMeaning,
        replyGuide: nextGuide,
        source: String(source || 'group'),
      },
    };
  }

  db.prepare(
    `INSERT INTO slang_entries (term, scope_key, aliases, meaning, reply_guide, source, hit_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(
    cleanTerm,
    cleanScope,
    JSON.stringify(cleanAliases),
    cleanMeaning,
    cleanGuide,
    String(source || 'group'),
    now,
    now
  );
  // 若之前误进过负缓存，立即清除
  db.prepare('DELETE FROM slang_miss_cache WHERE query = ?').run(cleanTerm.toLowerCase());
  invalidateCache();

  return {
    ok: true,
    created: true,
    entry: {
      term: cleanTerm,
      scopeKey: cleanScope,
      aliases: cleanAliases,
      meaning: cleanMeaning,
      replyGuide: cleanGuide,
      source: String(source || 'group'),
    },
  };
}

/** 删除指定梗词条（仅允许删当前会话可见分区内的条目） */
export function deleteSlangEntry(term, readScopes = ['global']) {
  const cleanTerm = String(term || '').trim();
  if (!cleanTerm) return { ok: false, error: '请指定要删除的梗词条' };
  const scopes = Array.isArray(readScopes) && readScopes.length > 0 ? readScopes : ['global'];
  const db = getDb();
  const placeholders = scopes.map(() => '?').join(', ');
  const res = db
    .prepare(`DELETE FROM slang_entries WHERE term = ? AND scope_key IN (${placeholders})`)
    .run(cleanTerm, ...scopes);
  if (res.changes > 0) {
    invalidateCache();
    return { ok: true, deleted: cleanTerm, count: res.changes };
  }
  return { ok: false, error: `未找到可删除的梗词条「${cleanTerm}」` };
}

/** 列出或按关键词检索本地梗库 */
export function listSlangEntries({ readScopes = ['global'], query = '', limit = 20 } = {}) {
  const scopeSet = new Set(Array.isArray(readScopes) && readScopes.length > 0 ? readScopes : ['global']);
  const q = String(query || '').trim().toLowerCase();
  const maxN = Math.max(1, Math.min(50, Number(limit) || 20));
  const all = loadAllEntriesCached();
  const matched = [];
  for (const item of all) {
    if (!scopeSet.has(item.scopeKey)) continue;
    if (q) {
      const hay = `${item.term} ${item.aliases.join(' ')} ${item.meaning} ${item.replyGuide}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    matched.push({
      term: item.term,
      scope: item.scopeKey,
      aliases: item.aliases,
      meaning: item.meaning,
      reply_guide: item.replyGuide,
      source: item.source,
      hit_count: item.hitCount,
    });
    if (matched.length >= maxN) break;
  }
  return matched;
}

/** 0.1ms 本地梗库扫描：在输入文本中查找匹配的梗（支持长句内嵌、别名匹配与分区隔离） */
export function findMatchingSlang(text, readScopes = ['global'], { maxHits = 2 } = {}) {
  const raw = String(text || '').trim();
  if (raw.length < 2) return [];
  const lower = raw.toLowerCase();
  const scopeSet = new Set(Array.isArray(readScopes) && readScopes.length > 0 ? readScopes : ['global']);
  const entries = loadAllEntriesCached();
  const hits = [];
  const seenTerms = new Set();

  for (const item of entries) {
    if (!scopeSet.has(item.scopeKey)) continue;
    if (seenTerms.has(item.term)) continue;
    let matchedBy = '';
    for (const m of item.matchers) {
      if (lower.includes(m.toLowerCase())) {
        matchedBy = m;
        break;
      }
    }
    if (matchedBy) {
      seenTerms.add(item.term);
      hits.push({ ...item, matchedBy });
    }
  }

  // 优先返回匹配更长、更贴近当前私有分区的词条
  hits.sort((a, b) => {
    const scopeDiff = (a.scopeKey === 'global' ? 0 : 1) - (b.scopeKey === 'global' ? 0 : 1);
    if (scopeDiff !== 0) return -scopeDiff;
    return b.matchedBy.length - a.matchedBy.length || b.hitCount - a.hitCount;
  });

  const picked = hits.slice(0, Math.max(1, Number(maxHits) || 2));
  if (picked.length > 0) {
    try {
      const db = getDb();
      const now = Date.now();
      const stmt = db.prepare('UPDATE slang_entries SET hit_count = hit_count + 1, updated_at = ? WHERE term = ? AND scope_key = ?');
      for (const p of picked) {
        stmt.run(now, p.term, p.scopeKey);
        p.hitCount += 1;
      }
    } catch {}
  }
  return picked;
}

/** 将命中的梗条目格式化为极简 Prompt 提示块（仅当轮注入，不落盘进 context.db） */
export function formatSlangForPrompt(entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const lines = entries.map((e) => {
    const guidePart = e.replyGuide ? `｜接法：${e.replyGuide}` : '｜接法：顺嘴玩梗或吐槽，禁科普出处';
    return `- 「${e.term}」：${e.meaning || '网络/群内热梗'}${guidePart}`;
  });
  return `【本地梗库提示（仅供你瞬间秒懂接茬，严禁像百科一样科普出处、报歌名或番名）】\n${lines.join('\n')}`;
}

// ── 自动嗅梗：跳戏短语检测 + 24h 负缓存 + 联网确认后自动入库 ─────────────────────

const NON_SLANG_PREFIX_RE =
  /^(?:你好|您好|哈喽|hello|hi|早安|早上好|午安|中午好|晚上好|晚安|在吗|在不在|干嘛|干啥|在干嘛|干什么|吃饭|吃了吗|吃了没|吃饱|下班|上班|回家|睡觉|睡了|起床|醒了|谢谢|多谢|感谢|好的|好嘞|好吧|好呀|收到|明白|知道|没事|没关系|对不起|抱歉|哈哈|呵呵|嘿嘿|嘻嘻|嗯嗯|哦哦|噢噢|拜拜|再见|加油|辛苦|牛逼|厉害|不错|确实|真的|假的|怎么了|咋了|为什么|为啥|什么意思|啥意思|帮我|帮忙|提醒我|查一下|搜一下|今天|明天|昨天|现在|几点|天气|下雨|好冷|好热|好困|好累|好饿|无聊|来了|回来了|出去|买点|喝水|摸鱼)/i;

const FACTUAL_QUESTION_RE = /(?:天气|几点|星期几|几号|价格|多少钱|怎么[办弄做写用买去]|如何|教程|攻略|推荐|对比|区别|翻译|计算|提醒我|帮我|下载|安装|报错|bug)/i;

const MEME_SIGNAL_RE =
  /(?:是什么梗|什么梗|空耳|萌娘百科|网络流行语|网络热词|网络用语|玩梗|热梗|烂梗|弹幕|鬼畜|名台词|谐音梗|亚文化|B站|bilibili|出自.*(?:歌|曲|番|动漫|动画|游戏|电影|视频)|梗出处|梗百科|梗指南)/i;

const CONTEXT_STOP_2GRAMS = new Set([
  '什么', '怎么', '这个', '那个', '就是', '不是', '还是', '可以', '一下', '我们', '你们', '他们',
  '哈哈', '真的', '没有', '现在', '今天', '明天', '刚才', '有点', '一点', '不要', '不能',
]);

function isMissCached(query, missCacheHours = 24) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  try {
    const db = getDb();
    const row = db.prepare('SELECT checked_at FROM slang_miss_cache WHERE query = ?').get(q);
    if (!row) return false;
    const ttlMs = Math.max(1, Number(missCacheHours) || 24) * 3600 * 1000;
    return Date.now() - Number(row.checked_at || 0) < ttlMs;
  } catch {
    return false;
  }
}

function recordMissCache(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return;
  try {
    const db = getDb();
    db.prepare(
      'INSERT OR REPLACE INTO slang_miss_cache (query, checked_at) VALUES (?, ?)'
    ).run(q, Date.now());
  } catch {}
}

/**
 * 0ms 跳戏短语检测：判断当前消息是不是“突然冒出的疑似玩梗短语”（不依赖模型自己开窍）。
 * 返回清洗后的候选词，不符合条件返回空字符串。
 */
export function extractAbruptSlangCandidate(
  rawText,
  recentMessages = [],
  { botKeywords = [], missCacheHours = 24 } = {}
) {
  let clean = String(rawText || '').trim();
  if (!clean) return '';
  if (/https?:\/\/|\[合并转发|\[图片|\[引用/.test(clean)) return '';

  // 剥离机器人唤醒词/昵称（如 “机器人 某热梗！” -> “某热梗”）
  for (const kw of botKeywords || []) {
    const k = String(kw || '').trim();
    if (k.length >= 2) {
      const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      clean = clean.replace(new RegExp(escaped, 'gi'), ' ');
    }
  }
  clean = clean
    .replace(/^[，,。.!！?？~～…·\s"'“”‘’「」【】()（）:：;；]+|[，,。.!！?？~～…·\s"'“”‘’「」【】()（）:：;；]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (clean.length < 2 || clean.length > 12) return '';
  if (/^\d+$/.test(clean)) return '';
  if (/^(.)\1+$/.test(clean)) return ''; // 纯叠字如 哈哈哈 / ？？
  if (NON_SLANG_PREFIX_RE.test(clean) || FACTUAL_QUESTION_RE.test(clean)) return '';

  // 检查是否与近 5 条上下文有实词重合（若有重合，说明是在延续刚才的话题而非突然跳戏抛梗）
  const recentText = (Array.isArray(recentMessages) ? recentMessages.slice(-5) : [])
    .map((m) => String(m?.text || '').toLowerCase())
    .join('\n');
  if (recentText) {
    const lowerClean = clean.toLowerCase();
    const spans = lowerClean.match(/[\u4e00-\u9fa5a-z0-9]{2,}/g) || [];
    for (const span of spans) {
      for (let i = 0; i + 2 <= span.length; i++) {
        const gram = span.slice(i, i + 2);
        if (CONTEXT_STOP_2GRAMS.has(gram)) continue;
        if (recentText.includes(gram)) return '';
      }
    }
  }

  if (isMissCached(clean, missCacheHours)) return '';
  return clean;
}

/**
 * 自动联网嗅梗并入库：
 *   - 使用「<词> 是什么梗 空耳 萌娘百科」限时搜索；
 *   - 仅当标题/摘要明确包含强梗信号词且与原词相关时，才自动入库 state/slang.db（global）并返回；
 *   - 确认不是梗时写入 24h 负缓存，0 字节注入不打扰正常对话。
 */
export async function sniffAndLearnSlang({
  candidate,
  searchFn,
  timeoutMs = 2800,
  log = () => {},
}) {
  const term = String(candidate || '').trim();
  if (!term || typeof searchFn !== 'function') return null;

  let res = null;
  try {
    const query = `${term} 是什么梗 空耳 萌娘百科`;
    const timer = new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), Math.max(1000, timeoutMs)));
    res = await Promise.race([searchFn(query, 3, { intent: 'meme' }), timer]);
  } catch {
    return null;
  }

  if (!res || res.timeout || !res.ok || !Array.isArray(res.results) || res.results.length === 0) {
    return null; // 超时或网络失败不污染负缓存
  }

  const termLower = term.toLowerCase();
  const coreChars = termLower.replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
  let best = null;
  for (const r of res.results) {
    const title = String(r?.title || '');
    const snippet = String(r?.snippet || '');
    const combined = `${title} ${snippet}`;
    if (!MEME_SIGNAL_RE.test(combined)) continue;
    const combLower = combined.toLowerCase();
    // 至少包含完整词或前两个核心字符，防止搜偏误入无关梗
    const relevant =
      combLower.includes(termLower) ||
      (coreChars.length >= 2 && combLower.includes(coreChars.slice(0, Math.min(3, coreChars.length))));
    if (!relevant) continue;
    best = { title, snippet };
    break;
  }

  if (!best) {
    recordMissCache(term);
    return null;
  }

  const summary = (best.snippet || best.title)
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 110);
  if (!summary) {
    recordMissCache(term);
    return null;
  }

  const saved = upsertSlangEntry({
    term,
    meaning: summary,
    replyGuide: '顺嘴玩梗、接下半句或自然吐槽，严禁像百科一样报出处、歌名或番名',
    source: 'web',
    scopeKey: 'global',
  });

  if (saved?.ok && saved.entry) {
    log(`[slang] 自动嗅出热梗并入库: 「${term}」 -> ${summary.slice(0, 50)}`);
    return saved.entry;
  }
  return null;
}
