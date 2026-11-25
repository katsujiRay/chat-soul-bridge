/**
 * 模型内置工具定义与执行分发器
 *
 * 包含六大类工具：
 *   1. 免费联网搜索与网页抓取（web_search / web_fetch，带内网 SSRF 拦截）
 *   2. 历史记忆库检索与近期记录（chat_recall / get_recent_messages / get_current_time）
 *   3. 角色形象参考图（get_self_image / send_self_image）
 *   4. 本地表情包百宝箱（meme_list / meme_send / meme_save）
 *   5. Chat 原生互动与跨聊传话（chat_reply_message / chat_dm_owner / chat_send_to_group / chat_send_poke / chat_get_forward_msg / chat_*_stickers）
 *   6. 长期小本本与日记（memory_* / diary_*）
 *
 * 安全设计：
 *   - 陌生外部群（不在 memoryPrivacy.trustedGroups 中）在代码层强制隔离私聊、日记与小本本；
 *   - 跨群传话（chat_send_to_group）在代码层强制校验仅限主人私聊触发。
 */
import fs from 'node:fs';
import path from 'node:path';
import { recallFromDb, saveChatMessageToDb, saveDiaryToDb } from './db.js';
import { adjustAffection, adjustMood } from './emotion.js';
import { resolveForwardMessage, sendForwardMessages } from './forward.js';
import { detectImageMime } from './gif.js';
import { generateImage } from './image-gen.js';
import {
  clearUserImpression,
  findUserImpressionByQuery,
  resolveImpressionScope,
  updateUserImpression,
} from './impressions.js';
import {
  archiveImagesForMessage,
  canReadArchivedMeta,
  getArchivedMeta,
  hasArchivedImages,
  readArchivedImages,
} from './media-archive.js';
import { listLocalMemes, readMemeBase64, resolveCachedImageUrl, saveMemeFromUrl } from './meme.js';
import {
  deleteMemory,
  formatNow,
  getRecentMessages,
  loadMemories,
  readDiary,
  recordRecentMessage,
  saveMemory,
  writeDiary,
} from './memory.js';
import { listPersonaReferenceImages } from './persona.js';
import { addTodo, completeTodo, listTodos } from './todos.js';

/** 粗略剥离 HTML 标签与常见实体，用于网页搜索摘要和正文提取 */
function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function freeWebSearch(query, limit = 5) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: '搜索词不能为空' };

  // 优先走 Bing 网页搜索（中英文稳定、免费），失败兜底 DuckDuckGo Lite
  try {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=${limit}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const html = await res.text();
      const results = [];
      const blocks = html.split(/<li class="b_algo"[^>]*>/i).slice(1);
      for (const block of blocks) {
        if (results.length >= limit) break;
        const linkMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!linkMatch) continue;
        const snippetMatch =
          block.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || block.match(/<div class="b_caption"[^>]*>([\s\S]*?)<\/div>/i);
        results.push({
          title: stripHtml(linkMatch[2]),
          url: linkMatch[1],
          snippet: stripHtml(snippetMatch ? snippetMatch[1] : '').slice(0, 220),
        });
      }
      if (results.length > 0) {
        return { ok: true, engine: 'bing', results };
      }
    }
  } catch {}

  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const html = await res.text();
      const results = [];
      const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/div>)?/gi;
      let m;
      while ((m = re.exec(html)) && results.length < limit) {
        results.push({
          title: stripHtml(m[2]),
          url: m[1],
          snippet: stripHtml(m[3] || m[4] || '').slice(0, 220),
        });
      }
      if (results.length > 0) {
        return { ok: true, engine: 'duckduckgo', results };
      }
    }
  } catch {}

  return { ok: false, error: '暂时没搜到结果，稍后再试试吧' };
}

async function fetchWebPage(url) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) {
    return { ok: false, error: '只支持 http/https 链接' };
  }
  const parsed = new URL(target);
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[::1\])/i.test(parsed.hostname)) {
    return { ok: false, error: '安全限制：禁止抓取内网/本机地址' };
  }
  const res = await fetch(target, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const text = stripHtml(await res.text());
  return { ok: true, url: target, content: text.slice(0, 3000) };
}

