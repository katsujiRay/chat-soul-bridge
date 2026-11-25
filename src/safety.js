/**
 * 统一风控、限流、发包节流与外发内容审计模块（src/safety.js）
 *
 * 能力覆盖：
 *   1. 双层滑窗发送频率上限（单会话每分钟/每小时 + 全账号每分钟/每小时），支持预占额度与失败自动回滚；
 *   2. 分场景唤醒限流（群聊自然插话 / 群聊显式触发 / 私聊独立配额），防止消息洪峰刷爆额度又不误伤私聊热聊；
 *   3. 轻量级全局发包节流锁（仅串行单次 HTTP 发包 + minGlobalSendGapMs 最小间距，不阻塞其他会话的思考与分条停顿）；
 *   4. 外发敏感信息审计（启发式本机路径/凭据正则 SENSITIVE_RE + 运行时环境变量密钥精确命中；刻意不拦 32 位 hex 防误杀图片/表情 MD5）；
 *   5. OneBot retcode / status 异常监测与连续失败自动冷却熔断；
 *   6. 限流时间戳持久化至 state/rate-limit.json（防抖原子写入，重启保留小时级配额，数组自动封顶裁剪）。
 */
import fs from 'node:fs';
import path from 'node:path';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MAX_TIMESTAMPS = 500;

/**
 * 启发式敏感外发正则（参考 qq-bridge sensitive.js 实战经验）：
 *   - 拦截本机绝对路径（Windows 盘符路径、UNC 共享路径、Linux/macOS 系统路径）
 *   - 拦截凭据赋值（token/password/secret/api_key/authorization/bearer/credential 等）
 *   - 注意：刻意不匹配裸 32 位十六进制字符串（[0-9a-f]{32}），避免误杀正常图片/表情 MD5 与 URL。
 */
export const SENSITIVE_RE =
  /((?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|]+|\\\\[^\\\s"'<>|]+\\[^\s"'<>|]+|(?<![A-Za-z0-9])(?:\/home\/|\/Users\/|\/etc\/|\/var\/|\/root\/)[^\s"'<>|]*|(?:token|密码|密钥|口令|password|passwd|secret|api[_-]?key|authorization|bearer|access[_-]?key|credential)["']?(?:\s*(?:[:=：]|是|为)\s*["']?[^\s，。；、"']{3,}|\s+[A-Za-z0-9_\-./]{3,}))/i;

/** 需要纳入外发风控与频控拦截的 OneBot 发送类 action */
export const SEND_ACTIONS = new Set([
  'send_private_msg',
  'send_group_msg',
  'send_msg',
  'send_private_forward_msg',
  'send_group_forward_msg',
  'forward_friend_single_msg',
  'forward_group_single_msg',
  'send_poke',
  'group_poke',
  'friend_poke',
]);

/** 从环境变量中收集已知密钥原文（长度 >= 16），与启发式正则互补 */
const SECRET_ENV_NAME_RE = /(?:API_KEY|ACCESS_TOKEN|SECRET|PASSWORD|PASSWD|AUTH_TOKEN|PRIVATE_KEY|COOKIE)/i;

export function collectRuntimeSecrets(extraSecrets = []) {
  const secrets = new Set();
  for (const [k, v] of Object.entries(process.env)) {
    if (!SECRET_ENV_NAME_RE.test(k)) continue;
    const val = String(v || '').trim();
    if (val.length >= 16) secrets.add(val);
  }
  for (const item of extraSecrets || []) {
    const val = String(item || '').trim();
    if (val.length >= 16) secrets.add(val);
  }
  return [...secrets];
}

