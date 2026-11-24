# chat-soul-bridge

> 仓库地址：[https://github.com/katsujiRay/chat-soul-bridge](https://github.com/katsujiRay/chat-soul-bridge)
>
> 致谢：感谢 qq-bridge 作者开源，本项目基于 qq-bridge 更改。

一个轻量、清爽、全本地记忆驱动的 **Chat（OneBot v11）↔ 多大模型通用桥接框架**（原生支持 **Gemini、DeepSeek、OpenAI GPT、Claude** 以及任意 OpenAI 兼容接口如 Qwen / Kimi / OpenRouter / Ollama）。

无需复杂中间件，基于 **Node.js 22+（原生 SQLite + `@google/genai` + 零依赖 OpenAI / Anthropic 协议适配）** 与 **Python 3（SQLite FTS5 全文检索 + 可选向量融合）** 构建，支持自由切换模型与人设（不仅限于特定角色，任何角色都能轻松接入），并内置拟人化分条回复、多模态看图、四层本地记忆、四级隐私隔离、好感度与心情双向联动、本地表情包百宝箱、跨聊传话、多 Bot 防互刷以及定时主动冒泡。

---

## 核心特性

- **多模型自由接入（一套记忆与工具，全模型通用）**：
  - **Google Gemini**：原生 `@google/genai` Interactions API（`protocol: "gemini"`）。
  - **OpenAI 兼容生态（DeepSeek / GPT / Qwen / Kimi / GLM / OpenRouter / Ollama 等）**：原生 `/chat/completions`（`protocol: "openai"` + 自定义 `baseUrl`）。
  - **Anthropic Claude**：原生 `/v1/messages` 协议（`protocol: "anthropic"`，支持 Claude 全系及兼容中转）。
  - **Google Antigravity CLI（`protocol: "agy-cli"`）**：通过 `agy --input-format stream-json --output-format stream-json` 无头长连接复用本机登录凭证（免 API Key），每个会话常驻预热，并内置 Chat 工具回环桥接（可正常调用查记忆、合并转发、记待办、写日记、发表情包等全部工具）。
  - **零写死 & 自动降级链**：所有协议的 `baseUrl`、`apiKey`、`model` 全部统一在 `config.json` 中配置，支持主模型 + 备用模型自动降级，并共享同一套本地 `state/context.db`，**切模型不丢上下文**！
- **全本地四层记忆架构**：
  1. **短期滑窗上下文（`state/context.db`）**：采用无状态 `store: false` 模式，全本地 SQLite 维护最近 N 轮对话，**不受服务端 1 天过期限制**，跨重启与切模型不丢上下文；内置 **12h / 48h 时间阶梯自然淡出**（12h 内全量、12~48h 自动收窄留最近 4 轮隔夜尾巴、超 48h 翻篇清空）。
  2. **群聊实时背景缓存**：静默缓存每个群最近 30 条发言，唤醒时自动附带上下文，无缝接梗。
  3. **长期小本本（`state/memory.json`）**：记住管理员与群友的喜好/约定/梗，每轮热注入人设，`/reset` 也不忘。
  4. **全量历史归档与日记（`state/memory.db`）**：每一条收发消息与日记实时入库并建立中文单字/二元组 + 英文数字 **FTS5 全文索引**，支持通过 `qq_recall` 毫秒级翻查往事，并兼容可选本地向量服务做 RRF 融合排序。
- **好感度与心情双向联动（`state/emotion.json`）**：
  - **好感度（`0~100`）**：仅对管理员（`ownerQQ`）私聊生效，每日正常私聊自动记被动分，主动调整内置冷却、日上限、里程碑冷却与 80+/90+ 高分衰减。
  - **心情（`-50~+50`）**：按 4 小时半衰期自然回归平静，与好感度双向影响情绪敏感度及主动冒泡频率；从低落被哄好转晴时会提示角色自然说开翻篇。
- **代码级四层隐私隔离**：
  - **管理员私聊（`ownerQQ`）**：全库互通（私聊 + 群聊 + 小本本 + 日记 + 待办 + 情感状态）。
  - **信任亲密小群（`memoryPrivacy.trustedGroups`）**：允许与管理员私聊互通记忆、小本本、日记与待办，不跨查其他无关群。
  - **熟人互通群（`memoryPrivacy.privateMemoryGroups`）**：打通管理员私聊日常聊天记忆、小本本与人物印象供心里有数，但**代码层硬禁日记、待办、情感、私聊原图与小本本读写工具**，并在场景与检索结果中强制附加群聊防泄密护栏，绝不把私密内容抖给外人。
  - **普通外部群**：代码层强制全量隔离——`qq_recall` 仅限当前群聊记录，禁止读取私密小本本、日记、待办和情感状态，杜绝群聊泄密。
- **多模态看图 & 本地表情包库（`tools/meme/`）**：
  - 自动下载 Chat 图片发送给当前多模态大模型理解（Gemini / GPT / Claude 等均支持）。
  - 支持机器人自主**偷图收藏（SHA-1 自动去重 + 魔数识别格式）**、按关键词检索并发送本地 `tools/meme/` 里的表情包；也支持人工直接拖图进文件夹即刻识别。
  - 支持配置角色三视图/参考图（`assets/`），按需调用 `get_self_image` 查看或 `send_self_image` 发图，未放图时自动跳过、不浪费 token。
- **拟人化 Chat 聊天节奏**：
  - 按换行自动拆成 1~4 条短消息，带拟真打字停顿逐条发送，自动清理 Markdown 粗体。
  - **人设与工具彻底解耦 + 热更新**：修改 `roles/persona.txt` 或 `roles/persona-tools-detail.txt` 保存即生效，无需重启；换角色只需替换人设文件，角色名与群聊唤醒词自动同步。
- **智能群聊唤醒 + 多 Bot 防互怼护栏**：
  - 支持 `@` 提及、引用机器人消息、关键词、拍一拍（戳一戳）、按概率随机冒泡。
  - 内置 `maxConsecutiveWithoutOwner` 护栏：群里存在多个 AI 机器人时，无人类发言最多连续接话指定轮数，杜绝双 AI 无限互怼烧额度。
- **主动找你聊（Proactive Chat）**：支持私聊与指定群冷场后按概率主动冒泡，内置夜间免打扰时段与防连发机制。
- **跨聊传话 & 悄悄打小报告**：支持群内悄悄私聊管理员（`qq_dm_owner`）以及仅限管理员私聊遥控向群内带话（`qq_send_to_group`）。
- **一键历史迁移**：内置 `npm run import-history`，可从 OneBot 网关自动拉取已有私聊/群聊历史写入 `state/memory.db`（自动按 `message_id` 去重）。

---

## 系统架构

```text
Chat 客户端 <--> OneBot v11 网关 (SnowLuma / NapCat 等)
                      │  WebSocket (收消息/拍一拍) + HTTP API (发消息/拉历史)
                      ▼
              chat-soul-bridge (src/index.js)
               ├── src/llm.js         ──> 统一多模型路由（Gemini / OpenAI 兼容 / Anthropic / Antigravity CLI + 思考强度）
               ├── src/image-gen.js   ──> 多协议 AI 画图引擎（Gemini 生图 / OpenAI 兼容）
               ├── src/context-db.js  ──> state/context.db (Node 原生 SQLite 短期滑窗 + 12h/48h 淡出)
               ├── src/impressions.js ──> state/impressions.db (人物印象库 + 大群 O(1) 防漂移注入)
               ├── src/emotion.js     ──> state/emotion.json (好感度与心情双向联动系统)
               ├── src/todos.js       ──> state/todos.json (动态待办清单 + 零轮询单定时器准点提醒 + 超7天随口确认)
               ├── src/identity.js    ──> 代码层 Chat 身份防冒充与场景认知
               ├── src/sync.js        ──> 确定性离线同步门控（收敛落盘返回 status: success）
               ├── src/memory.js      ──> state/memory.json & tools/Diary/YYYY-MM-DD.md
               ├── src/meme.js        ──> tools/meme/ (本地表情包百宝箱)
               └── src/db.js          ──> scripts/memory-db.py & scripts/recall.py
                                                └── state/memory.db (SQLite + FTS5 全量记忆库)
```

---

## 目录结构

```text
chat-soul-bridge/
├── src/
│   ├── index.js           # 主入口：OneBot WS 连接、唤醒策略、分条发送、主动冒泡
│   ├── bootstrap.js       # 入口最前置引导（切换子 Bot 数据目录 + 加载分层 .env）
│   ├── runtime.js         # 多 Bot 运行时解析、分层 .env（子目录优先覆盖根目录）与共用资源回退
│   ├── snowluma-discover.js # 动态扫描用户指定的 SnowLuma/NapCat 目录，自动发现 OneBot 注入配置
│   ├── bot-scaffold.js    # 自动生成 bots/<名称>/ 独立目录（含各自 start.bat / config.json / .env / state/）
│   ├── config.js          # 统一配置加载、默认值合并与旧顶层字段向下兼容
│   ├── llm.js             # 多模型统一协议适配层（Gemini / OpenAI 兼容 / Anthropic / Antigravity CLI）
│   ├── image-gen.js       # 多协议 AI 画图引擎（Gemini 生图 / OpenAI 兼容 /images/generations）
│   ├── context-db.js      # 本地短期对话滑窗数据库（state/context.db）
│   ├── db.js              # Python SQLite + FTS5 写入与 recall.py 检索封装
│   ├── tools.js           # 内置工具声明、执行分发与代码级隐私/安全守卫
│   ├── memory.js          # 长期小本本、日记与内存最近消息缓存
│   ├── media-archive.js   # 图片记忆归档库（state/media/，LRU 清理 + 原图回看与追回）
│   ├── emotion.js         # 好感度与即时心情双向联动引擎（state/emotion.json）
│   ├── todos.js           # 动态待办清单（state/todos.json，零轮询单定时器准点提醒 + 超 7 天确认再删）
│   ├── impressions.js     # 人物印象数据库（state/impressions.db，按账号建档与大群 O(1) 防漂移注入）
│   ├── identity.js        # 代码层 Chat 身份校验、防冒充标签与场景认知
│   ├── forward.js         # 合并转发自动展开（含嵌套与内嵌图）与消息单条/打包转发
│   ├── sync.js            # 确定性离线同步门控（等待 Chat 客户端真上线 -> 收敛检测 -> 返回 status: success）
│   ├── persona.js         # 人设文件解析（自动热加载角色名与唤醒关键词）
│   └── meme.js            # 本地表情包文件夹管理（偷图、去重、检索、发送）
├── scripts/
│   ├── start-bot.mjs      # 统一启动器（支持根目录单 Bot 及 --bot=<名称> / --data-dir=<路径> 多开）
│   ├── init-env.mjs       # 环境初始化 + 交互式 SnowLuma 发现与多 Bot 一键生成向导（npm run init）
│   ├── sync-offline.mjs   # 离线记忆库同步脚本（npm run sync-memory，落盘后输出 status: success）
│   ├── recover-media.mjs  # 历史图片原图追回脚本（npm run recover-media，将未过期原图归档至 state/media/）
│   ├── memory-db.py       # 初始化与常驻写入 state/memory.db（含 FTS5 索引）
│   ├── recall.py          # 本地记忆库检索（FTS5 + LIKE + 可选向量 RRF 融合）
│   └── import-history.mjs # 从 OneBot 网关迁移历史私聊/群聊记录到 memory.db
├── roles/
│   └── persona-tools-detail.txt # 全部 Bot 自动共用的通用工具与安全规范（与具体角色解耦）
├── bots/                        # 自动生成的多 Bot 独立运行目录（已加入 .gitignore，按账号隔离）
│   └── bot_<ID>/
│       ├── start.bat            # 双击单开该 Bot（共享根目录 src/ 代码）
│       ├── config.json          # 该 Bot 独立配置（自动预填 SnowLuma 端口/Token/botQQ）
│       ├── .env                 # 该 Bot 独立模型 API Key（优先覆盖根目录 .env）
│       ├── roles/persona.txt    # 该 Bot 独立人设卡（自带完整 Chat 活人感模板，保存即热更新）
│       ├── tools/Diary/         # 该 Bot 独立每日 Markdown 日记目录
│       ├── tools/meme/          # 该 Bot 独立本地表情包目录
│       ├── assets/              # 该 Bot 独立三视图/参考图目录
│       └── state/               # 该 Bot 独立数据库与状态文件（100% 物理隔离）
├── config.example.json          # 脱敏全量注释配置母板（供 init 自动生成各 Bot 配置）
├── .env.example                 # 环境变量母板（供 init 自动生成各 Bot .env）
├── init.bat                     # Windows 一键初始化与 SnowLuma/NapCat 自动发现向导
└── package.json
```

---

## 快速开始

### 1. 环境准备

- **Node.js** `>= 22.12.0`（需内置 `node:sqlite` 与原生 `WebSocket`）
- **Python** `>= 3.9`（标准库内置 `sqlite3` 且支持 `FTS5`，无需额外 pip 依赖）
- 一个运行中的 **OneBot v11** 协议端（如 SnowLuma、NapCat、Lagrange 等，需开启正向 WebSocket 与 HTTP API）
- 任意一家支持的模型 API Key（Google Gemini / DeepSeek / OpenAI / Anthropic / OpenRouter / 本地 Ollama 等）

### 2. 安装依赖

```bash
npm install
```

### 3. 一键生成 Bot 运行目录（支持单 Bot 与多 Bot 同框架多开）

Windows 直接双击根目录 **`init.bat`**，或任意系统在终端运行：

```bash
npm run init
# 也可直接通过参数传入协议端目录：
# npm run init -- --snowluma-dir="你的SnowLuma或NapCat目录"
```

按提示输入你本机的 SnowLuma / NapCat 安装目录（或 `config` 目录，绝不写死路径），脚本会自动识别其中全部 `onebot_<ID>.json` / `onebot11_<ID>.json` 配置，勾选 1 个或多个账号后自动按账号生成完全隔离的 `bots/bot_<ID>/` 文件夹：
- **`bots/bot_<ID>/start.bat`**：双击直接单开这只 Bot（macOS / Linux 运行 `npm start -- --bot=bot_<ID>`）；
- **`bots/bot_<ID>/config.json`**：已自动填好该 Bot 的 SnowLuma 端口、Token、`botQQ` 和 `ownerQQ`（多只 Bot 一起生成时还会自动互加为 `同群AI伙伴` 防互怼）；
- **`bots/bot_<ID>/.env`**：独立模型 API Key（运行时先读根目录 `.env` 兜底，再用本文件覆盖同名变量，不同 Bot 可各自挂不同模型和 Key）；
- **`bots/bot_<ID>/roles/persona.txt`**：自带完整 Chat 活人感模板，填好人设即可（通用工具规范 `roles/persona-tools-detail.txt` 默认自动共用根目录）；
- **`bots/bot_<ID>/tools/Diary/`、`tools/meme/`、`assets/` 与 `state/`**：日记、表情包、参考图与四层记忆库 100% 物理隔离，同时共用同一套 `src/` 代码。

> 如果使用其他 OneBot v11 协议端，也可跳过自动扫描，直接运行 `npm run init -- --bot=bot_<机器人账号>` 一键生成空白独立目录模板后再手动填 `config.json`。

### 4. 核对必配项并启动

打开 `bots/bot_<ID>/` 下的 `.env`、`config.json` 和 `roles/persona.txt`，确认以下必配项已填妥（通过 SnowLuma 自动发现生成时，第 ②、③ 项已自动预填）：

#### ① 配置 API Key 与大模型（`.env` + `config.json`）

1. 打开 `.env`，填入你所选服务商的 API Key（例如使用 Gemini 填 `GEMINI_API_KEY`，使用 DeepSeek 填 `DEEPSEEK_API_KEY`）：
   ```env
   GEMINI_API_KEY=你的真实APIKey
   # DEEPSEEK_API_KEY=你的真实APIKey
   # OPENAI_API_KEY=你的真实APIKey
   # ANTHROPIC_API_KEY=你的真实APIKey
   ```
2. 打开 `config.json` 的 `llm` 字段，选定 `llm.active` 并填上该服务商对应的**模型 ID**（代码内零写死模型名与接口地址，切换模型只需改一行 `llm.active`；`apiKey` 推荐用 `"${ENV_VAR}"` 读取 `.env`，也支持直接填明文）：
   ```json
   "llm": {
     "active": "gemini",
     "temperature": 1.0,
     "maxTokens": 1024,
     "maxContextTurns": 20,
     "providers": {
       "gemini": {
         "protocol": "gemini",
         "apiKey": "${GEMINI_API_KEY}",
         "baseUrl": "",
         "model": "填写你的 Gemini 模型 ID（如 gemini-3.8-flash）",
         "fallbackModels": []
       }
     }
   }
   ```

#### ② 配置 OneBot 网关与机器人账号（`config.json -> snowluma`）

填入你的 OneBot v11 正向 WebSocket 地址、HTTP API 地址、`accessToken` 以及机器人自己的账号 `botQQ`（用于过滤自发消息与识别 `@`）：

```json
"snowluma": {
  "wsUrl": "ws://127.0.0.1:3001/?access_token=你的WS令牌",
  "httpUrl": "http://127.0.0.1:3000",
  "accessToken": "你的HTTP令牌",
  "botQQ": 1000000000
}
```

#### ③ 配置管理员账号（`config.json -> ownerQQ`）

把 `ownerQQ` 改成**你自己的管理员 Chat 账号**：

```json
"ownerQQ": 1234567890
```

> 管理员账号拥有以下专属权限：私聊全量记忆检索、专属好感度与心情联动、`qq_send_to_group`（私聊遥控让机器人往群里带话）、接收群里触发的 `qq_dm_owner` 悄悄话，以及在多 Bot 群聊中重置防互刷计数。

#### ④ 配置白名单与黑名单（`allow` / `deny` / `trustedGroups`）

本项目有**多层白名单**，默认采用最安全的白名单模式（`allowAllPrivate: false`、`allowAllGroups: false`）：

```json
"allowAllGroups": false,
"allowAllPrivate": false,
"allow": {
  "private": [1234567890],
  "groups": [987654321]
},
"deny": {
  "private": [],
  "groups": []
},
"memoryPrivacy": {
  "trustedGroups": [987654321],
  "privateMemoryGroups": []
}
```

- **消息收发白名单（`allow.private` / `allow.groups`）**：
  - 当 `allowAllPrivate` / `allowAllGroups` 为 `false` 时，**只有在 `allow.private` 里的私聊账号和 `allow.groups` 里的群号才会触发机器人回复**（记得至少把你自己的管理员账号填进 `allow.private`！）。
  - 如果想让所有非黑名单私聊或群聊都能对话，把 `allowAllPrivate` 或 `allowAllGroups` 改成 `true` 即可。
  - **黑名单 `deny` 永远优先级最高**，填入其中的账号或群号无论白名单如何配置都会被拦截。
- **记忆隐私分级白名单（`memoryPrivacy.trustedGroups` / `privateMemoryGroups`）**：
  - `trustedGroups` 仅填写你完全信任的亲密小群群号，可与管理员私聊互通记忆、小本本、日记与待办；
  - `privateMemoryGroups` 填写熟人群，打通私聊日常聊天记忆但严守隐私边界（代码层硬禁日记、待办、情感与私聊原图）；
  - **未填入的普通外部群会被代码层强制全量隔离**，绝不泄露私聊内容与情感状态。

#### ⑤ （可选）定制角色人设

编辑 `bots/bot_<ID>/roles/persona.txt`（顶部用 `---` 声明角色名与群聊唤醒关键词，**与根目录 `roles/persona-tools-detail.txt` 工具规范彻底解耦，换角色无需动工具文档也无需改 `config.json`**，保存即热生效）：

```text
---
name: 你的角色名
keywords: 唤醒词1, 唤醒词2, 唤醒词3
---
人设描述：...
人设三视图/参考图：./assets/
```

#### 启动命令速查

```bash
# Windows：直接双击 bots/bot_<ID>/start.bat（多只 Bot 各自双击即可多开）
# macOS / Linux 或命令行启动：
npm start -- --bot=bot_1000000000

# 手动新增一个独立 Bot 目录模板（含 bots/bot_2000000000/start.bat）
npm run init -- --bot=bot_2000000000
```

### 5. （可选）导入已有 Chat 历史记录与追回历史图片

首次部署后，可一键把指定 Bot 的 Chat 私聊与群聊记录导入其独立的 `state/memory.db`（自动按 `(scope, message_id)` 去重）：

```bash
npm run import-history -- --bot=bot_1000000000
npm run recover-media -- --bot=bot_1000000000
npm run sync-memory -- --bot=bot_1000000000
```

---

## 完整配置说明（`config.json`）

| 字段 | 说明 |
| --- | --- |
| `snowluma.wsUrl` | OneBot v11 正向 WebSocket 地址（含 `access_token`） |
| `snowluma.httpUrl` | OneBot v11 HTTP API 地址 |
| `snowluma.accessToken` | OneBot HTTP API 鉴权令牌 |
| `snowluma.botQQ` | 机器人自身 Chat 账号（用于过滤自发消息与识别 `@`） |
| `llm.active` | 当前启用的提供商名称（对应 `llm.providers` 里的键名，改这一行即可秒切模型） |
| `llm.providers.<name>.protocol` | 底层协议类型：`gemini`、`openai`（含 DeepSeek / GPT / Qwen / Kimi / Ollama 等兼容接口）、`anthropic`（Claude）、`agy-cli`（本机 Antigravity CLI 无头长连接 + Chat 工具桥接） |
| `llm.providers.<name>.baseUrl` | 接口地址（`openai` / `anthropic` 必填；`gemini` 留空走官方地址，填值可接反代） |
| `llm.providers.<name>.apiKey` | API Key，支持明文填写或 `"${ENV_VAR}"` 引用 `.env` |
| `llm.providers.<name>.model` | 主力模型 ID（不写死，按自身需求与服务商文档填写） |
| `llm.providers.<name>.fallbackModels` | 备用模型列表，主模型报错或高负载时自动顺延降级 |
| `llm.temperature` | 生成温度（默认 `1.0`） |
| `llm.thinkingLevel` | 模型思考强度（可选，留空走模型默认；支持 `none` / `minimal` / `low` / `medium` / `high` / `xhigh`，也可在单个 `providers.<name>` 内覆盖；自动映射为 Gemini `thinking_level`、OpenAI `reasoning_effort`、Claude `thinking.budget_tokens`） |
| `llm.maxContextTurns` | 本地 `state/context.db` 保留的最近对话轮数（默认 `20` 轮 = 40 条） |
| `proxyUrl` | 可选 HTTP/HTTPS 代理地址（如 `http://127.0.0.1:7890`；`127.0.0.1/localhost` 自动直连） |
| `ownerQQ` | **必配**：管理员/主人 Chat 账号（私聊全记忆、好感度/心情绑定、跨群传话与打小报告权限） |
| `identity` | **可选**：静态身份认知配置（`ownerTitle`、`ownerNickname`、`aiBots` 仅标记同群其他 AI 伙伴用于防双 AI 互怼，多开 `init` 自动互填；人类动态熟人关系统一归 `state/impressions.db` 热增删，同时向下兼容旧版 `knownUsers`） |
| `allowAllGroups` / `allowAllPrivate` | 是否自动放行所有非黑名单群聊 / 私聊（默认 `false`，仅放行白名单） |
| `allow` / `deny` | 私聊与群聊**白名单** / **黑名单**（黑名单优先；默认模式下需将允许对话的账号与群号填入 `allow`） |
| `groupTrigger` | 群聊触发策略：`atMention`、`replyToMe`、`keywords`、`topicKeywords`/`topicBoostStep`/`topicMaxBoost`（角色兴趣话题热度概率加成，自动读取 `roles/persona.txt` 的 `topics`）、`ownerRandomReplyProbability`/`ownerReplyCooldownMs`/`ownerFollowupWindowMs`（管理员优先唤醒与连聊加成）、`randomReplyProbability`（普通群友默认 `0.3`）、`botRandomReplyProbability`（同群 AI 伙伴低概率防互刷）、`randomReplyCooldownMs`、`maxConsecutiveWithoutOwner` |
| `proactive` | 主动冒泡配置：`enabled`、`privateEnabled`、`groupIds`、`idleThresholdMs`、`checkIntervalMinMs/MaxMs`、`probability`、`quietStartHour/EndHour` |
| `tools` | 联网工具开关：`webSearch`（免费网页搜索/抓取，默认开启）、`googleSearch`（Gemini 原生搜索，需付费层级） |
| `imageGen` | 可选 AI 画图配置（`qq_draw_image`）：支持 `gemini` 原生生图（可带 `assets/` 参考图）与 `openai` 兼容 `/images/generations`（如硅基流动 FLUX/Kolors、GPT Image 等）；未启用时自动隐藏 |
| `memoryPrivacy` | **记忆隐私分级白名单**：`trustedGroups`（亲密小群，完全互通私聊/小本本/日记/待办）；`privateMemoryGroups`（熟人互通群，打通私聊聊天记忆/小本本/人物印象供心里有数，代码层硬禁日记/待办/情感/私聊原图且严守群聊隐私护栏）；其余外群全量隔离 |
| `impressions` | 人物印象库配置（`state/impressions.db`）：`enabled`、`injectMaxUsers`（每轮最多注入人数，默认 `2`，大群防漂移）、`maxCharsPerUser`（每人字数上限，默认 `60`） |
| `mediaArchive` | 图片记忆归档配置（`state/media/`）：`enabled`、`autoCaption`（新收图异步补写图注进 FTS5）、`maxFiles`（默认 `300`）、`maxTotalMB`（默认 `200`） |
| `startupCatchup` | 上线确定性同步门控：`enabled`、`replyUnread`、`replyGroupOwner`、`preloadCount`、`onlinePollMs`、`probeIntervalMs`、`maxProbes`、`maxAgeMinutes`（普通消息默认 `120` 分钟）、`mentionMaxAgeMinutes`（明确 `@` 或提到角色名/唤醒词放宽至 `720` 分钟=12 小时）、`mentionReplyLastOnly`（默认 `true`，提到角色时只采取最后那一条）、`maxUnreadPerChat`（普通离线合并条数上限，默认 `8`） |
| `reply` | 回复节奏与媒体限制：`maxBurstParts`（分条气泡上限，默认 `4`）、`maxImageBytes`（收图大小上限，默认 `5MB`） |
| `contextFade` | 短期滑窗时间阶梯淡出（`state/context.db`）：`fullWindowHours`（默认 `12`）、`overnightMaxTurns`（默认 `4`）、`maxAgeHours`（默认 `48`） |
| `emotion` | 好感与心情引擎（`state/emotion.json`）：`enabled`、`moodHalfLifeHours`（`4`）、`affectionCooldownMinutes`（`60`）、`milestoneCooldownHours`（`24`）、`dailyNormalGainCap`（`2`） |
| `todos` | 动态待办清单（`state/todos.json`）：`enabled`、`maxItems`（`20`）、`staleDays`（超 `7` 天随口问再删）、`injectMaxItems`（`5`） |
| `forward` | 合并转发解析与发送：`autoExpand`、`maxExpandItems`（`25`）、`maxExpandDepth`（`2`）、`maxExpandImages`（`4`）、`maxSendNodes`（`20`） |
| `paths` | 相对路径配置（相对当前 Bot 目录 `bots/bot_<ID>/`）：`personaFile`（`roles/persona.txt`）、`toolsPromptFile`（`roles/persona-tools-detail.txt`，本目录未放时自动回退共用仓库根目录）、`memeDir`（`tools/meme`）、`diaryDir`（`tools/Diary`）、`pythonBin`（可选，留空自动探测）；完全向下兼容旧版顶层写法 |

---

## 内置工具列表

模型可根据对话语境自主决定调用以下工具：

| 类别 | 工具名 | 说明 |
| --- | --- | --- |
| **联网检索** | `web_search` / `web_fetch` | 免费实时搜索新闻、天气、攻略与读取公开网页正文（拦截内网 SSRF） |
| **历史记忆** | `qq_recall` / `qq_view_memory_image` | 检索本地 `state/memory.db`（FTS5 + 图注检索 + 隐私硬过滤）；按 `message_id` 从本地归档或协议端现场追回并查看历史原图 |
| **实时上下文** | `get_recent_messages` / `get_current_time` | 翻看当前会话最近 30 条记录 / 获取当前准确时间与时段 |
| **小本本与日记** | `memory_save` / `memory_list` / `memory_delete` / `diary_write` / `diary_read` | 跨 `/reset` 的长期小本本与每日 Markdown 日记（`tools/Diary/YYYY-MM-DD.md`，同步写入 SQLite 索引） |
| **动态待办清单** | `qq_todo` (`add` / `done` / `list`) | 轻量动态待办数组（`state/todos.json`），零轮询单 `setTimeout` 准点提醒，超 7 天未做自动随口问一句、确认后再删（外部群隐藏） |
| **好感与心情** | `qq_affection_adjust` / `qq_mood_adjust` | 长期好感度（含冷却/日上限/高分衰减）与即时心情（4h 半衰期、双向挂钩） |
| **人物印象库** | `qq_impression_update`（读详档自动搭车 `qq_recall`） | 按账号动态增删改群友/熟人印象、关系标签与演变日志（按群分区物理隔离、大群 O(1) 精准注入） |
| **形象参考图** | `get_self_image` / `send_self_image` | 按需查看或发送 `assets/` 中的角色三视图/参考图 |
| **AI 画图** | `qq_draw_image` | 按提示词现场画图并转 `base64://` 发送到聊天窗口（需开启 `imageGen`，支持带角色参考图） |
| **本地表情包** | `meme_list` / `meme_send` / `meme_save` | 浏览、发送或偷图收藏到 `tools/meme/`（自动去重与路径安全校验） |
| **Chat 原生互动** | `qq_reply_message` / `qq_send_poke` / `qq_get_forward_msg` / `qq_forward_messages` / `qq_list_stickers` / `qq_send_sticker` | 引用回复、拍一拍、展开/读取合并转发（新收到的转发会自动展开并入库）、单条/打包转发消息、发送收藏表情 |
| **跨聊传话** | `qq_dm_owner` / `qq_send_to_group` | 群内悄悄私聊管理员打小报告（带冷却）；管理员私聊遥控向群里带话（鉴权锁死） |

---

## 聊天指令

在 Chat 私聊或群聊中直接发送以下消息即可触发：

- `/reset`、`/清空`、`重置记忆`：清空当前窗口在 `state/context.db` 中的短期对话上下文（**不会**删除 `state/memory.json` 长期小本本、`state/emotion.json` 情感状态和 `state/memory.db` 历史库）。

---

## 致谢与声明

- 感谢 `qq-bridge` 作者开源，本项目基于 `qq-bridge` 更改。
- 请勿将真实 `.env`、`config.json`、`state/`、`bots/`、`assets/` 以及个人隐私表情包（`tools/meme/`）提交至公开仓库（均已在 `.gitignore` 中默认排除）。
- 本项目仅作为 OneBot v11 与各类大模型 API 的学习与技术交流示例，请遵守相关平台服务条款与当地法律法规。

## License

[MIT](LICENSE)