export function buildTools({ enableGoogleSearch = false, enableWebSearch = true } = {}) {
  const tools = [];
  if (enableGoogleSearch) {
    tools.push({ type: 'google_search' });
  }

  if (enableWebSearch) {
    tools.push(
      {
        type: 'function',
        name: 'web_search',
        description: '联网搜索最新资讯、天气、新闻、热梗、游戏攻略或事实资料。不知道的事先搜一下再答。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '搜索关键词。',
            },
          },
          required: ['query'],
        },
      },
      {
        type: 'function',
        name: 'web_fetch',
        description: '打开并读取一个公开网页链接的正文内容（例如群友发来的文章或搜索结果链接）。',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: '以 http:// 或 https:// 开头的网页地址。',
            },
          },
          required: ['url'],
        },
      }
    );
  }

  tools.push(
    {
      type: 'function',
      name: 'get_current_time',
      description: '获取当前的准确日期、星期、时间和时段。',
      parameters: { type: 'object', properties: {} },
    },
    {
      type: 'function',
      name: 'chat_recall',
      description: '从本地 SQLite 历史记忆库（支持全文索引与向量检索）翻查以前聊过的聊天记录或日记。当对方提起“上次”“之前”“还记得吗”或你想确认以前说过什么时调用，不要凭空瞎编。',
      parameters: {
        type: 'object',
        properties: {
          keyword: {
            type: 'string',
            description: '要搜索的关键词或短句（例如 "小鱼干"、"答应过"、"4090"）。',
          },
          scope: {
            type: 'string',
            description: '可选：只搜私聊填 "private"，只搜群聊填 "group"，不填则全库搜。',
          },
          who: {
            type: 'string',
            description: '可选：限定某位发言者的 账号。',
          },
          since: {
            type: 'string',
            description: '可选：限定起始日期，格式 YYYY-MM-DD。',
          },
          source: {
            type: 'string',
            description: '可选："chat"（默认，聊天记录）、"diary"（日记）或 "all"（两边一起搜）。',
          },
          limit: {
            type: 'integer',
            description: '最多返回条数，默认 6。',
          },
        },
      },
    },
    {
      type: 'function',
      name: 'get_recent_messages',
      description: '读取当前群聊或私聊最近收到的聊天记录（含 message_id、发送者、账号、内容），用于了解刚才大家聊了什么或找到要引用的消息。',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            description: '获取条数，默认 15，最多 30。',
          },
        },
      },
    },
    {
      type: 'function',
      name: 'chat_reply_message',
      description: '引用回复某一条具体的 聊天消息。在群里人多、或者要精准回较早的一句话时使用。调用此工具会直接发消息到聊天窗口，不要在最终文本里再重复说一遍同样的话。',
      parameters: {
        type: 'object',
        properties: {
          message_id: {
            type: 'string',
            description: '要引用的消息 message_id（从聊天记录或当前消息里获取）。',
          },
          text: {
            type: 'string',
            description: '要发送的纯文本回复内容（不要带 Markdown 或动作描写）。',
          },
        },
        required: ['message_id', 'text'],
      },
    },
    {
      type: 'function',
      name: 'chat_dm_owner',
      description: '偷偷给主人发一条私聊消息！当群里发生了特别好玩的事、或者你想单独跟主人打小报告/说悄悄话时可以用。别频繁刷屏，真的好玩或有事才发。',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: '要私聊发给主人的纯文本消息（不要带 Markdown 或动作描写）。',
          },
        },
        required: ['text'],
      },
    },
    {
      type: 'function',
      name: 'chat_send_to_group',
      description: '【仅限主人私聊时可用】帮主人把一句话转达/带到指定 群里（例如主人在私聊让你去群里通知事情或替他传话）。不填 group_id 时默认发到主人的信任亲密小群。',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: '要发到群里的纯文本消息（不要带 Markdown 或动作描写）。',
          },
          group_id: {
            type: 'string',
            description: '可选：目标群号；不填则默认发到信任亲密小群。',
          },
        },
        required: ['text'],
      },
    },
    {
      type: 'function',
      name: 'chat_send_poke',
      description: '给对方发一个 账号 拍一拍（戳一戳），用来回拍或逗熟人玩，别频繁使用。',
      parameters: {
        type: 'object',
        properties: {
          user_id: {
            type: 'string',
            description: '要戳的 账号；私聊可不填（默认戳当前聊天对象），群聊请填对方 账号。',
          },
        },
      },
    },
    {
      type: 'function',
      name: 'chat_get_forward_msg',
      description:
        '读取一条历史 合并转发消息里的具体文字和图片内容（新收到的合并转发系统已自动展开，若翻查旧记录遇到未展开的 [合并转发 id=...] 时调用）。',
      parameters: {
        type: 'object',
        properties: {
          forward_id: {
            type: 'string',
            description: '合并转发消息的 id。',
          },
        },
        required: ['forward_id'],
      },
    },
    {
      type: 'function',
      name: 'chat_forward_messages',
      description:
        '帮用户转发 聊天消息（支持单条直接转发、按多条 message_id 打包成合并转发卡片，或把多段内容拼成合并转发发送）。默认发到当前会话；在亲密小群可转发给主人私聊，仅在主人私聊中可跨群转发到指定群。',
      parameters: {
        type: 'object',
        properties: {
          message_ids: {
            type: 'array',
            items: { type: 'string' },
            description:
              '可选：要转发的已有消息 message_id 列表（从 get_recent_messages 或 chat_recall 获取；1 条默认直接转发，2 条及以上自动打包合并转发）。',
          },
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sender_name: { type: 'string', description: '可选：该条节点显示昵称（默认用角色自己名字）。' },
                sender_id: { type: 'string', description: '可选：该条节点头像账号（默认用机器人自身账号）。' },
                content: { type: 'string', description: '必填：该条转发节点里的文本内容。' },
              },
              required: ['content'],
            },
            description: '可选：自定义合并转发内容节点（适合把整理好的长内容、总结或历史摘录打包成合并转发卡片）。',
          },
          target_type: {
            type: 'string',
            enum: ['current', 'group', 'private'],
            description: '可选：转发目标类型，默认 "current"（当前聊天窗口）；跨聊传话可填 "group" 或 "private"。',
          },
          target_id: {
            type: 'string',
            description:
              '可选：跨聊转发时的目标群号或 账号（target_type="group" 留空默认发到亲密小群；target_type="private" 留空默认发给主人）。',
          },
          as_bundle: {
            type: 'boolean',
            description: '可选：即使只有 1 条 message_id，是否也强制包装成合并转发卡片，默认 false。',
          },
        },
      },
    },
    {
      type: 'function',
      name: 'get_self_image',
      description: '查看自己的人设三视图/参考图（如果已配置），用来确认自己的发色、衣服、装饰等外观细节。',
      parameters: { type: 'object', properties: {} },
    },
    {
      type: 'function',
      name: 'send_self_image',
      description: '把你自己的形象参考图/三视图发送到当前 聊天里（当对方说“看看你长什么样”“发张你的图/三视图”时使用）。',
      parameters: {
        type: 'object',
        properties: {
          index: {
            type: 'integer',
            description: '可选：发第几张参考图（从 1 开始，默认 1）。',
          },
        },
      },
    },
    {
      type: 'function',
      name: 'meme_list',
      description: '查看本地表情包文件夹（tools/meme）里存的所有表情包，可按关键词搜索含义/标签/文件名。发表情包前先用它挑一张最应景的。',
      parameters: {
        type: 'object',
        properties: {
          keyword: {
            type: 'string',
            description: '可选：按情绪、场景或标签筛选（例如 "笑"、"委屈"、"无语"），不填则列出全部。',
          },
          limit: {
            type: 'integer',
            description: '最多返回多少条，默认 30。',
          },
        },
      },
    },
    {
      type: 'function',
      name: 'meme_send',
      description: '从本地表情包文件夹（tools/meme）里挑选一张表情包发到当前 聊天里（需先用 meme_list 拿到准确的 filename）。接梗、吐槽、卖萌、得意或无语时可以用，别连续刷屏。',
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: '表情包文件名（从 meme_list 获取，例如 "委屈.gif"）。',
          },
        },
        required: ['filename'],
      },
    },
    {
      type: 'function',
      name: 'meme_save',
      description: '看到别人发了好玩、以后想拿来用的表情包/图片时，把它保存到本地表情包文件夹（tools/meme）并起个好记的名字和说明。',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '简短好记的中文文件名（不含后缀，例如 "嚣张得意"、"无语翻白眼"）。',
          },
          desc: {
            type: 'string',
            description: '简短描述这张图是什么画面、适合什么时候用。',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '可选：2~4 个情绪/场景标签，例如 ["得意", "嘲笑", "吐槽"]。',
          },
          message_id: {
            type: 'string',
            description: '可选：要保存的图片所在消息的 message_id；不填则默认保存当前会话最新收到的一张图。',
          },
        },
        required: ['name', 'desc'],
      },
    },
    {
      type: 'function',
      name: 'chat_list_stickers',
      description: '查看机器人 收藏的表情包列表（返回表情包图片 URL 列表）。',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            description: '最多返回多少个，默认 15。',
          },
        },
      },
    },
    {
      type: 'function',
      name: 'chat_send_sticker',
      description: '发送一张 收藏表情包图片（需先从 chat_list_stickers 拿到 URL）。适合接梗、吐槽或卖萌，别刷屏。',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '表情包图片 URL。',
          },
        },
        required: ['url'],
      },
    },
    {
      type: 'function',
      name: 'memory_save',
      description: '把值得长期记住的事（例如主人的喜好、约定、群友特点）记进长期小本本，清空会话也不会忘。',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: '简短的记忆标题，例如 "主人喜欢的食物" 或 "群友小王的梗"。',
          },
          value: {
            type: 'string',
            description: '具体要记住的一句话内容。',
          },
        },
        required: ['key', 'value'],
      },
    },
    {
      type: 'function',
      name: 'memory_list',
      description: '查看长期小本本里记录的所有记忆。',
      parameters: { type: 'object', properties: {} },
    },
    {
      type: 'function',
      name: 'memory_delete',
      description: '删除一条过时或不再需要的长期记忆。',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: '要删除的记忆标题。',
          },
        },
        required: ['key'],
      },
    },
    {
      type: 'function',
      name: 'chat_affection_adjust',
      description: '调整对主人的长期好感度（仅主人私聊，1h冷却，勿报分数）：走心+1/难忘+2/里程碑+3~+5(每周一次)/冷落-2/越界-5/失望-8。',
      parameters: {
        type: 'object',
        properties: {
          delta: {
            type: 'number',
            description: '变化幅度：走心 +1、难忘 +2、里程碑 +3~+5（每周限一次）；冷落 -2、越界 -5、严重失望 -8（范围 -10~+10）。',
          },
          reason: {
            type: 'string',
            description: '必填：真实具体的原因（为什么好感变了）。',
          },
        },
        required: ['delta', 'reason'],
      },
    },
    {
      type: 'function',
      name: 'chat_mood_adjust',
      description: '调整当下即时心情（-100~+100，5分钟冷却，会随时间回归并与好感联动）：开心/被哄好传 +10~+40，委屈/低落/生气传 -10~-40，有真实情绪波动就调。',
      parameters: {
        type: 'object',
        properties: {
          delta: {
            type: 'number',
            description: '心情变化幅度：正数 +5 ~ +40，负数 -5 ~ -40。',
          },
          reason: {
            type: 'string',
            description: '必填：真实具体的原因（为什么此刻变成这个心情）。',
          },
        },
        required: ['delta', 'reason'],
      },
    },
    {
      type: 'function',
      name: 'diary_write',
      description:
        '在你的专属日记文件夹（tools/Diary/YYYY-MM-DD.md）里写一条日记（记录开心、委屈或值得纪念的事，一天写一两次就够，别每轮都写）。',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: '用角色自己的口吻写的简短日记内容。',
          },
        },
        required: ['content'],
      },
    },
    {
      type: 'function',
      name: 'diary_read',
      description: '从你的专属日记文件夹（tools/Diary）里翻看最近写过的日记。',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            description: '查看最近几条日记，默认 5。',
          },
        },
      },
    },
    {
      type: 'function',
      name: 'chat_impression_update',
      description:
        '动态增删改熟人与人物印象档案（按 账号存入 state/impressions.db，免改配置即刻热生效，外部群自动隔离不串群）。发现对方明显性格、喜好、外号或主人交代“XX是我朋友/熟人”时调用；传 clear=true 可动态移除熟人关系与印象。平时水聊别频繁调。',
      parameters: {
        type: 'object',
        properties: {
          user_id: {
            type: 'string',
            description: '目标人物的 账号（可从消息前缀括号内获取；留空默认当前发言人）。',
          },
          impression: {
            type: 'string',
            description: '新增/更新时填写：精炼的一句话总印象（建议 15~60 字，最多 100 字）。',
          },
          relation: {
            type: 'string',
            description: '可选：简短关系定位（如 发小 / 熟人 / 损友 / 夜猫子群友），会实时体现在对方的身份前缀中。',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '可选：2~4 个简短性格或兴趣标签。',
          },
          reason: {
            type: 'string',
            description: '可选：这次更新或移除的原因（记入演变日志，便于日后 chat_recall 翻查）。',
          },
          clear: {
            type: 'boolean',
            description: '可选：传 true 表示动态移除/清空该用户的熟人关系、标签与印象（恢复为普通群友）。',
          },
        },
      },
    },
    {
      type: 'function',
      name: 'chat_draw_image',
      description:
        '现场调用 AI 画图工具生成一张真实图片并直接发送到当前 账号 会话。只有真正需要画图/创作配图时才调用；发图成功后请自然补一句简短评价即可，切勿打字假装“（发送图片）”。',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: '详细的画面描述（建议英文或清晰中文，写明主体、动作、场景、画风与光线）。',
          },
          aspect_ratio: {
            type: 'string',
            description: '可选画面比例：1:1、16:9、9:16、4:3、3:4，默认 1:1。',
          },
          use_self_reference: {
            type: 'boolean',
            description: '如果画面里包含角色自己且已配置参考图，传 true 以保持角色外貌一致。',
          },
          caption: {
            type: 'string',
            description: '可选：随图片一起发出的简短配文。',
          },
        },
        required: ['prompt'],
      },
    },
    {
      type: 'function',
      name: 'chat_view_memory_image',
      description:
        '查看历史记忆中的某张原图（优先读本地 state/media/ 永久归档，未归档的旧记录自动尝试调 OneBot 追回原图并归档）。当 chat_recall 查出的记录里带有 [图片] 或 hasImage=true 且你想亲眼看清图里细节时调用。',
      parameters: {
        type: 'object',
        properties: {
          message_id: {
            type: 'string',
            description: '目标图片消息的 message_id（可从 chat_recall 返回项的 messageId 获取）。',
          },
        },
        required: ['message_id'],
      },
    },
    {
      type: 'function',
      name: 'chat_todo',
      description:
        '管理动态待办小纸条（state/todos.json，仅对管理员私聊与亲密小群生效）。用于记住答应主人要办的事或定时提醒；办完、提醒完或主人确认不做时立即用 action="done" 删掉。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'done', 'list'],
            description: 'add=新增待办；done=完成/取消并从数组删除；list=查看全部待办。',
          },
          content: {
            type: 'string',
            description: 'add 时必填（精炼待办内容，如“提醒老大明天10点开会”）；done 时可作关键词辅助匹配。',
          },
          id: {
            type: 'integer',
            description: 'done 时优先传入待办编号（例如 1）。',
          },
          due_at: {
            type: 'string',
            description:
              '可选（仅 add 时）：明确提醒时间，如 "2026-11-24 10:00"、"明天 09:00"、"今天 22:30" 或 "+30m"；不填则为普通随手待办。',
          },
        },
        required: ['action'],
      },
    }
  );

  return tools;
}