/** 从 OneBot payload 中提取可见纯文本（跳过 base64 图片/语音/文件 URL，避免误杀媒体载荷） */
export function extractTextFromOneBotPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const chunks = [];

  const collectMessage = (msg) => {
    if (typeof msg === 'string') {
      // 剔除 CQ 码中的 file=base64://... 与 url=... 字段后再审计文本
      const cleaned = msg.replace(/\[CQ:(?:image|record|video|file),[^\]]*\]/gi, '');
      if (cleaned) chunks.push(cleaned);
      return;
    }
    if (Array.isArray(msg)) {
      for (const seg of msg) {
        if (!seg || typeof seg !== 'object') continue;
        if (seg.type === 'text' && typeof seg.data?.text === 'string') {
          chunks.push(seg.data.text);
        } else if (seg.type === 'node') {
          if (typeof seg.data?.name === 'string') chunks.push(seg.data.name);
          if (seg.data?.content !== undefined) collectMessage(seg.data.content);
        }
      }
    }
  };

  if (payload.message !== undefined) collectMessage(payload.message);
  if (Array.isArray(payload.messages)) collectMessage(payload.messages);
  return chunks.join('\n').trim();
}

/** 根据 OneBot action 与 payload 推导标准化 chatKey */
export function resolveChatKeyFromPayload(action, payload) {
  if (!payload || typeof payload !== 'object') return 'global';
  if (payload.group_id != null && String(payload.group_id).trim()) {
    return `group:${String(payload.group_id).trim()}`;
  }
  if (payload.user_id != null && String(payload.user_id).trim()) {
    return `private:${String(payload.user_id).trim()}`;
  }
  if (payload.target_id != null && String(payload.target_id).trim()) {
    return `private:${String(payload.target_id).trim()}`;
  }
  return `action:${action || 'unknown'}`;
}

/** 检查文本是否命中敏感路径、凭据赋值或运行时已知密钥 */
export function auditOutgoingText(text, runtimeSecrets = []) {
  const s = String(text || '');
  if (!s) return { ok: true };

  const match = s.match(SENSITIVE_RE);
  if (match) {
    return {
      ok: false,
      reason: 'sensitive_pattern',
      detail: `命中敏感信息规则（已隐藏匹配内容，长度 ${match[0].length}）`,
    };
  }
  for (const secret of runtimeSecrets) {
    if (secret && s.includes(secret)) {
      return {
        ok: false,
        reason: 'known_secret',
        detail: '命中运行时已配置密钥原文，已阻止外发',
      };
    }
  }
  return { ok: true };
}

/** 解析 OneBot HTTP JSON 返回中的业务 retcode / status（兼容无 retcode 字段的精简实现） */
export function inspectOneBotResult(res) {
  if (!res || typeof res !== 'object') return { ok: true, retcode: 0, wording: '' };
  const hasRetcode = typeof res.retcode === 'number';
  const retcode = hasRetcode ? res.retcode : 0;
  const status = String(res.status || '').toLowerCase();
  const wording = String(res.wording || res.msg || res.message || '').trim();
  const failed = (hasRetcode && retcode !== 0) || status === 'failed';
  return { ok: !failed, retcode, status, wording };
}

function pruneWindow(arr, now) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const cutoff = now - HOUR_MS;
  const filtered = arr.filter((t) => typeof t === 'number' && Number.isFinite(t) && t >= cutoff && t <= now + 60000);
  return filtered.length > MAX_TIMESTAMPS ? filtered.slice(-MAX_TIMESTAMPS) : filtered;
}

function countWindow(arr, now) {
  let minute = 0;
  let hour = 0;
  const minCutoff = now - MINUTE_MS;
  const hrCutoff = now - HOUR_MS;
  for (let i = arr.length - 1; i >= 0; i--) {
    const t = arr[i];
    if (t < hrCutoff) continue;
    hour++;
    if (t >= minCutoff) minute++;
  }
  return { minute, hour };
}

function getDefaultStatePath() {
  return path.resolve(process.cwd(), 'state', 'rate-limit.json');
}

/** 确保 state/rate-limit.json 存在（供 init-env.mjs 调用，不覆盖已有数据） */
export function ensureRateLimitFile(filePath = getDefaultStatePath()) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) return true;
  const initData = {
    version: 1,
    updatedAt: new Date().toISOString(),
    globalSendTimes: [],
    chats: {},
  };
  fs.writeFileSync(filePath, `${JSON.stringify(initData, null, 2)}\n`, 'utf8');
  return false;
}

/**
 * 创建统一风控守卫实例
 */
