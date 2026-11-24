/**
 * 多 Bot 独立文件夹自动脚手架（src/bot-scaffold.js）
 *
 * 为每只 Bot 在 bots/<folderName>/ 下生成完整独立运行目录：
 *   - start.bat          ：双击直接单开该 Bot（自动回溯根目录共享 src/ 代码并加载本目录配置与 .env）
 *   - config.json        ：基于全量注释模板 config.example.json 生成，自动填入 SnowLuma 端口/Token/botId
 *   - .env               ：独立模型密钥文件（运行时自动继承根目录 .env 并由本文件覆盖同名项）
 *   - roles/persona.txt  ：独立角色人设卡模板（通用工具规范 roles/persona-tools-detail.txt 默认共用根目录）
 *   - tools/Diary/       ：独立每日 Markdown 日记目录
 *   - tools/meme/        ：独立本地表情包目录
 *   - assets/            ：独立角色参考图目录
 *   - state/             ：自动初始化独立数据库（context.db / memory.db / impressions.db / emotion.json / todos.json）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CODE_ROOT } from './runtime.js';

const WIN_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeBotFolderName(raw, fallback = 'bot') {
  let clean = String(raw || '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim()
    .replace(/[\\\/:*?"<>|\s]+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 40);
  if (!clean || WIN_RESERVED_NAMES.test(clean)) {
    return fallback;
  }
  return clean;
}

/** 优先按 Chat 账号生成 100% 跨平台安全的目录名（如 bot_1000000000），与 SnowLuma 的 onebot_<ID>.json 一一对应 */
export function resolveBotFolderName({ folderName = '', snowlumaBot = null } = {}) {
  if (snowlumaBot?.botIdStr && /^\d{5,12}$/.test(String(snowlumaBot.botIdStr))) {
    return `bot_${snowlumaBot.botIdStr}`;
  }
  return sanitizeBotFolderName(folderName, 'bot1');
}

