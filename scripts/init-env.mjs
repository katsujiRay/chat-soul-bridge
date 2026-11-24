/**
 * 环境与数据库初始化 + 多 Bot（SnowLuma/NapCat）一键生成向导（scripts/init-env.mjs）
 *
 * 三种用法：
 *   1. npm start 自动调用（--quiet）：静默幂等初始化当前目录（或指定 --data-dir）的 state/ 数据库与目录；
 *   2. npm run init -- --bot=bot2：直接创建/初始化 bots/bot2/ 独立目录（含 start.bat / config.json / .env / state/）；
 *   3. npm run init（或 --snowluma-dir="你的协议端目录"）：
 *      交互式询问你的 SnowLuma / NapCat 安装目录（绝不写死绝对路径），自动读取其中一个或多个 Bot 的注入配置，
 *      一键生成对应 bots/<名称>/ 文件夹（各自独立 start.bat、config.json、.env、人设、日记与数据库）。
 */
import '../src/bootstrap.js';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { scaffoldBotDirectory } from '../src/bot-scaffold.js';
import { getContextDbPath } from '../src/context-db.js';
import { initMemoryDb } from '../src/db.js';
import { ensureEmotionFile } from '../src/emotion.js';
import { ensureImpressionsDb } from '../src/impressions.js';
import { ensureMediaArchiveDir } from '../src/media-archive.js';
import { CODE_ROOT, getBotRuntime } from '../src/runtime.js';
import { discoverSnowLumaConfigs, probeDiscoveredBots } from '../src/snowluma-discover.js';
import { ensureTodosFile } from '../src/todos.js';

const runtime = getBotRuntime();
const ROOT = runtime.dataRoot;
const QUIET = process.argv.includes('--quiet');

function log(...args) {
  if (!QUIET) console.log('[init]', ...args);
}

function ensureDir(relPath) {
  const full = path.resolve(ROOT, relPath);
  if (!fs.existsSync(full)) {
    fs.mkdirSync(full, { recursive: true });
    log(`已创建目录: ${relPath}`);
  }
}

function ensureJsonFile(relPath, defaultContent) {
  const full = path.resolve(ROOT, relPath);
  if (!fs.existsSync(full)) {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `${JSON.stringify(defaultContent, null, 2)}\n`, 'utf8');
    log(`已新建文件: ${relPath}`);
  }
}

function parseSelection(input, total) {
  const clean = String(input || '').trim().toLowerCase();
  if (!clean) return [];
  if (clean === 'all' || clean === '*' || clean === '全部') {
    return Array.from({ length: total }, (_, i) => i);
  }
  const indices = new Set();
  for (const part of clean.split(/[,\s，、]+/)) {
    const n = Number(part);
    if (Number.isInteger(n) && n >= 1 && n <= total) {
      indices.add(n - 1);
    }
  }
  return [...indices].sort((a, b) => a - b);
}

function readExistingOwnerId() {
  try {
    const rootCfgPath = path.join(CODE_ROOT, 'config.json');
    if (fs.existsSync(rootCfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(rootCfgPath, 'utf8'));
      const n = Number(parsed?.ownerId || parsed?.ownerQQ || 0);
      if (Number.isFinite(n) && n > 0 && n !== 1234567890) return n;
    }
  } catch {}
  return 0;
}

/** 交互式扫描 SnowLuma / NapCat 并一键生成单/多 Bot 独立目录（含各自 start.bat 与独立 .env） */
async function runSnowLumaWizard(presetDir = '') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    let inputDir = String(presetDir || '').trim();
    if (!inputDir) {
      console.log('');
      console.log('── 多 Bot 自动发现向导（支持 SnowLuma / NapCat，不写死任何路径）──');
      inputDir = (
        await rl.question(
          '请输入 SnowLuma（或 NapCat）的安装目录或 config 目录路径（直接回车跳过，仅初始化当前目录）: '
        )
      ).trim();
    }
    if (!inputDir) return false;

    const scan = discoverSnowLumaConfigs(inputDir);
    if (!scan.ok) {
      console.warn(`[init] ${scan.error}`);
      return false;
    }
    if (scan.bots.length === 0) {
      console.warn(`[init] 在 ${scan.scannedDir} 下未找到 onebot_<ID>.json / onebot11_<ID>.json 配置文件。`);
      return false;
    }

    log(`在 ${scan.scannedDir} 发现 ${scan.bots.length} 个 OneBot 配置，正在探测在线状态...`);
    const probed = await probeDiscoveredBots(scan.bots);

    console.log('\n已发现的 Bot 注入配置：');
    probed.forEach((b, idx) => {
      const nickStr = b.nickname ? ` (${b.nickname})` : '';
      const statusStr = b.online ? '在线' : '离线/未登录';
      const syncHint = b.historySyncEnabled ? '' : ' [提示: historySync=false]';
      console.log(
        `  [${idx + 1}] 账号 ${b.botIdStr}${nickStr} | HTTP:${b.httpPort || '-'} WS:${b.wsPort || '-'} | ${statusStr}${syncHint}`
      );
    });

    const pickRaw = await rl.question(
      '\n请输入要创建独立 Bot 文件夹的编号（例如 1、1,2 或 all；直接回车跳过）: '
    );
    const pickedIdx = parseSelection(pickRaw, probed.length);
    if (pickedIdx.length === 0) {
      log('未选择任何 Bot，继续仅初始化当前目录。');
      return false;
    }

    const defaultOwner = readExistingOwnerId();
    const ownerHint = defaultOwner ? `（默认 ${defaultOwner}，直接回车沿用）` : '（可选，直接回车稍后手填）';
    const ownerInput = (await rl.question(`请输入管理员/主人账号${ownerHint}: `)).trim();
    const ownerId = Number(ownerInput || defaultOwner || 0) || 0;

    const chosen = pickedIdx.map((idx) => {
      const bot = probed[idx];
      return {
        ...bot,
        // 直接按 Chat 账号命名（bot_<ID>），与 SnowLuma 的 onebot_<ID>.json 一一对应，彻底杜绝非法路径字符与重名冲突
        folderName: `bot_${bot.botIdStr}`,
      };
    });

    console.log('');
    for (const bot of chosen) {
      const res = scaffoldBotDirectory({
        codeRoot: CODE_ROOT,
        botsRoot: path.join(CODE_ROOT, 'bots'),
        folderName: bot.folderName,
        snowlumaBot: bot,
        ownerId,
        peerBots: chosen.length > 1 ? chosen : [],
        initState: true,
        log,
      });
      log(`已就绪 Bot 文件夹: ${res.botDir}`);
      if (res.createdFiles.length > 0) {
        log(`  新建文件: ${res.createdFiles.join(', ')}`);
      }
      if (res.skippedFiles.length > 0) {
        log(`  保留已有: ${res.skippedFiles.join(', ')}`);
      }
      log(`  启动脚本: ${res.startBatPath}`);
    }

    console.log('\n全部所选 Bot 目录已生成完毕！接下来只需：');
    console.log('  1. 在各自目录的 .env 中填入该 Bot 使用的模型 API Key（若共用根目录 .env 可不填）；');
    console.log('  2. 在各自目录的 config.json 中选定 llm.active / 模型 ID 与白名单群号；');
    console.log('  3. 编辑各自目录的 roles/persona.txt 写好角色人设；');
    console.log('  4. 直接双击对应 bots/<名称>/start.bat 即可单开或多开运行！\n');
    return true;
  } finally {
    rl.close();
  }
}

