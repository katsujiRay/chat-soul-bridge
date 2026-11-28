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
import { DEFAULT_SLANG_SEEDS } from './slang-seeds.js';

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

/** 第 1 层：幂等预装内置精选种子梗库（INSERT OR IGNORE，绝不覆盖用户或模型改写过的词条） */
export function seedDefaultSlang() {
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO slang_entries
      (term, scope_key, aliases, meaning, reply_guide, source, hit_count, created_at, updated_at)
     VALUES (?, 'global', ?, ?, ?, 'seed', 0, ?, ?)`
  );
  let inserted = 0;
  for (const item of DEFAULT_SLANG_SEEDS) {
    const term = String(item?.term || '').trim();
    if (term.length < 2) continue;
    const aliases = Array.isArray(item.aliases) ? item.aliases.map((a) => String(a || '').trim()).filter(Boolean) : [];
    const res = stmt.run(
      term,
      JSON.stringify(aliases),
      String(item.meaning || '').trim(),
      String(item.replyGuide || '').trim(),
      now,
      now
    );
    if (res.changes > 0) inserted += 1;
  }
  if (inserted > 0) invalidateCache();
  return { inserted, total: DEFAULT_SLANG_SEEDS.length };
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
  { ownerId = null, trustedGroups = [], privateMemoryGroups = [] } = {}
) {
  const ownerStr = String(ownerId ?? '');
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
  const cleanMeaning = String(meaning || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  const cleanGuide = String(replyGuide || '').replace(/\s+/g, ' ').trim().slice(0, 140);
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

/** 将命中的梗条目格式化为极简 Prompt 弹药块（仅当轮注入，不落盘进 context.db） */
export function formatSlangForPrompt(entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const lines = entries.map((e) => {
    const guidePart = e.replyGuide
      ? `｜入戏接法：${e.replyGuide}`
      : '｜入戏接法：直接钻进梗里接下半句、顺着演或反客为主吐槽';
    return `- 「${e.term}」：${e.meaning || '网络/群内热梗'}${guidePart}`;
  });
  return `【本地梗库弹药（直接钻进梗里接下一拍：接下半句 / 顺着演 / 反客为主吐槽；严禁站在戏外点评“又在玩梗/经典老梗”，严禁科普出处报歌名番名）】\n${lines.join('\n')}`;
}

// ── 自动嗅梗：跳戏短语检测 + 24h 负缓存 + 联网确认后自动入库 ─────────────────────

const NON_SLANG_PREFIX_RE =
  /^(?:你好|您好|哈喽|hello|hi|早安|早上好|午安|中午好|晚上好|晚安|在吗|在不在|干嘛|干啥|在干嘛|干什么|吃饭|吃了吗|吃了没|吃饱|下班|上班|回家|睡觉|睡了|起床|醒了|谢谢|多谢|感谢|好的|好嘞|好吧|好呀|收到|明白|知道|没事|没关系|对不起|抱歉|哈哈|呵呵|嘿嘿|嘻嘻|嗯嗯|哦哦|噢噢|拜拜|再见|加油|辛苦|牛逼|厉害|不错|确实|真的|假的|怎么了|咋了|为什么|为啥|什么意思|啥意思|帮我|帮忙|提醒我|查一下|搜一下|今天|明天|昨天|现在|几点|天气|下雨|好冷|好热|好困|好累|好饿|无聊|来了|回来了|出去|买点|喝水|摸鱼)/i;

const FACTUAL_QUESTION_RE = /(?:天气|几点|星期几|几号|价格|多少钱|怎么[办弄做写用买去]|如何|教程|攻略|推荐|对比|区别|翻译|计算|提醒我|帮我|下载|安装|报错|bug)/i;

const MEME_SIGNAL_RE =
  /(?:是什么梗|什么梗|关联梗\/重定向词条|空耳|网络流行语|网络热词|网络用语|成句|段子|表情包|玩梗|热梗|烂梗|恶搞|弹幕|鬼畜|名台词|台词|流行起来|谐音梗|出自.*(?:歌|曲|番|动漫|动画|游戏|电影|视频)|梗出处|梗百科|梗指南|梗Wiki)/i;

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
    .slice(0, 200);
  if (!summary) {
    recordMissCache(term);
    return null;
  }

  const saved = upsertSlangEntry({
    term,
    meaning: summary,
    replyGuide: '直接钻进梗里接下半句、顺着画面演或反客为主吐槽，严禁戏外点评“又在玩梗”或报出处歌名番名',
    source: 'web',
    scopeKey: 'global',
  });

  if (saved?.ok && saved.entry) {
    log(`[slang] 自动嗅出热梗并入库: 「${term}」 -> ${summary.slice(0, 50)}`);
    return saved.entry;
  }
  return null;
}

// ── 第 2 层：群聊高频重复词 0 成本捕捉（跨发言者最长公共子串，无标点也能抽词） ───────

const repeatWindows = new Map(); // chatKey -> [{ userId, text, ts }]
const inFlightSniffs = new Set();

const EDGE_GLUE_CHARS = new Set(
  '的了么吗呢啊吧呀哈哦嗯就都是有不在也还这那我你他她它很太真和跟与或但又被把给'.split('')
);

const REPEAT_COMMON_PHRASE_RE =
  /^(?:什么意思|不知道|知不知道|有没有|还可以|差不多|没关系|怎么回事|什么时候|为什么|真的假的|感觉还行|今天晚上|明天早上|明天下午|等一下|看一下|试一下|买一个|吃什么|点外卖|喝奶茶|玩游戏|打游戏|写代码|睡觉了|上班了|下班了|回家了|太好了|好厉害|真不错|有点东西|确实不错|不好意思|对不起|谢谢你|辛苦了|加油啊|没事吧|怎么了|发生什么|可以可以|好的好的|哈哈哈哈|呜呜呜|笑死我了|我也是|我觉得|我认为|我感觉|其实吧|但是呢|然后呢|所以呢|不过呢)$/i;

function normalizeForLcs(rawText, botKeywords = []) {
  let s = String(rawText || '').trim();
  if (!s || /https?:\/\/|\[合并转发|\[图片|\[引用/.test(s)) return '';
  for (const kw of botKeywords || []) {
    const k = String(kw || '').trim();
    if (k.length >= 2) {
      const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      s = s.replace(new RegExp(escaped, 'gi'), ' ');
    }
  }
  return s.replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** 抽离两段发言之间 3~8 字的无标点最长公共实词片段 */
function extractSharedPhrases(a, b) {
  const segsA = a.match(/[\u4e00-\u9fa5a-zA-Z0-9]{3,}/g) || [];
  const segsB = b.match(/[\u4e00-\u9fa5a-zA-Z0-9]{3,}/g) || [];
  if (segsA.length === 0 || segsB.length === 0) return [];

  const found = new Set();
  for (const sa of segsA) {
    const la = sa.toLowerCase();
    for (const sb of segsB) {
      const lb = sb.toLowerCase();
      // 滑动查找最大公共连续片段
      const m = la.length;
      const n = lb.length;
      let prev = new Int16Array(n + 1);
      for (let i = 1; i <= m; i++) {
        const cur = new Int16Array(n + 1);
        for (let j = 1; j <= n; j++) {
          if (la[i - 1] === lb[j - 1]) {
            cur[j] = prev[j - 1] + 1;
            const len = cur[j];
            // 仅在极大匹配结束位置或到达上限 8 时采样
            const isMaximal = i === m || j === n || la[i] !== lb[j];
            if (len >= 3 && (isMaximal || len === 8)) {
              const takeLen = Math.min(8, len);
              found.add(sa.slice(i - takeLen, i));
            }
          }
        }
        prev = cur;
      }
    }
  }
  return [...found];
}

function cleanRepeatCandidate(raw) {
  let s = String(raw || '').trim();
  while (s.length > 0 && EDGE_GLUE_CHARS.has(s[0])) s = s.slice(1);
  while (s.length > 0 && EDGE_GLUE_CHARS.has(s[s.length - 1])) s = s.slice(0, -1);
  s = s.trim();
  if (s.length < 3 || s.length > 8) return '';
  if (/^\d+$/.test(s) || /^(.)\1+$/.test(s)) return '';
  if (NON_SLANG_PREFIX_RE.test(s) || FACTUAL_QUESTION_RE.test(s) || REPEAT_COMMON_PHRASE_RE.test(s)) return '';
  return s;
}

/**
 * 监听每条群消息（包括未触发回复的旁听水聊），0 成本检测跨发言者重复出现的疑似新梗短语。
 * 返回被触发的候选词（无则空字符串），用于后台异步验真入库（0ms 不阻塞当前消息）。
 */
export function observeGroupSlangRepeat({
  chatKey,
  userId,
  text,
  readScopes = ['global'],
  botKeywords = [],
  windowMs = 45 * 60 * 1000,
  minSpeakers = 2,
  missCacheHours = 24,
}) {
  const key = String(chatKey || '');
  const uid = String(userId || '');
  if (!key || !uid) return '';
  const clean = normalizeForLcs(text, botKeywords);
  if (clean.length < 3) return '';

  const now = Date.now();
  const cutoff = now - Math.max(60000, Number(windowMs) || 45 * 60 * 1000);
  const buf = (repeatWindows.get(key) || []).filter((item) => item.ts >= cutoff);

  const candidateSpeakers = new Map(); // phrase -> Set(userId)
  for (const prev of buf) {
    if (prev.userId === uid) continue;
    const shared = extractSharedPhrases(clean, prev.text);
    for (const rawPhrase of shared) {
      const cand = cleanRepeatCandidate(rawPhrase);
      if (!cand) continue;
      if (!candidateSpeakers.has(cand)) candidateSpeakers.set(cand, new Set([uid]));
      candidateSpeakers.get(cand).add(prev.userId);
    }
  }

  buf.push({ userId: uid, text: clean, ts: now });
  if (buf.length > 40) buf.splice(0, buf.length - 40);
  repeatWindows.set(key, buf);

  const reqSpeakers = Math.max(2, Number(minSpeakers) || 2);
  const ranked = [...candidateSpeakers.entries()]
    .filter(([, set]) => set.size >= reqSpeakers)
    .sort((a, b) => b[1].size - a[1].size || b[0].length - a[0].length);

  for (const [cand] of ranked) {
    const lowerCand = cand.toLowerCase();
    if (inFlightSniffs.has(lowerCand)) continue;
    if (isMissCached(cand, missCacheHours)) continue;
    if (findMatchingSlang(cand, readScopes, { maxHits: 1 }).length > 0) continue;
    return cand;
  }
  return '';
}

/** 监听群重复词并在后台异步验真入库（不阻塞主消息流） */
export function observeAndSniffGroupRepeat({
  chatKey,
  userId,
  text,
  readScopes = ['global'],
  botKeywords = [],
  windowMs = 45 * 60 * 1000,
  minSpeakers = 2,
  missCacheHours = 24,
  searchFn,
  timeoutMs = 3500,
  log = () => {},
}) {
  const cand = observeGroupSlangRepeat({
    chatKey,
    userId,
    text,
    readScopes,
    botKeywords,
    windowMs,
    minSpeakers,
    missCacheHours,
  });
  if (!cand || typeof searchFn !== 'function') return null;

  const lowerCand = cand.toLowerCase();
  inFlightSniffs.add(lowerCand);
  const promise = sniffAndLearnSlang({
    candidate: cand,
    searchFn,
    timeoutMs,
    log: (msg, ...rest) => log(`[slang:repeat] ${msg}`, ...rest),
  })
    .catch(() => null)
    .finally(() => {
      inFlightSniffs.delete(lowerCand);
    });
  return { candidate: cand, promise };
}

// ── 第 3 层：回复后后台异步偷学（可选开关，0ms 回复延迟，专抓嵌在长句里的新梗/群黑话） ──

const lastAsyncLearnAt = new Map();

function parseLlmSlangJson(raw) {
  const s = String(raw || '').trim();
  if (!s || /^none$/i.test(s)) return [];
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : s;
  const arrMatch = body.match(/\[[\s\S]*\]/);
  if (!arrMatch) return [];
  try {
    const parsed = JSON.parse(arrMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((it) => it && typeof it.term === 'string' && it.term.trim().length >= 2 && it.term.trim().length <= 16)
      .slice(0, 2);
  } catch {
    return [];
  }
}

/**
 * 后台异步复盘偷学：在主回复已经发出去之后悄悄执行（0ms 不拖慢回复）。
 *   - 抽出消息里伪装成普通词的新网络梗或本群内部黑话；
 *   - type="public" 的网络梗必须经过联网验真才写入 global（严防模型幻觉污染全局库）；
 *   - type="group" 的本群自造黑话写入当前会话隔离区 writeScope，绝不跨外群泄露。
 */
export async function asyncLearnSlangWithLlm({
  chatKey,
  rawText,
  recentMessages = [],
  existingHits = [],
  slangScope,
  quickClient,
  preferredModel = '',
  searchFn,
  timeoutMs = 3500,
  cooldownMs = 30000,
  log = () => {},
}) {
  if (!quickClient || typeof quickClient.quickText !== 'function') return [];
  const text = String(rawText || '').trim();
  if (text.length < 4 || /https?:\/\/|\[合并转发/.test(text)) return [];

  const now = Date.now();
  const prevAt = lastAsyncLearnAt.get(chatKey) || 0;
  if (now - prevAt < Math.max(5000, Number(cooldownMs) || 30000)) return [];
  lastAsyncLearnAt.set(chatKey, now);

  const knownTerms = (existingHits || []).map((h) => h.term).filter(Boolean);
  const recentCtx = (recentMessages || [])
    .slice(-3)
    .map((m) => `${m.sender || ''}: ${String(m.text || '').slice(0, 60)}`)
    .join('\n');

  const prompt =
    '你是中文群聊热梗提取器。检查下面【当前消息】里是否藏着【尚未收录】的中文网络热梗、空耳、弹幕黑话或明显的群内自造黑话（哪怕没有引号、伪装成普通词语）。\n' +
    '普通日常词语、人名、地名、正常提问一律忽略，宁缺毋滥。\n' +
    (knownTerms.length > 0 ? `已收录（不要重复输出）：${knownTerms.join('、')}\n` : '') +
    (recentCtx ? `【前文背景】\n${recentCtx}\n` : '') +
    `【当前消息】\n${text.slice(0, 200)}\n` +
    '如果没有新梗，只输出 NONE。\n' +
    '如果有，最多抽 2 个，严格只输出 JSON 数组：[{"term":"原词","type":"public或group","meaning":"一句大白话含义","reply_guide":"一句口语怎么接茬"}]';

  let rawOut = '';
  try {
    rawOut = await quickClient.quickText(prompt, { preferredModel, maxTokens: 240 });
  } catch {
    return [];
  }

  const items = parseLlmSlangJson(rawOut);
  if (items.length === 0) return [];

  const readScopes = slangScope?.readScopes || ['global'];
  const writeScope = slangScope?.writeScope || 'private';
  const learned = [];

  for (const item of items) {
    const term = String(item.term || '').trim();
    if (term.length < 2 || !text.toLowerCase().includes(term.toLowerCase())) continue;
    // 已收录则跳过
    const already = findMatchingSlang(term, readScopes, { maxHits: 1 }).some(
      (h) => h.term.toLowerCase() === term.toLowerCase()
    );
    if (already) continue;

    const kind = String(item.type || 'public').trim().toLowerCase();
    const meaning = String(item.meaning || '').trim().slice(0, 120);
    const replyGuide = String(item.reply_guide || '').trim().slice(0, 100);

    if (kind === 'group') {
      if (!meaning) continue;
      const saved = upsertSlangEntry({
        term,
        meaning,
        replyGuide: replyGuide || '顺着群友的话茬自然调侃接一句',
        source: 'llm_async',
        scopeKey: writeScope,
      });
      if (saved?.ok && saved.entry) {
        log(`[slang:async] 后台偷学群内黑话(${writeScope}): 「${term}」`);
        learned.push(saved.entry);
      }
      continue;
    }

    // public 网络梗必须经过联网验真，防幻觉污染全局库
    if (typeof searchFn === 'function' && !isMissCached(term, 24)) {
      const verified = await sniffAndLearnSlang({
        candidate: term,
        searchFn,
        timeoutMs,
        log: (msg, ...rest) => log(`[slang:async] ${msg}`, ...rest),
      });
      if (verified) {
        if (replyGuide) {
          upsertSlangEntry({
            term: verified.term,
            meaning: verified.meaning,
            replyGuide,
            source: 'web',
            scopeKey: 'global',
          });
          verified.replyGuide = replyGuide;
        }
        learned.push(verified);
      }
    }
  }

  return learned;
}