/**
 * 按当前会话场景动态裁剪暴露给模型的工具列表，减少无关 Schema 占用的注意力与 token：
 *   - 没配置/没放角色参考图时隐藏 get_self_image / send_self_image；
 *   - 未启用 imageGen 生图功能时隐藏 chat_draw_image；
 *   - 主人私聊隐藏 chat_dm_owner（本来就在私聊）；
 *   - 信任亲密小群隐藏仅限主人私聊的好感度与跨群带话工具；
 *   - 外部普通群与非主人私聊隐藏全部私密记忆/日记/情感/跨群带话工具（与 executeTool 内守卫双保险）。
 */
export function selectToolsForContext(
  allTools,
  {
    chatKey = '',
    ownerId = null,
    trustedGroups = [],
    hasReferenceImages = false,
    hasImageGen = false,
    enableEmotion = true,
    enableTodos = true,
  } = {}
) {
  const trustedSet = new Set((trustedGroups || []).map(String));
  const isGroup = String(chatKey).startsWith('group:');
  const groupId = isGroup ? String(chatKey).slice('group:'.length) : '';
  const userId = String(chatKey).startsWith('private:') ? String(chatKey).slice('private:'.length) : '';
  const isOwnerPrivate = !isGroup && Boolean(ownerId) && userId === String(ownerId);
  const isOtherPrivate = !isGroup && !isOwnerPrivate;
  const isTrustedGroup = isGroup && trustedSet.has(groupId);
  const isUntrustedGroup = isGroup && !isTrustedGroup;

  const hidden = new Set();
  if (!hasReferenceImages) {
    hidden.add('get_self_image');
    hidden.add('send_self_image');
  }
  if (!hasImageGen) {
    hidden.add('chat_draw_image');
  }
  if (!enableEmotion) {
    hidden.add('chat_affection_adjust');
    hidden.add('chat_mood_adjust');
  }
  if (!enableTodos) {
    hidden.add('chat_todo');
  }
  if (!ownerId) {
    hidden.add('chat_dm_owner');
    hidden.add('chat_affection_adjust');
  }

  if (isOwnerPrivate) {
    hidden.add('chat_dm_owner');
  } else if (isTrustedGroup) {
    hidden.add('chat_affection_adjust');
    hidden.add('chat_send_to_group');
  } else if (isUntrustedGroup || isOtherPrivate) {
    hidden.add('chat_affection_adjust');
    hidden.add('chat_mood_adjust');
    hidden.add('chat_send_to_group');
    hidden.add('memory_save');
    hidden.add('memory_list');
    hidden.add('memory_delete');
    hidden.add('diary_read');
    hidden.add('diary_write');
    hidden.add('chat_todo');
  }

  return allTools.filter((t) => !t?.name || !hidden.has(t.name));
}

