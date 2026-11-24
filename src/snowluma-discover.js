/**
 * SnowLuma / NapCat OneBot v11 配置自动发现器（src/snowluma-discover.js）
 *
 * 特点：
 *   - 零写死绝对路径：由用户在 npm run init 或命令行 --snowluma-dir 动态输入协议端安装目录；
 *   - 兼容 SnowLuma（config/onebot_<QQ>.json，networks.httpServers / wsServers）
 *     与 NapCat（config/onebot11_<QQ>.json，network.httpServers / websocketServers）；
 *   - 可选调用标准 OneBot v11 get_login_info 探测在线状态与 QQ 昵称，方便自动生成 Bot 文件夹。
 */
import fs from 'node:fs';
import path from 'node:path';

function normalizeHost(host) {
  const h = String(host || '').trim();
  if (!h || h === '0.0.0.0' || h === '::' || h === '[::]') return '127.0.0.1';
  return h;
}

function normalizePath(p) {
  const s = String(p || '/').trim();
  if (!s || s === '/') return '';
  return s.startsWith('/') ? s.replace(/\/+$/, '') : `/${s.replace(/\/+$/, '')}`;
}

function buildHttpUrl(server) {
  if (!server || !server.port) return '';
  const host = normalizeHost(server.host);
  const p = normalizePath(server.path);
  return `http://${host}:${server.port}${p}`;
}

function buildWsUrl(server) {
  if (!server || !server.port) return '';
  const host = normalizeHost(server.host);
  const p = normalizePath(server.path) || '/';
  const token = String(server.accessToken ?? server.token ?? '').trim();
  const base = `ws://${host}:${server.port}${p}`;
  if (!token) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}access_token=${encodeURIComponent(token)}`;
}

/** 扫描指定协议端目录下的 OneBot 配置文件 */
export function discoverSnowLumaConfigs(inputDir) {
  const baseDir = path.resolve(String(inputDir || '').trim().replace(/^["']|["']$/g, ''));
  if (!baseDir || !fs.existsSync(baseDir)) {
    return { ok: false, error: `目录不存在: ${baseDir}`, bots: [] };
  }

  const candidateDirs = [
    path.join(baseDir, 'config'),
    baseDir,
    path.join(baseDir, 'napcat', 'config'),
  ].filter((d, idx, arr) => arr.indexOf(d) === idx && fs.existsSync(d) && fs.statSync(d).isDirectory());

  const seenQq = new Set();
  const bots = [];

  for (const dir of candidateDirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }

    for (const fileName of entries.sort()) {
      // 匹配 SnowLuma: onebot_<QQ>.json 以及 NapCat: onebot11_<QQ>.json
      const m = fileName.match(/^onebot(?:11)?_(\d{5,12})\.json$/i);
      if (!m) continue;
      const botQQ = m[1];
      if (seenQq.has(botQQ)) continue;

      const fullPath = path.join(dir, fileName);
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      } catch {
        continue;
      }

      const net = raw?.networks || raw?.network || {};
      const httpServers = Array.isArray(net.httpServers) ? net.httpServers : [];
      const wsServers = Array.isArray(net.wsServers)
        ? net.wsServers
        : Array.isArray(net.websocketServers)
          ? net.websocketServers
          : [];

      const httpSrv = httpServers.find((s) => s && s.enable !== false && s.port) || httpServers[0] || null;
      const wsSrv = wsServers.find((s) => s && s.enable !== false && s.port) || wsServers[0] || null;
      if (!httpSrv && !wsSrv) continue;

      const httpUrl = buildHttpUrl(httpSrv);
      const wsUrl = buildWsUrl(wsSrv);
      const httpToken = String(httpSrv?.accessToken ?? httpSrv?.token ?? '').trim();
      const wsToken = String(wsSrv?.accessToken ?? wsSrv?.token ?? '').trim();

      seenQq.add(botQQ);
      bots.push({
        botQQ: Number(botQQ),
        botQQStr: botQQ,
        configFile: fullPath,
        httpUrl,
        wsUrl,
        accessToken: httpToken || wsToken,
        httpPort: httpSrv?.port || 0,
        wsPort: wsSrv?.port || 0,
        historySyncEnabled: raw?.historySync?.enabled === true,
        online: false,
        nickname: '',
      });
    }
  }

  return {
    ok: true,
    scannedDir: baseDir,
    bots,
  };
}

/** 轻量探测每个发现的 Bot 当前是否在线，并读取 QQ 昵称（超时 2s 不阻塞） */
export async function probeDiscoveredBots(bots = []) {
  const results = [];
  for (const bot of bots) {
    const item = { ...bot };
    if (item.httpUrl) {
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (item.accessToken) headers.Authorization = `Bearer ${item.accessToken}`;
        const res = await fetch(`${item.httpUrl.replace(/\/$/, '')}/get_login_info`, {
          method: 'POST',
          headers,
          body: '{}',
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          const json = await res.json().catch(() => ({}));
          const uid = String(json?.data?.user_id || '').trim();
          const nick = String(json?.data?.nickname || '').trim();
          if (uid && uid !== '0') {
            item.online = true;
            if (nick) item.nickname = nick;
          }
        }
      } catch {}
    }
    results.push(item);
  }
  return results;
}
