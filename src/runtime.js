/**
 * 多 Bot 实例运行时引导与分层 .env 加载器（src/runtime.js）
 *
 * 设计目标：
 *   1. 现有根目录运行模式（npm start / start.bat）100% 保持原样，零迁移成本；
 *   2. 传入 --bot=<名称> 或 --data-dir=<路径> 时，共用根目录 src/、scripts/ 与 node_modules/，
 *      数据目录完全隔离到 bots/<名称>/（独立 config.json、.env、roles/、state/、tools/Diary/）；
 *   3. 分层 .env 继承：先加载根目录 .env 作为兜底，再用 Bot 专属目录的 .env 覆盖同名变量
 *      （解决多只 Bot 使用不同模型或不同 API Key 的隔离需求）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 源码仓库根目录（永远指向含 src/ 与 scripts/ 的真实代码目录，不受 chdir 影响） */
export const CODE_ROOT = path.resolve(__dirname, '..');

let cachedRuntime = null;

/** 解析命令行中的 --bot=<name> 或 --data-dir=<dir> 参数 */
export function parseBotCliArgs(argv = process.argv.slice(2)) {
  let botName = '';
  let dataDir = '';
  let snowlumaDir = '';

  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] || '');
    if (arg.startsWith('--bot=')) {
      botName = arg.slice('--bot='.length).trim();
    } else if (arg === '--bot' && argv[i + 1]) {
      botName = String(argv[++i]).trim();
    } else if (arg.startsWith('--data-dir=')) {
      dataDir = arg.slice('--data-dir='.length).trim();
    } else if (arg === '--data-dir' && argv[i + 1]) {
      dataDir = String(argv[++i]).trim();
    } else if (arg.startsWith('--snowluma-dir=')) {
      snowlumaDir = arg.slice('--snowluma-dir='.length).trim();
    } else if (arg === '--snowluma-dir' && argv[i + 1]) {
      snowlumaDir = String(argv[++i]).trim();
    }
  }

  // 清理 Windows 批处理 %~dp0 可能带入的尾随引号或反斜杠
  dataDir = dataDir.replace(/^["']|["']$/g, '').replace(/[\\\/]+$/, '');
  snowlumaDir = snowlumaDir.replace(/^["']|["']$/g, '').replace(/[\\\/]+$/, '');
  botName = botName.replace(/^["']|["']$/g, '').replace(/[\\\/:*?"<>|]/g, '').trim();

  if (!dataDir && botName) {
    dataDir = path.join(CODE_ROOT, 'bots', botName);
  }
  if (!dataDir && process.env.CHAT_BOT_DIR) {
    dataDir = path.resolve(process.env.CHAT_BOT_DIR);
  }
  if (!botName && dataDir) {
    botName = path.basename(path.resolve(dataDir));
  }

  return { botName, dataDir, snowlumaDir };
}

/** 轻量零依赖 .env 文件解析器 */
function parseEnvFile(filePath) {
  const result = {};
  if (!fs.existsSync(filePath)) return result;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const cleaned = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = cleaned.indexOf('=');
    if (eq <= 0) continue;
    const key = cleaned.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = cleaned.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    } else {
      const hashIdx = val.indexOf(' #');
      if (hashIdx !== -1) val = val.slice(0, hashIdx).trim();
    }
    result[key] = val;
  }
  return result;
}

/**
 * 分层加载环境变量：
 *   1. 先读根目录 .env（不覆盖系统环境变量）；
 *   2. 若处于子 Bot 数据目录，再读 <dataRoot>/.env 覆盖根目录 .env 中的同名键，
 *      确保每只 Bot 可独立配置不同的模型 Key（同时仍保留系统级环境变量优先级）。
 */
export function loadLayeredEnv(codeRoot = CODE_ROOT, dataRoot = process.cwd()) {
  const shellKeys = new Set(Object.keys(process.env));
  const rootEnvPath = path.join(codeRoot, '.env');
  const botEnvPath = path.join(dataRoot, '.env');
  const isSubBot = path.resolve(dataRoot).toLowerCase() !== path.resolve(codeRoot).toLowerCase();

  const rootVars = parseEnvFile(rootEnvPath);
  for (const [k, v] of Object.entries(rootVars)) {
    if (!shellKeys.has(k) || !process.env[k]) {
      process.env[k] = v;
    }
  }

  if (isSubBot) {
    const botVars = parseEnvFile(botEnvPath);
    for (const [k, v] of Object.entries(botVars)) {
      if (!shellKeys.has(k) || Object.prototype.hasOwnProperty.call(rootVars, k)) {
        process.env[k] = v;
      }
    }
  }

  return {
    rootEnvLoaded: fs.existsSync(rootEnvPath),
    botEnvLoaded: isSubBot && fs.existsSync(botEnvPath),
  };
}

/** 初始化多 Bot 运行时：自动 chdir 到目标 Bot 数据目录并加载分层 .env */
export function initBotRuntime(argv = process.argv.slice(2)) {
  if (cachedRuntime) return cachedRuntime;
  const parsed = parseBotCliArgs(argv);
  const dataRoot = parsed.dataDir ? path.resolve(parsed.dataDir) : process.cwd();
  const isSubBot = path.resolve(dataRoot).toLowerCase() !== path.resolve(CODE_ROOT).toLowerCase();

  if (isSubBot) {
    fs.mkdirSync(dataRoot, { recursive: true });
    process.chdir(dataRoot);
  }

  const envInfo = loadLayeredEnv(CODE_ROOT, dataRoot);
  cachedRuntime = {
    codeRoot: CODE_ROOT,
    dataRoot,
    botName: parsed.botName || (isSubBot ? path.basename(dataRoot) : 'default'),
    isSubBot,
    snowlumaDir: parsed.snowlumaDir || '',
    ...envInfo,
  };
  return cachedRuntime;
}

export function getBotRuntime() {
  return cachedRuntime || initBotRuntime();
}

/**
 * 解析资源/人设相对路径：优先取当前 Bot 数据目录，若不存在则自动回退到代码根目录共用文件
 * （例如多个 Bot 可自动共用根目录的 roles/persona-tools-detail.txt 工具规范）。
 */
export function resolveBotResourcePath(relPath, dataRoot = process.cwd(), codeRoot = CODE_ROOT) {
  const clean = String(relPath || '').trim();
  if (!clean) return '';
  if (path.isAbsolute(clean)) return clean;
  const localPath = path.resolve(dataRoot, clean);
  if (fs.existsSync(localPath)) return localPath;
  const sharedPath = path.resolve(codeRoot, clean);
  if (fs.existsSync(sharedPath)) return sharedPath;
  return localPath;
}