export function createToolExecutor({
  sendOneBot,
  log,
  ownerId = null,
  botId = null,
  trustedGroups = [],
  privateMemoryGroups = [],
  denyGroups = [],
  denyPrivate = [],
  memeDir = path.resolve(process.cwd(), 'tools', 'meme'),
  diaryDir = path.resolve(process.cwd(), 'tools', 'Diary'),
  imageGenConfig = { enabled: false },
  enableEmotion = true,
  enableTodos = true,
  forwardConfig = {},
  getBotName = () => 'Bot',
  getReferencePath = () => '',
}) {
  const trustedSet = new Set(trustedGroups.map(String));
  const privateMemSet = new Set(privateMemoryGroups.map(String));
  const denyGroupSet = new Set(denyGroups.map(String));
  const denyPrivateSet = new Set(denyPrivate.map(String));
  const defaultTrustedGroupId = trustedGroups.length > 0 ? Number(trustedGroups[0]) : null;
  let lastDmOwnerAt = 0;
  let lastDrawAt = 0;

  return async function executeTool(name, args = {}, ctx = {}) {
    const { chatKey, event, markDirectSent } = ctx;
    const isGroup = event?.message_type === 'group';
    const isTrustedGroup = isGroup && trustedSet.has(String(event?.group_id));
    const isPrivateMemoryGroup = isGroup && !isTrustedGroup && privateMemSet.has(String(event?.group_id));
    const isUntrustedGroup = isGroup && !isTrustedGroup;

    log(`调用工具 ${name}(${JSON.stringify(args).slice(0, 120)})`);

    try {
      switch (name) {
        case 'web_search':
          return await freeWebSearch(args.query, 5);

        case 'web_fetch':
          return await fetchWebPage(args.url);

        case 'get_current_time':
          return { now: formatNow() };

        case 'chat_recall': {
          // 隐私隔离边界（代码层硬约束）：
          // 1) 陌生外人群：强制只查当前群聊记录，屏蔽私聊、其他群和日记；
          // 2) 熟人互通群（privateMemoryGroups）：允许查私聊聊天记录 + 当前群（硬禁日记与其他群），并附带隐私禁令警示；
          // 3) 信任亲密小群（trustedGroups）：允许私聊 + 当前群 + 日记互通（屏蔽无关外人群）；
          // 4) 私聊：全库互通。
          let recallRes;
          if (isPrivateMemoryGroup) {
            const wantPrivateOnly = args.scope === 'private';
            const wantGroupOnly = args.scope === 'group';
            recallRes = await recallFromDb({
              keyword: args.keyword || '',
              scope: wantPrivateOnly ? 'private' : wantGroupOnly ? 'group' : undefined,
              groupId: wantGroupOnly ? event.group_id : undefined,
              allowPrivateAndGroup: !wantPrivateOnly && !wantGroupOnly ? event.group_id : undefined,
              who: args.who,
              since: args.since,
              source: 'chat', // 硬禁日记，只通聊天记忆
              limit: args.limit || 6,
            });
          } else if (isUntrustedGroup) {
            recallRes = await recallFromDb({
              keyword: args.keyword || '',
              scope: 'group',
              groupId: event.group_id,
              who: args.who,
              since: args.since,
              source: 'chat',
              limit: args.limit || 6,
            });
          } else if (isTrustedGroup) {
            const wantPrivateOnly = args.scope === 'private';
            const wantGroupOnly = args.scope === 'group';
            recallRes = await recallFromDb({
              keyword: args.keyword || '',
              scope: wantPrivateOnly ? 'private' : wantGroupOnly ? 'group' : undefined,
              groupId: wantGroupOnly ? event.group_id : undefined,
              allowPrivateAndGroup: !wantPrivateOnly && !wantGroupOnly ? event.group_id : undefined,
              who: args.who,
              since: args.since,
              source: args.source || 'chat',
              limit: args.limit || 6,
            });
          } else {
            recallRes = await recallFromDb({
              keyword: args.keyword || '',
              scope: args.scope,
              who: args.who,
              since: args.since,
              source: args.source || 'chat',
              limit: args.limit || 6,
            });
          }

          // 给带图的历史记录标注可看图标记（熟人互通群严禁标注/调看私聊原图）
          let hasPrivateRecallHit = false;
          if (recallRes && Array.isArray(recallRes.items)) {
            recallRes.items = recallRes.items.map((item) => {
              if (item.scope === 'private') hasPrivateRecallHit = true;
              if (isPrivateMemoryGroup && item.scope === 'private') {
                return item;
              }
              const mid = String(item.messageId || '').trim();
              const archived = mid ? hasArchivedImages(mid) : false;
              const looksLikeImg = /\[图片|\[画了一张图/.test(String(item.text || ''));
              if (archived || (looksLikeImg && mid)) {
                return { ...item, hasImage: true, archivedLocally: archived };
              }
              return item;
            });
          }

          if (isPrivateMemoryGroup && hasPrivateRecallHit && recallRes && typeof recallRes === 'object') {
            recallRes.privacyGuard =
              '以下结果包含来自主人私聊的记忆，仅供你心里有数。当前群里有外人，绝对禁止在群里泄露主人的隐私、私密心事、真实身份/住址/联系方式、账密或私聊中未公开的敏感内容，只可自然运用无害的日常记忆。';
          }

          // 顺手搭车附带人物印象详档与演变日志（遵循同一隐私分区，无需额外读工具）
          try {
            const impScope = resolveImpressionScope(event, { ownerId, trustedGroups, privateMemoryGroups });
            const targetQuery = args.who || args.keyword || '';
            const profileDetail = findUserImpressionByQuery({
              query: targetQuery,
              fallbackUserId: args.who ? '' : event?.user_id,
              readScopes: impScope.readScopes,
              logLimit: 3,
            });
            if (profileDetail && recallRes && typeof recallRes === 'object') {
              return { ...recallRes, person_impression: profileDetail };
            }
          } catch {}

          return recallRes;
        }

        case 'get_recent_messages': {
          const rows = getRecentMessages(chatKey, args.limit || 15);
          return { count: rows.length, messages: rows };
        }

        case 'chat_reply_message': {
          const msgId = String(args.message_id || '').trim();
          const text = String(args.text || '').trim();
          if (!msgId || !text) return { ok: false, error: 'message_id 和 text 不能为空' };
          const segments = [
            { type: 'reply', data: { id: msgId } },
            { type: 'text', data: { text } },
          ];
          let res;
          if (event.message_type === 'group') {
            res = await sendOneBot('send_group_msg', { group_id: event.group_id, message: segments });
          } else {
            res = await sendOneBot('send_private_msg', { user_id: event.user_id, message: segments });
          }
          markDirectSent?.(text);
          recordRecentMessage(chatKey, {
            message_id: String(res?.data?.message_id || 'self'),
            time: formatNow().slice(11, 16),
            user_id: String(event.self_id || ''),
            sender: `${getBotName()}(我)`,
            text: text.slice(0, 120),
          });
          await saveChatMessageToDb({
            scope: event.message_type === 'group' ? 'group' : 'private',
            groupId: event.message_type === 'group' ? event.group_id : null,
            messageId: String(res?.data?.message_id || ''),
            who: event.self_id || 0,
            whoName: getBotName(),
            isSelf: true,
            isOwner: false,
            isTriggered: true,
            text,
          });
          return { ok: true, sent: text };
        }

        case 'chat_dm_owner': {
          const text = String(args.text || '').trim();
          if (!text) return { ok: false, error: '消息内容不能为空' };
          if (!ownerId) return { ok: false, error: '未配置 ownerId' };
          if (event?.message_type === 'private' && String(event?.user_id) === String(ownerId)) {
            return { ok: false, error: '你现在本来就在和主人私聊，直接回复就行，不用调 chat_dm_owner' };
          }
          // 防止群里聊天时疯狂给主人发私聊（60 秒冷却）
          if (Date.now() - lastDmOwnerAt < 60000) {
            return { ok: false, error: '刚才已经给主人发过小报告啦，歇一分钟再发吧' };
          }
          lastDmOwnerAt = Date.now();
          const res = await sendOneBot('send_private_msg', { user_id: Number(ownerId), message: text });
          const privKey = `private:${ownerId}`;
          recordRecentMessage(privKey, {
            message_id: String(res?.data?.message_id || 'self'),
            time: formatNow().slice(11, 16),
            user_id: String(event?.self_id || ''),
            sender: `${getBotName()}(我)`,
            text: text.slice(0, 120),
          });
          await saveChatMessageToDb({
            scope: 'private',
            groupId: null,
            messageId: String(res?.data?.message_id || ''),
            who: event?.self_id || 0,
            whoName: getBotName(),
            isSelf: true,
            isOwner: false,
            isTriggered: true,
            text,
          });
          return { ok: true, sentToOwner: Number(ownerId), text };
        }

        case 'chat_send_to_group': {
          const text = String(args.text || '').trim();
          if (!text) return { ok: false, error: '消息内容不能为空' };
          // 安全硬约束：只有主人在私聊里下达指令时才允许跨群传话
          const isOwnerPrivate =
            event?.message_type === 'private' &&
            ownerId &&
            String(event?.user_id) === String(ownerId);
          if (!isOwnerPrivate) {
            return { ok: false, error: '安全限制：只有主人在私聊里才能让我往群里转达消息哦' };
          }
          const targetGroup = Number(args.group_id || defaultTrustedGroupId);
          if (!targetGroup) return { ok: false, error: '未指定群号且没有默认信任群' };
          if (denyGroupSet.has(String(targetGroup))) {
            return { ok: false, error: `群 ${targetGroup} 在黑名单里，拒绝发送` };
          }
          const res = await sendOneBot('send_group_msg', { group_id: targetGroup, message: text });
          const grpKey = `group:${targetGroup}`;
          recordRecentMessage(grpKey, {
            message_id: String(res?.data?.message_id || 'self'),
            time: formatNow().slice(11, 16),
            user_id: String(event?.self_id || ''),
            sender: `${getBotName()}(我)`,
            text: text.slice(0, 120),
          });
          await saveChatMessageToDb({
            scope: 'group',
            groupId: targetGroup,
            messageId: String(res?.data?.message_id || ''),
            who: event?.self_id || 0,
            whoName: getBotName(),
            isSelf: true,
            isOwner: false,
            isTriggered: true,
            text,
          });
          return { ok: true, sentToGroup: targetGroup, text };
        }

        case 'chat_send_poke': {
          const targetUid = Number(args.user_id || event.user_id);
          if (!targetUid) return { ok: false, error: '缺少有效的 user_id' };
          if (event.message_type === 'group') {
            try {
              await sendOneBot('group_poke', { group_id: event.group_id, user_id: targetUid });
            } catch {
              await sendOneBot('send_poke', { group_id: event.group_id, user_id: targetUid });
            }
          } else {
            try {
              await sendOneBot('friend_poke', { user_id: targetUid });
            } catch {
              await sendOneBot('send_poke', { user_id: targetUid });
            }
          }
          return { ok: true, poked: targetUid };
        }

        case 'chat_get_forward_msg': {
          const id = String(args.forward_id || '').trim();
          if (!id) return { ok: false, error: '缺少 forward_id' };
          const resolved = await resolveForwardMessage(sendOneBot, id, {
            maxItems: Number(forwardConfig?.maxExpandItems ?? 60),
            maxDepth: Number(forwardConfig?.maxExpandDepth ?? 5),
            maxImages: Math.min(3, Number(forwardConfig?.maxExpandImages ?? 4)),
            maxChars: Number(forwardConfig?.maxExpandChars ?? 5000),
          });
          if (!resolved.ok) return resolved;

          if (resolved.imageUrls.length > 0) {
            const parts = [
              {
                type: 'text',
                text: `合并转发内容（外层 ${resolved.totalCount} 条，共展开 ${resolved.shownCount} 条）：\n${resolved.lines.join('\n')}`,
              },
            ];
            for (const url of resolved.imageUrls.slice(0, 3)) {
              try {
                const r = await fetch(url, {
                  headers: { 'User-Agent': 'Mozilla/5.0' },
                  signal: AbortSignal.timeout(10000),
                });
                if (!r.ok) continue;
                const ct = (r.headers.get('content-type') || '').split(';')[0].trim();
                const buf = Buffer.from(await r.arrayBuffer());
                if (buf.length > 0 && buf.length <= 5 * 1024 * 1024) {
                  const mimeType = detectImageMime(buf, ct) || 'image/jpeg';
                  parts.push({ type: 'image', data: buf.toString('base64'), mime_type: mimeType });
                }
              } catch {}
            }
            if (parts.length > 1) {
              return {
                __multimodalResult: parts,
                ok: true,
                count: resolved.totalCount,
                shown: resolved.shownCount,
                messages: resolved.lines,
              };
            }
          }
          return { ok: true, count: resolved.totalCount, shown: resolved.shownCount, messages: resolved.lines };
        }

        case 'chat_forward_messages': {
          const isOwnerPrivate =
            event?.message_type === 'private' &&
            ownerId &&
            String(event?.user_id) === String(ownerId);
          const isOtherPrivate =
            event?.message_type === 'private' &&
            ownerId &&
            String(event?.user_id) !== String(ownerId);

          const curType = event?.message_type === 'group' ? 'group' : 'private';
          const curId = curType === 'group' ? String(event?.group_id || '') : String(event?.user_id || '');
          const reqType = String(args.target_type || 'current').trim().toLowerCase();

          let targetType = curType;
          let targetId = curId;
          if (reqType === 'group') {
            targetType = 'group';
            targetId = String(args.target_id || (curType === 'group' ? curId : defaultTrustedGroupId || '')).trim();
          } else if (reqType === 'private') {
            targetType = 'private';
            targetId = String(args.target_id || (ownerId || curId)).trim();
          } else if (args.target_id && String(args.target_id).trim() !== curId) {
            targetId = String(args.target_id).trim();
          }

          if (!targetId) {
            return { ok: false, error: '未指定有效的转发目标群号或 账号' };
          }

          const isCrossChat = targetType !== curType || String(targetId) !== String(curId);
          if (isCrossChat) {
            if (isUntrustedGroup || isOtherPrivate) {
              return { ok: false, error: '安全限制：在外部群聊或非主人私聊中只能在当前窗口内转发，不能跨聊转发' };
            }
            if (isTrustedGroup) {
              const toOwner = targetType === 'private' && ownerId && String(targetId) === String(ownerId);
              if (!toOwner) {
                return { ok: false, error: '安全限制：在群里跨聊转发仅允许转给主人私聊，不能转到其他群或陌生人' };
              }
            } else if (!isOwnerPrivate) {
              return { ok: false, error: '安全限制：仅限主人私聊可跨群转发消息' };
            }
          }

          if (targetType === 'group' && denyGroupSet.has(String(targetId))) {
            return { ok: false, error: `群 ${targetId} 在黑名单里，拒绝转发` };
          }
          if (targetType === 'private' && denyPrivateSet.has(String(targetId))) {
            return { ok: false, error: `用户 ${targetId} 在黑名单里，拒绝转发` };
          }

          const res = await sendForwardMessages(sendOneBot, {
            targetType,
            targetId,
            messageIds: args.message_ids || [],
            nodes: args.nodes || [],
            asBundle: args.as_bundle === true,
            botId: String(botId || event?.self_id || ''),
            botName: getBotName(),
          });
          if (!res.ok) return res;

          const destKey = targetType === 'group' ? `group:${targetId}` : `private:${targetId}`;
          const previewText = `[已转发 ${res.forwardedCount} 条消息]`;
          recordRecentMessage(destKey, {
            message_id: res.messageId || 'self',
            time: formatNow().slice(11, 16),
            user_id: String(botId || event?.self_id || ''),
            sender: `我·${getBotName()}`,
            text: previewText,
          });
          await saveChatMessageToDb({
            scope: targetType,
            groupId: targetType === 'group' ? Number(targetId) : null,
            messageId: res.messageId || '',
            who: Number(botId || event?.self_id || 0),
            whoName: getBotName(),
            isSelf: true,
            isOwner: false,
            isTriggered: true,
            text: previewText,
          });
          return res;
        }

        case 'get_self_image': {
          const files = listPersonaReferenceImages(getReferencePath(), process.cwd(), 2);
          if (files.length === 0) {
            return { ok: false, message: '当前没有放置人设参考图，按文字设定自由描述即可' };
          }
          const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
          const parts = [
            {
              type: 'text',
              text: `这是你自己的形象参考图（共 ${files.length} 张：${files.map((f) => path.basename(f)).join('、')}），请记住自己的外貌细节。`,
            },
          ];
          for (const f of files) {
            const buf = fs.readFileSync(f);
            if (buf.length > 5 * 1024 * 1024) continue;
            const ext = path.extname(f).toLowerCase();
            parts.push({
              type: 'image',
              data: buf.toString('base64'),
              mime_type: mimeMap[ext] || 'image/png',
            });
          }
          return { __multimodalResult: parts, ok: true, files: files.map((f) => path.basename(f)) };
        }

        case 'send_self_image': {
          const files = listPersonaReferenceImages(getReferencePath(), process.cwd(), 5);
          if (files.length === 0) {
            return { ok: false, message: '当前没有配置形象参考图，先用文字形容自己吧' };
          }
          const idx = Math.max(0, Math.min(files.length - 1, (Number(args.index) || 1) - 1));
          const target = files[idx];
          const buf = fs.readFileSync(target);
          const segments = [{ type: 'image', data: { file: `base64://${buf.toString('base64')}` } }];
          if (event.message_type === 'group') {
            await sendOneBot('send_group_msg', { group_id: event.group_id, message: segments });
          } else {
            await sendOneBot('send_private_msg', { user_id: event.user_id, message: segments });
          }
          return { ok: true, sent: path.basename(target), total: files.length };
        }

        case 'meme_list':
          return listLocalMemes(memeDir, { keyword: args.keyword || '', limit: args.limit || 30 });

        case 'meme_send': {
          const read = readMemeBase64(memeDir, args.filename);
          if (!read.ok) return read;
          const segments = [{ type: 'image', data: { file: read.base64 } }];
          if (event.message_type === 'group') {
            await sendOneBot('send_group_msg', { group_id: event.group_id, message: segments });
          } else {
            await sendOneBot('send_private_msg', { user_id: event.user_id, message: segments });
          }
          recordRecentMessage(chatKey, {
            message_id: 'self',
            time: formatNow().slice(11, 16),
            user_id: String(event.self_id || ''),
            sender: `${getBotName()}(我)`,
            text: `[表情包: ${read.filename}]`,
          });
          return { ok: true, sent: read.filename };
        }

        case 'meme_save': {
          const url = resolveCachedImageUrl(chatKey, args.message_id, 0);
          if (!url) {
            return { ok: false, error: '最近消息里没找到可保存的图片，让对方再发一次或者确认消息带图哦' };
          }
          return await saveMemeFromUrl(memeDir, {
            url,
            name: args.name,
            desc: args.desc,
            tags: args.tags || [],
          });
        }

        case 'chat_list_stickers': {
          const limit = Math.max(1, Math.min(30, Number(args.limit) || 15));
          const res = await sendOneBot('fetch_custom_face', { count: limit });
          const items = Array.isArray(res?.data) ? res.data.slice(0, limit) : [];
          return { ok: true, count: items.length, stickers: items };
        }

        case 'chat_send_sticker': {
          const url = String(args.url || '').trim();
          if (!url) return { ok: false, error: '缺少表情包 url' };
          const segments = [{ type: 'image', data: { file: url, subType: 1 } }];
          if (event.message_type === 'group') {
            await sendOneBot('send_group_msg', { group_id: event.group_id, message: segments });
          } else {
            await sendOneBot('send_private_msg', { user_id: event.user_id, message: segments });
          }
          return { ok: true, sent: true };
        }

        case 'memory_save': {
          if (!args.key || !args.value) return { ok: false, error: 'key 和 value 不能为空' };
          saveMemory(args.key, args.value);
          return { ok: true, saved: { key: args.key, value: args.value } };
        }

        case 'memory_list':
          if (isUntrustedGroup) {
            return { ok: false, error: '当前是外部群聊，为保护隐私不读取私密小本本' };
          }
          return { memories: loadMemories() };

        case 'memory_delete': {
          if (isUntrustedGroup) {
            return { ok: false, error: '当前是外部群聊，不允许修改私密小本本' };
          }
          const existed = deleteMemory(String(args.key || ''));
          return { ok: true, deleted: existed };
        }

        case 'chat_affection_adjust': {
          if (!enableEmotion) {
            return { ok: false, error: '情感系统已在 config.json -> emotion.enabled 中关闭' };
          }
          const isOwnerPrivate =
            event?.message_type === 'private' &&
            ownerId &&
            String(event?.user_id) === String(ownerId);
          if (!isOwnerPrivate) {
            return { ok: false, error: '好感度只对主人本人在私聊中生效，群聊或他人私聊不可调用' };
          }
          return adjustAffection(args.delta, args.reason);
        }

        case 'chat_mood_adjust': {
          if (!enableEmotion) {
            return { ok: false, error: '情感系统已在 config.json -> emotion.enabled 中关闭' };
          }
          const isOtherPrivate =
            event?.message_type === 'private' &&
            ownerId &&
            String(event?.user_id) !== String(ownerId);
          if (isUntrustedGroup || isOtherPrivate) {
            return { ok: false, error: '当前是外部群聊或非主人私聊，不修改与主人关联的个人心情状态' };
          }
          return adjustMood(args.delta, args.reason);
        }

        case 'diary_write': {
          const isOtherPrivate =
            event?.message_type === 'private' &&
            ownerId &&
            String(event?.user_id) !== String(ownerId);
          if (isUntrustedGroup || isOtherPrivate) {
            return { ok: false, error: '当前是外部群聊或非主人私聊，不写入个人私密日记' };
          }
          if (!args.content) return { ok: false, error: '日记内容不能为空' };
          const entry = writeDiary(args.content, diaryDir);
          await saveDiaryToDb({ content: entry.content, day: entry.time.slice(0, 10) });
          return { ok: true, entry };
        }

        case 'diary_read': {
          const isOtherPrivate =
            event?.message_type === 'private' &&
            ownerId &&
            String(event?.user_id) !== String(ownerId);
          if (isUntrustedGroup || isOtherPrivate) {
            return { ok: false, error: '当前是外部群聊或非主人私聊，为保护隐私不翻看个人日记' };
          }
          return { entries: readDiary(args.limit || 5, diaryDir) };
        }

        case 'chat_impression_update': {
          const targetId = String(args.user_id || event?.user_id || '').trim();
          if (!targetId) return { ok: false, error: '缺少目标用户 账号' };
          const impScope = resolveImpressionScope(event, { ownerId, trustedGroups, privateMemoryGroups });
          if (args.clear === true) {
            return clearUserImpression({
              userId: targetId,
              scopeKey: impScope.writeScope,
              reason: args.reason || '',
            });
          }
          const defaultNick =
            String(targetId) === String(event?.user_id || '')
              ? event?.sender?.card || event?.sender?.nickname || ''
              : '';
          return updateUserImpression({
            userId: targetId,
            scopeKey: impScope.writeScope,
            nickname: defaultNick,
            relation: args.relation || '',
            impression: args.impression || '',
            tags: args.tags || [],
            reason: args.reason || '',
          });
        }

        case 'chat_draw_image': {
          if (!imageGenConfig?.enabled) {
            return {
              ok: false,
              error: imageGenConfig?.error || '当前未启用 imageGen 画图配置，请先在 config.json 中启用并填写生图模型与 API Key',
            };
          }
          const prompt = String(args.prompt || '').trim();
          if (!prompt) return { ok: false, error: '画面描述 prompt 不能为空' };

          const cooldownMs = Math.max(0, Number(imageGenConfig.cooldownMs ?? 30000));
          if (cooldownMs > 0 && lastDrawAt && Date.now() - lastDrawAt < cooldownMs) {
            const waitSec = Math.ceil((cooldownMs - (Date.now() - lastDrawAt)) / 1000);
            return { ok: false, error: `画图冷却中，请稍等 ${waitSec} 秒再画下一张` };
          }

          // 如画面包含角色自己且 assets/ 有参考图，自动附带最多 2 张参考图保持外貌一致
          const referenceImages = [];
          if (args.use_self_reference) {
            const refFiles = listPersonaReferenceImages(getReferencePath(), process.cwd(), 2);
            for (const f of refFiles) {
              try {
                const ext = path.extname(f).toLowerCase();
                const mimeType =
                  ext === '.jpg' || ext === '.jpeg'
                    ? 'image/jpeg'
                    : ext === '.webp'
                      ? 'image/webp'
                      : 'image/png';
                referenceImages.push({ data: fs.readFileSync(f).toString('base64'), mimeType });
              } catch {}
            }
          }

          const genRes = await generateImage(imageGenConfig, {
            prompt,
            aspectRatio: args.aspect_ratio || '',
            referenceImages,
          });
          if (!genRes.ok || !genRes.data) {
            return { ok: false, error: `生图失败: ${genRes.error || '未知错误'}` };
          }

          lastDrawAt = Date.now();
          const segments = [{ type: 'image', data: { file: `base64://${genRes.data}` } }];
          const caption = String(args.caption || '').trim();
          if (caption) segments.push({ type: 'text', data: { text: caption } });

          let sentRes;
          if (event?.message_type === 'group') {
            sentRes = await sendOneBot('send_group_msg', { group_id: event.group_id, message: segments });
          } else {
            sentRes = await sendOneBot('send_private_msg', { user_id: event?.user_id, message: segments });
          }

          const sentId = sentRes?.data?.message_id != null ? String(sentRes.data.message_id) : 'self';
          const shortPrompt = prompt.replace(/\s+/g, ' ').slice(0, 60);
          const dbText = caption ? `[画了一张图：${shortPrompt}] ${caption}` : `[画了一张图：${shortPrompt}]`;
          if (sentId !== 'self') {
            try {
              archiveImagesForMessage({
                messageId: sentId,
                images: [{ data: genRes.data, mimeType: genRes.mimeType || 'image/png' }],
                scope: event?.message_type === 'group' ? 'group' : 'private',
                groupId: event?.message_type === 'group' ? event.group_id : null,
                userId: event?.message_type === 'private' ? event.user_id : event?.self_id,
              });
            } catch {}
          }
          recordRecentMessage(chatKey, {
            message_id: sentId,
            time: formatNow().slice(11, 16),
            user_id: String(event?.self_id || ''),
            sender: `我·${getBotName()}`,
            text: dbText.slice(0, 120),
          });
          await saveChatMessageToDb({
            scope: event?.message_type === 'group' ? 'group' : 'private',
            groupId: event?.message_type === 'group' ? event.group_id : null,
            messageId: sentId === 'self' ? '' : sentId,
            who: event?.self_id || 0,
            whoName: getBotName(),
            isSelf: true,
            isOwner: false,
            isTriggered: true,
            text: dbText,
          });
          return { ok: true, sent: true, model: genRes.model };
        }

        case 'chat_view_memory_image': {
          const msgId = String(args.message_id || '').trim();
          if (!msgId) return { ok: false, error: 'message_id 不能为空' };

          const isOtherPrivate =
            event?.message_type === 'private' &&
            ownerId &&
            String(event?.user_id) !== String(ownerId);
          const privacyCtx = {
            isUntrustedGroup,
            groupId: event?.group_id,
            isOtherPrivate,
            userId: event?.user_id,
          };

          // 1. 优先从本地 state/media/ 永久归档读取
          const meta = getArchivedMeta(msgId);
          if (meta) {
            if (!canReadArchivedMeta(meta, privacyCtx)) {
              return { ok: false, error: '出于隐私隔离保护，当前会话不可查看其他私聊或外部群的历史图片' };
            }
            const archived = readArchivedImages(msgId, 2);
            if (archived.length > 0) {
              return {
                ok: true,
                source: 'local_archive',
                count: archived.length,
                __multimodalResult: [
                  { type: 'text', text: `已从本地归档调出历史消息(id=${msgId})中的 ${archived.length} 张原图：` },
                  ...archived.map((img) => ({
                    type: 'image',
                    data: img.data,
                    mime_type: img.mimeType,
                  })),
                ],
              };
            }
          }

          // 2. 本地未归档的旧记录：尝试通过 OneBot get_msg 现场追回原图并自动归档
          try {
            const numId = /^-?\d+$/.test(msgId) ? Number(msgId) : msgId;
            const res = await sendOneBot('get_msg', { message_id: numId });
            const data = res?.data;
            if (!data) {
              return { ok: false, error: '该历史图片本地未归档，且 OneBot 无法找到原消息（可能已过期或撤回）' };
            }
            const msgScope = data.message_type === 'group' ? 'group' : 'private';
            const msgGroupId = data.group_id != null ? String(data.group_id) : null;
            const msgUserId = data.user_id != null ? String(data.user_id) : null;
            if (!canReadArchivedMeta({ scope: msgScope, groupId: msgGroupId, userId: msgUserId }, privacyCtx)) {
              return { ok: false, error: '出于隐私隔离保护，当前会话不可查看其他私聊或外部群的历史图片' };
            }

            const segs = Array.isArray(data.message) ? data.message : [];
            const urls = segs
              .filter((s) => (s?.type === 'image' || s?.type === 'mface') && s.data?.url)
              .map((s) => s.data.url);
            if (urls.length === 0) {
              return { ok: false, error: '原消息中未找到图片链接（可能已过期或不含图片）' };
            }

            const downloaded = [];
            for (const url of urls.slice(0, 2)) {
              try {
                const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
                if (!r.ok) continue;
                const ct = (r.headers.get('content-type') || '').split(';')[0].trim();
                const buf = Buffer.from(await r.arrayBuffer());
                if (buf.length === 0 || buf.length > 8 * 1024 * 1024) continue;
                const mimeType = detectImageMime(buf, ct);
                if (mimeType) {
                  downloaded.push({ data: buf.toString('base64'), mimeType });
                }
              } catch {}
            }
            if (downloaded.length === 0) {
              return { ok: false, error: '该历史图片的 原图链接已过期，无法再下载原图' };
            }

            archiveImagesForMessage({
              messageId: msgId,
              images: downloaded,
              scope: msgScope,
              groupId: msgGroupId,
              userId: msgUserId,
            });

            return {
              ok: true,
              source: 'recovered_from_gateway',
              count: downloaded.length,
              __multimodalResult: [
                { type: 'text', text: `已成功从协议端追回历史消息(id=${msgId})中的 ${downloaded.length} 张原图并自动归档：` },
                ...downloaded.map((img) => ({
                  type: 'image',
                  data: img.data,
                  mime_type: img.mimeType,
                })),
              ],
            };
          } catch (err) {
            return { ok: false, error: `追回历史图片失败: ${err?.message || err}` };
          }
        }

        case 'chat_todo': {
          if (!enableTodos) {
            return { ok: false, error: '待办清单已在 config.json -> todos.enabled 中关闭' };
          }
          const isOtherPrivate =
            event?.message_type === 'private' &&
            ownerId &&
            String(event?.user_id) !== String(ownerId);
          if (isUntrustedGroup || isOtherPrivate) {
            return { ok: false, error: '待办清单仅在管理员私聊与亲密小群中可用，外部群聊不可读写' };
          }
          const action = String(args.action || '').trim().toLowerCase();
          if (action === 'add') {
            return addTodo({ content: args.content, dueAt: args.due_at || '' });
          }
          if (action === 'done') {
            return completeTodo({ id: args.id, content: args.content || '' });
          }
          if (action === 'list') {
            const items = listTodos();
            return { ok: true, count: items.length, items };
          }
          return { ok: false, error: `不支持的 action="${action}"，可选 add / done / list` };
        }

        default:
          return { ok: false, error: `未知工具: ${name}` };
      }
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  };
}