async function initCurrentDirectory() {
  // 1. 确保基础目录存在
  for (const dir of ['state', 'tools/meme', 'tools/Diary', 'assets', 'roles']) {
    ensureDir(dir);
  }

  // 2. 检查并初始化短期对话库 state/context.db
  const ctxDbPath = path.join(ROOT, 'state', 'context.db');
  const ctxExisted = fs.existsSync(ctxDbPath);
  getContextDbPath();
  log(ctxExisted ? '短期上下文库已存在: state/context.db' : '已新建短期上下文库: state/context.db');

  // 3. 检查并初始化全量记忆库 state/memory.db（含 FTS5 索引）
  const memDbPath = path.join(ROOT, 'state', 'memory.db');
  const memExisted = fs.existsSync(memDbPath);
  const memRes = await initMemoryDb();
  if (!memRes?.ok) {
    console.error('[init] 初始化 state/memory.db 失败，请确认本机已安装 Python 3:', memRes?.error || memRes);
    process.exit(1);
  }
  log(memExisted ? '全量历史记忆库已存在: state/memory.db' : '已新建全量历史记忆库: state/memory.db');

  // 4. 确保人物印象库、图片归档目录、长期小本本、情感状态与动态待办文件存在（不覆盖已有数据）
  const impExisted = ensureImpressionsDb();
  log(impExisted ? '人物印象库已存在: state/impressions.db' : '已新建人物印象库: state/impressions.db');
  const mediaExisted = ensureMediaArchiveDir();
  log(mediaExisted ? '图片记忆归档目录已存在: state/media/' : '已新建图片记忆归档目录: state/media/');
  ensureJsonFile('state/memory.json', {});
  const emoExisted = ensureEmotionFile();
  log(emoExisted ? '情感状态文件已存在: state/emotion.json' : '已新建情感状态文件: state/emotion.json');
  const todoExisted = ensureTodosFile();
  log(todoExisted ? '动态待办清单已存在: state/todos.json' : '已新建动态待办清单: state/todos.json');

  // 5. 友好提示缺失的配置文件
  if (!fs.existsSync(path.join(ROOT, 'config.json'))) {
    console.warn('[init] 提示：未找到 config.json，请先复制 config.example.json 为 config.json 并填写配置');
  }
  if (!fs.existsSync(path.join(ROOT, '.env')) && !runtime.isSubBot) {
    log('提示：未找到 .env（如 API Key 已直接填在 config.json 中可忽略）');
  }
}

async function main() {
  // 场景 A：通过 --bot=<名称> 指定了子 Bot（非 --quiet），先确保其目录模板文件与 start.bat 完整
  if (runtime.isSubBot && !QUIET) {
    const res = scaffoldBotDirectory({
      codeRoot: CODE_ROOT,
      botsRoot: path.dirname(ROOT),
      folderName: path.basename(ROOT),
      ownerId: readExistingOwnerId(),
      initState: false,
      log,
    });
    if (res.createdFiles.length > 0) {
      log(`已为 Bot "${res.folderName}" 补齐模板文件: ${res.createdFiles.join(', ')}`);
    }
    log(`启动脚本位置: ${res.startBatPath}`);
  }

  // 场景 B：根目录手动执行 npm run init（或传入 --snowluma-dir），启动交互式 SnowLuma 发现向导
  if (!QUIET && !runtime.isSubBot && (runtime.snowlumaDir || process.stdin.isTTY)) {
    const didCreateBots = await runSnowLumaWizard(runtime.snowlumaDir);
    if (didCreateBots) {
      log('多 Bot 脚手架初始化完成！');
      process.exit(0);
    }
  }

  await initCurrentDirectory();
  log('环境与数据库检查完成！');
  process.exit(0);
}

main();
