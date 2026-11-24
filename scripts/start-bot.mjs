/**
 * 统一 Bot 启动器（scripts/start-bot.mjs）
 *
 * 用法：
 *   - 主 Bot（根目录，保持与原版完全兼容）：npm start
 *   - 多 Bot 实例（共用代码，独立数据与 .env）：
 *       npm start -- --bot=bot2
 *       node scripts/start-bot.mjs --data-dir="D:\path\to\bots\bot2"
 *       或直接双击 bots/<bot名>/start.bat
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CODE_ROOT, parseBotCliArgs } from '../src/runtime.js';

const cliArgs = process.argv.slice(2);
const { dataDir, botName } = parseBotCliArgs(cliArgs);
const targetDir = dataDir ? path.resolve(dataDir) : CODE_ROOT;
const isSubBot = path.resolve(targetDir).toLowerCase() !== path.resolve(CODE_ROOT).toLowerCase();

if (!fs.existsSync(targetDir)) {
  console.error(`[start-bot] 找不到 Bot 目录: ${targetDir}`);
  console.error('[start-bot] 请先运行 npm run init 扫描 SnowLuma 或使用 npm run init -- --bot=<名称> 创建该目录。');
  process.exit(1);
}

const configPath = path.join(targetDir, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error(`[start-bot] 找不到配置文件: ${configPath}`);
  console.error('[start-bot] 请先填写 config.json，或运行 npm run init 自动生成。');
  process.exit(1);
}

// 1. 静默检查并初始化该 Bot 目录的 state/ 数据库与基础文件夹
const initScript = path.join(CODE_ROOT, 'scripts', 'init-env.mjs');
const initArgs = [initScript, '--quiet', ...(isSubBot ? [`--data-dir=${targetDir}`] : [])];
const initRes = spawnSync(process.execPath, initArgs, {
  cwd: targetDir,
  stdio: 'inherit',
  windowsHide: false,
});
if ((initRes.status ?? 1) !== 0) {
  process.exit(initRes.status ?? 1);
}

// 2. 启动主程序（由 src/bootstrap.js 自动完成分层 .env 加载：根目录兜底 + Bot 目录 .env 覆盖）
const entryScript = path.join(CODE_ROOT, 'src', 'index.js');
const runArgs = [entryScript, ...(isSubBot ? [`--data-dir=${targetDir}`] : [])];
if (isSubBot) {
  console.log(`[start-bot] 启动独立 Bot 实例 "${botName}" (数据目录: ${targetDir})`);
}
const runRes = spawnSync(process.execPath, runArgs, {
  cwd: targetDir,
  stdio: 'inherit',
  windowsHide: false,
});
process.exit(runRes.status ?? 0);