export function createSafetyGuard(safetyConfig = {}, { statePath = getDefaultStatePath(), extraSecrets = [], log = () => {} } = {}) {
  const minGlobalSendGapMs = Math.max(0, Number(safetyConfig.minGlobalSendGapMs ?? 800));
  const rawMaxGlobalSendGapMs = Math.max(0, Number(safetyConfig.maxGlobalSendGapMs ?? 1200));
  const maxGlobalSendGapMs = rawMaxGlobalSendGapMs > minGlobalSendGapMs ? rawMaxGlobalSendGapMs : minGlobalSendGapMs;

  const cfg = {
    enabled: safetyConfig.enabled !== false,
    minGlobalSendGapMs,
    maxGlobalSendGapMs,
    maxSendPerMinute: Math.max(0, Number(safetyConfig.maxSendPerMinute ?? 0)),
    maxSendPerHour: Math.max(0, Number(safetyConfig.maxSendPerHour ?? 0)),
    globalMaxSendPerMinute: Math.max(0, Number(safetyConfig.globalMaxSendPerMinute ?? 0)),
    globalMaxSendPerHour: Math.max(0, Number(safetyConfig.globalMaxSendPerHour ?? 200)),
    maxMessageChars: Math.max(0, Number(safetyConfig.maxMessageChars ?? 500)),
    sensitiveCheck: safetyConfig.sensitiveCheck !== false,
    wakeLimit: {
      enabled: safetyConfig.wakeLimit?.enabled === true,
      groupAutoPerMinute: Math.max(0, Number(safetyConfig.wakeLimit?.groupAutoPerMinute ?? 2)),
      groupAutoPerHour: Math.max(0, Number(safetyConfig.wakeLimit?.groupAutoPerHour ?? 18)),
      groupMentionPerMinute: Math.max(0, Number(safetyConfig.wakeLimit?.groupMentionPerMinute ?? 5)),
      groupMentionPerHour: Math.max(0, Number(safetyConfig.wakeLimit?.groupMentionPerHour ?? 45)),
      privatePerMinute: Math.max(0, Number(safetyConfig.wakeLimit?.privatePerMinute ?? 10)),
      privatePerHour: Math.max(0, Number(safetyConfig.wakeLimit?.privatePerHour ?? 90)),
    },
    retcodeGuard: {
      enabled: safetyConfig.retcodeGuard?.enabled !== false,
      consecutiveFailThreshold: Math.max(1, Number(safetyConfig.retcodeGuard?.consecutiveFailThreshold ?? 3)),
      cooldownMs: Math.max(1000, Number(safetyConfig.retcodeGuard?.cooldownMs ?? 120000)),
    },
  };

  const runtimeSecrets = collectRuntimeSecrets(extraSecrets);

  // 内存态限流记录（启动时从 state/rate-limit.json 恢复近 1 小时数据）
  let state = {
    version: 1,
    updatedAt: '',
    globalSendTimes: [],
    chats: {},
  };

  const loadState = () => {
    try {
      if (!fs.existsSync(statePath)) return;
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const now = Date.now();
      state.globalSendTimes = pruneWindow(raw?.globalSendTimes, now);
      state.chats = {};
      if (raw?.chats && typeof raw.chats === 'object') {
        for (const [k, v] of Object.entries(raw.chats)) {
          const sendTimes = pruneWindow(v?.sendTimes, now);
          const wakeAuto = pruneWindow(v?.wakeAuto, now);
          const wakeMention = pruneWindow(v?.wakeMention, now);
          const wakePrivate = pruneWindow(v?.wakePrivate, now);
          if (sendTimes.length || wakeAuto.length || wakeMention.length || wakePrivate.length) {
            state.chats[k] = { sendTimes, wakeAuto, wakeMention, wakePrivate };
          }
        }
      }
    } catch {
      // 损坏时静默重建，不阻塞启动
    }
  };
  loadState();

  let flushTimer = null;
  const flushStateNow = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    try {
      const now = Date.now();
      const cleanedChats = {};
      for (const [k, v] of Object.entries(state.chats)) {
        const sendTimes = pruneWindow(v?.sendTimes, now);
        const wakeAuto = pruneWindow(v?.wakeAuto, now);
        const wakeMention = pruneWindow(v?.wakeMention, now);
        const wakePrivate = pruneWindow(v?.wakePrivate, now);
        if (sendTimes.length || wakeAuto.length || wakeMention.length || wakePrivate.length) {
          cleanedChats[k] = { sendTimes, wakeAuto, wakeMention, wakePrivate };
        }
      }
      state.globalSendTimes = pruneWindow(state.globalSendTimes, now);
      state.chats = cleanedChats;
      state.updatedAt = new Date(now).toISOString();

      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      const tmp = `${statePath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, statePath);
    } catch {
      // 持久化失败不影响主流程
    }
  };

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(flushStateNow, 1500);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  };

  const getChatBucket = (chatKey) => {
    const k = String(chatKey || 'global');
    if (!state.chats[k]) {
      state.chats[k] = { sendTimes: [], wakeAuto: [], wakeMention: [], wakePrivate: [] };
    }
    return state.chats[k];
  };

  // retcode 连续失败冷却熔断状态
  let consecutiveRetcodeFailures = 0;
  let cooldownUntil = 0;

  // 轻量级全局发包节流锁（只锁单次 HTTP 发包与 minGlobalSendGapMs，不锁长停顿）
  let sendChain = Promise.resolve();
  let lastGlobalSendAt = 0;

  const enqueueGlobalSend = (fn) => {
    const run = async () => {
      if (cfg.enabled && cfg.maxGlobalSendGapMs > 0 && lastGlobalSendAt > 0) {
        const targetGap =
          cfg.maxGlobalSendGapMs > cfg.minGlobalSendGapMs
            ? cfg.minGlobalSendGapMs +
              Math.floor(Math.random() * (cfg.maxGlobalSendGapMs - cfg.minGlobalSendGapMs + 1))
            : cfg.minGlobalSendGapMs;
        const elapsed = Date.now() - lastGlobalSendAt;
        const waitMs = targetGap - elapsed;
        if (waitMs > 0) {
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
      try {
        return await fn();
      } finally {
        lastGlobalSendAt = Date.now();
      }
    };
    const next = sendChain.then(run, run);
    sendChain = next.catch(() => {});
    return next;
  };

  /**
   * 预占发送额度（返回 { ok, error, code, rollback }）
   * 若后续 HTTP 发送失败或 OneBot retcode 非 0，务必调用 rollback() 释放额度。
   */
  const reserveSendQuota = (chatKey, count = 1, now = Date.now()) => {
    if (!cfg.enabled) return { ok: true, rollback: () => {} };

    // 1. 熔断冷却检查
    if (cfg.retcodeGuard.enabled && cooldownUntil > now) {
      const remainSec = Math.max(1, Math.ceil((cooldownUntil - now) / 1000));
      return {
        ok: false,
        code: 'RISK_COOLDOWN',
        error: `风控熔断冷却中（剩余约 ${remainSec} 秒），暂缓发送`,
      };
    }

    const n = Math.max(1, Number(count) || 1);
    const bucket = getChatBucket(chatKey);
    bucket.sendTimes = pruneWindow(bucket.sendTimes, now);
    state.globalSendTimes = pruneWindow(state.globalSendTimes, now);

    const chatStats = countWindow(bucket.sendTimes, now);
    if (cfg.maxSendPerMinute > 0 && chatStats.minute + n > cfg.maxSendPerMinute) {
      return {
        ok: false,
        code: 'RATE_LIMIT_CHAT_MINUTE',
        error: `会话 ${chatKey} 发送频率超限（每分钟上限 ${cfg.maxSendPerMinute} 条）`,
      };
    }
    if (cfg.maxSendPerHour > 0 && chatStats.hour + n > cfg.maxSendPerHour) {
      return {
        ok: false,
        code: 'RATE_LIMIT_CHAT_HOUR',
        error: `会话 ${chatKey} 发送频率超限（每小时上限 ${cfg.maxSendPerHour} 条）`,
      };
    }

    const globalStats = countWindow(state.globalSendTimes, now);
    if (cfg.globalMaxSendPerMinute > 0 && globalStats.minute + n > cfg.globalMaxSendPerMinute) {
      return {
        ok: false,
        code: 'RATE_LIMIT_GLOBAL_MINUTE',
        error: `全局账号发送频率超限（每分钟上限 ${cfg.globalMaxSendPerMinute} 条）`,
      };
    }
    if (cfg.globalMaxSendPerHour > 0 && globalStats.hour + n > cfg.globalMaxSendPerHour) {
      return {
        ok: false,
        code: 'RATE_LIMIT_GLOBAL_HOUR',
        error: `全局账号发送频率超限（每小时上限 ${cfg.globalMaxSendPerHour} 条）`,
      };
    }

    // 预占时间戳（附带唯一 token 引用，支持精准回滚）
    const tokenTs = now;
    for (let i = 0; i < n; i++) {
      bucket.sendTimes.push(tokenTs);
      state.globalSendTimes.push(tokenTs);
    }
    if (bucket.sendTimes.length > MAX_TIMESTAMPS) {
      bucket.sendTimes = bucket.sendTimes.slice(-MAX_TIMESTAMPS);
    }
    if (state.globalSendTimes.length > MAX_TIMESTAMPS) {
      state.globalSendTimes = state.globalSendTimes.slice(-MAX_TIMESTAMPS);
    }
    scheduleFlush();

    let rolledBack = false;
    const rollback = () => {
      if (rolledBack) return;
      rolledBack = true;
      for (let i = 0; i < n; i++) {
        const idx1 = bucket.sendTimes.lastIndexOf(tokenTs);
        if (idx1 >= 0) bucket.sendTimes.splice(idx1, 1);
        const idx2 = state.globalSendTimes.lastIndexOf(tokenTs);
        if (idx2 >= 0) state.globalSendTimes.splice(idx2, 1);
      }
      scheduleFlush();
    };

    return { ok: true, rollback };
  };

  /**
   * 分场景唤醒限流检查（预占 1 次唤醒配额）
   * @param {string} chatKey
   * @param {'group_auto'|'group_mention'|'private'} category
   */
  const checkAndRecordWake = (chatKey, category = 'private', now = Date.now()) => {
    if (!cfg.enabled || !cfg.wakeLimit.enabled) return { ok: true };

    let field = 'wakePrivate';
    let maxMin = cfg.wakeLimit.privatePerMinute;
    let maxHr = cfg.wakeLimit.privatePerHour;
    if (category === 'group_auto') {
      field = 'wakeAuto';
      maxMin = cfg.wakeLimit.groupAutoPerMinute;
      maxHr = cfg.wakeLimit.groupAutoPerHour;
    } else if (category === 'group_mention') {
      field = 'wakeMention';
      maxMin = cfg.wakeLimit.groupMentionPerMinute;
      maxHr = cfg.wakeLimit.groupMentionPerHour;
    }

    const bucket = getChatBucket(chatKey);
    bucket[field] = pruneWindow(bucket[field], now);
    const stats = countWindow(bucket[field], now);
    if (maxMin > 0 && stats.minute >= maxMin) {
      return {
        ok: false,
        code: 'WAKE_LIMIT_MINUTE',
        error: `唤醒频率超限 (${category} ${stats.minute}/${maxMin} 次/分)`,
      };
    }
    if (maxHr > 0 && stats.hour >= maxHr) {
      return {
        ok: false,
        code: 'WAKE_LIMIT_HOUR',
        error: `唤醒频率超限 (${category} ${stats.hour}/${maxHr} 次/时)`,
      };
    }

    bucket[field].push(now);
    if (bucket[field].length > MAX_TIMESTAMPS) {
      bucket[field] = bucket[field].slice(-MAX_TIMESTAMPS);
    }
    scheduleFlush();
    return { ok: true };
  };

  /**
   * 包装底层 rawSendOneBot：对所有 SEND_ACTIONS 自动执行敏感审计、双层限流、全局发包节流与 retcode 熔断检测
   */
  const wrapSendOneBot = (rawSendOneBot) => {
    return async (action, payload) => {
      if (!cfg.enabled || !SEND_ACTIONS.has(action)) {
        return rawSendOneBot(action, payload);
      }

      const chatKey = resolveChatKeyFromPayload(action, payload);
      const visibleText = extractTextFromOneBotPayload(payload);

      // 1. 敏感信息外发审计
      if (cfg.sensitiveCheck && visibleText) {
        const audit = auditOutgoingText(visibleText, runtimeSecrets);
        if (!audit.ok) {
          log(`[safety] 拦截外发 (${action} -> ${chatKey}): ${audit.detail}`);
          const err = new Error(`消息含敏感信息，已阻止发送（${audit.reason}）`);
          err.code = 'SENSITIVE_BLOCKED';
          throw err;
        }
      }

      // 2. 单条纯文本硬上限保护（sendReply 已智能切分，此处兜底直调工具）
      if (cfg.maxMessageChars > 0 && visibleText && typeof payload?.message === 'string' && visibleText.length > cfg.maxMessageChars) {
        const limit = cfg.maxMessageChars;
        log(`[safety] 拦截超长单条文本 (${action} -> ${chatKey}): ${visibleText.length} > ${limit} 字`);
        const err = new Error(`单条消息长度 ${visibleText.length} 字超过上限 ${limit} 字，已阻止发送`);
        err.code = 'MESSAGE_TOO_LONG';
        throw err;
      }

      // 3. 预占双层发送额度（先占后发防并发绕过）
      const quota = reserveSendQuota(chatKey, 1);
      if (!quota.ok) {
        log(`[safety] ${quota.error} (action=${action})`);
        const err = new Error(quota.error);
        err.code = quota.code || 'RATE_LIMITED';
        throw err;
      }

      // 4. 走轻量全局发包节流锁执行实际 HTTP 发送
      try {
        const res = await enqueueGlobalSend(() => rawSendOneBot(action, payload));

        // 5. 检查 OneBot 业务 retcode / status
        if (cfg.retcodeGuard.enabled) {
          const check = inspectOneBotResult(res);
          if (!check.ok) {
            quota.rollback();
            consecutiveRetcodeFailures++;
            log(
              `[safety] OneBot 发送业务异常 (${action} -> ${chatKey}): retcode=${check.retcode} status=${check.status || '-'} wording=${check.wording || '无'} (连续第 ${consecutiveRetcodeFailures} 次)`
            );
            if (consecutiveRetcodeFailures >= cfg.retcodeGuard.consecutiveFailThreshold) {
              cooldownUntil = Date.now() + cfg.retcodeGuard.cooldownMs;
              const sec = Math.round(cfg.retcodeGuard.cooldownMs / 1000);
              log(`[safety] 触发风控熔断：连续 ${consecutiveRetcodeFailures} 次发送返回异常，自动冷却 ${sec} 秒！`);
            }
            const err = new Error(`OneBot 发送失败 (retcode=${check.retcode}${check.wording ? `: ${check.wording}` : ''})`);
            err.code = 'ONEBOT_RETCODE_ERROR';
            err.retcode = check.retcode;
            throw err;
          } else {
            consecutiveRetcodeFailures = 0;
          }
        }

        return res;
      } catch (err) {
        // HTTP 抛错或超时：回滚预占额度
        quota.rollback();
        throw err;
      }
    };
  };

  /** 获取当前限流与熔断快照（便于调试/自测） */
  const getSnapshot = (now = Date.now()) => ({
    enabled: cfg.enabled,
    globalSend: countWindow(pruneWindow(state.globalSendTimes, now), now),
    consecutiveRetcodeFailures,
    inCooldown: cooldownUntil > now,
    cooldownRemainMs: Math.max(0, cooldownUntil - now),
  });

  return {
    config: cfg,
    reserveSendQuota,
    checkAndRecordWake,
    wrapSendOneBot,
    enqueueGlobalSend,
    auditText: (t) => auditOutgoingText(t, runtimeSecrets),
    flushStateNow,
    getSnapshot,
  };
}