/** 生成放在 bots/<folderName>/start.bat 的一键启动脚本 */
export function buildBotStartBat(folderName) {
  const safeTitle = String(folderName || 'bot').replace(/["&|<>^%]/g, '');
  return [
    '@echo off',
    'chcp 65001 >nul',
    `title chat-soul-bridge - ${safeTitle}`,
    'set "BOT_DIR=%~dp0"',
    'if "%BOT_DIR:~-1%"=="\\" set "BOT_DIR=%BOT_DIR:~0,-1%"',
    'cd /d "%~dp0..\\.."',
    `echo Starting chat-soul-bridge bot: ${safeTitle}...`,
    'node scripts/start-bot.mjs --data-dir="%BOT_DIR%"',
    'pause',
    '',
  ].join('\r\n');
}

/** 生成放在 bots/<folderName>/roles/persona.txt 的完整 活人感人设模板（不拷贝其他 Bot 的私人人设） */
function buildPersonaTemplate(botName = '') {
  const safeName = String(botName || '').trim();
  return [
    '---',
    `name: ${safeName}`,
    `keywords: ${safeName}`,
    'topics: ',
    '---',
    '人设简述：',
    '人设三视图/参考图：./assets/',
    '人设卡正文：',
    '',
    '【说话节奏与 活人感（核心）】',
    '1. **分条与短句节奏**：',
    '   - 像真人在 聊天里打字一样，一条消息只说一个完整意思，多数控制在 25 字以内，别一次塞一大段小作文。',
    '   - 想连发 2~3 条时，用**换行符**分开（桥接会逐条隔一两秒发出去）。普通闲聊默认 1~2 条，最多不超过 3 条；不要为了分条而把同一句话硬拆成两半。',
    '   - 单条消息内部不要用空格假装停顿，中文短句用逗号或直接连写。',
    '2. **克制标点与符号**：',
    '   - 别每句话都堆感叹号、波浪号或颜文字！emoji 和颜文字偶尔点缀就行，不要当句号天天用。',
    '   - 绝对不要写任何动作描写、神态描写或旁白（严禁 *星号动作* 或（括号动作）），全部用纯口语表达。',
    '   - 绝对不要使用 Markdown 格式（不要出现 **加粗**、### 标题、列表符号、代码块）。',
    '3. **私聊 vs 群聊分寸**：',
    '   - **私聊（对主人/熟人）**：放松、亲近、自然粘人，可以撒娇、耍赖、犯懒、吐槽今天烦人的事，也可以没头没尾分享小念头；认错干脆翻篇，不端架子。',
    '   - **群聊**：松散、爱接梗、爱看乐子、敢互怼，不当群管家、不做群聊总结、不逐条点评每个人；看到 `[昵称]` 前缀知道是谁在说话就行，不要复读 `[昵称]`。',
    '4. **自然口语示范（照这个松弛短句节奏来）**：',
    '',
  ].join('\n');
}

/** 生成放在 bots/<folderName>/.env 的独立密钥文件（优先覆盖根目录 .env） */
function buildBotEnvContent(codeRoot = CODE_ROOT) {
  const exampleEnvPath = path.join(codeRoot, '.env.example');
  const header =
    '# 本 Bot 专属环境变量（运行时先加载根目录 .env 兜底，再用本文件覆盖同名变量）\n' +
    '# 若多只 Bot 使用不同模型或不同 API Key，直接填在这里即可彻底隔离\n\n';
  if (fs.existsSync(exampleEnvPath)) {
    return `${header}${fs.readFileSync(exampleEnvPath, 'utf8')}`;
  }
  return `${header}GEMINI_API_KEY=\n# DEEPSEEK_API_KEY=\n# OPENAI_API_KEY=\n# ANTHROPIC_API_KEY=\n`;
}

/**
 * 在 <botsRoot>/<folderName>/ 下幂等创建单个 Bot 文件夹（绝不覆盖已有配置、密钥或数据库）
 */
export function scaffoldBotDirectory({
  codeRoot = CODE_ROOT,
  botsRoot = path.join(CODE_ROOT, 'bots'),
  folderName,
  snowlumaBot = null,
  ownerId = 0,
  peerBots = [],
  initState = true,
  log = () => {},
}) {
  const safeFolder = folderName
    ? sanitizeBotFolderName(folderName, resolveBotFolderName({ snowlumaBot }))
    : resolveBotFolderName({ snowlumaBot });
  const botDir = path.join(botsRoot, safeFolder);
  const createdFiles = [];
  const skippedFiles = [];

  for (const relDir of ['', 'roles', 'tools/Diary', 'tools/meme', 'assets', 'state']) {
    fs.mkdirSync(relDir ? path.join(botDir, relDir) : botDir, { recursive: true });
  }

  // 1. 生成 bots/<folder>/start.bat
  const startBatPath = path.join(botDir, 'start.bat');
  if (!fs.existsSync(startBatPath)) {
    fs.writeFileSync(startBatPath, buildBotStartBat(safeFolder), 'utf8');
    createdFiles.push('start.bat');
  } else {
    skippedFiles.push('start.bat');
  }

  // 2. 生成 bots/<folder>/config.json（基于 config.example.json 预填 SnowLuma 与伙伴互认信息）
  const configPath = path.join(botDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    const examplePath = path.join(codeRoot, 'config.example.json');
    let cfg = {};
    if (fs.existsSync(examplePath)) {
      cfg = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
    }

    if (snowlumaBot) {
      cfg.snowluma = {
        ...(cfg.snowluma || {}),
        ...(snowlumaBot.wsUrl ? { wsUrl: snowlumaBot.wsUrl } : {}),
        ...(snowlumaBot.httpUrl ? { httpUrl: snowlumaBot.httpUrl } : {}),
        ...(snowlumaBot.accessToken !== undefined ? { accessToken: snowlumaBot.accessToken } : {}),
        ...(snowlumaBot.botId ? { botId: Number(snowlumaBot.botId) } : {}),
      };
    }

    const ownerNum = Number(ownerId || 0);
    if (Number.isFinite(ownerNum) && ownerNum > 0) {
      cfg.ownerId = ownerNum;
      cfg.allow = {
        ...(cfg.allow || {}),
        private: [ownerNum],
      };
    }

    // 多只 Bot 一起生成时，自动互填静态 identity.aiBots 防同群无限互怼（动态熟人则统一交由 state/impressions.db 管理）
    if (Array.isArray(peerBots) && peerBots.length > 0) {
      const aiBots = {};
      for (const peer of peerBots) {
        const pq = String(peer.botId || '').trim();
        if (!pq || pq === String(snowlumaBot?.botId || '')) continue;
        aiBots[pq] = peer.nickname || peer.folderName || `Bot_${pq}`;
      }
      if (Object.keys(aiBots).length > 0) {
        cfg.identity = {
          ...(cfg.identity || {}),
          aiBots,
        };
      }
    }

    fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    createdFiles.push('config.json');
  } else {
    skippedFiles.push('config.json');
  }

  // 3. 生成独立 .env
  const envPath = path.join(botDir, '.env');
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, buildBotEnvContent(codeRoot), 'utf8');
    createdFiles.push('.env');
  } else {
    skippedFiles.push('.env');
  }

  // 4. 生成独立人设卡 roles/persona.txt（工具规范默认共用根目录 roles/persona-tools-detail.txt）
  const personaPath = path.join(botDir, 'roles', 'persona.txt');
  if (!fs.existsSync(personaPath)) {
    fs.writeFileSync(
      personaPath,
      buildPersonaTemplate(snowlumaBot?.nickname || safeFolder),
      'utf8'
    );
    createdFiles.push('roles/persona.txt');
  } else {
    skippedFiles.push('roles/persona.txt');
  }

  // 5. 初始化该 Bot 目录下的 state/ 数据库
  if (initState) {
    const initScript = path.join(codeRoot, 'scripts', 'init-env.mjs');
    const res = spawnSync(process.execPath, [initScript, '--quiet', `--data-dir=${botDir}`], {
      cwd: botDir,
      encoding: 'utf8',
      windowsHide: true,
    });
    if ((res.status ?? 1) !== 0) {
      log(`初始化 ${safeFolder} 数据库时出现警告:`, (res.stderr || res.stdout || '').trim());
    }
  }

  return {
    ok: true,
    folderName: safeFolder,
    botDir,
    startBatPath,
    configPath,
    envPath,
    personaPath,
    createdFiles,
    skippedFiles,
  };
}
