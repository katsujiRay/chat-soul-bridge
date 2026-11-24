/**
 * 本地表情包百宝箱（默认目录 tools/meme/）
 *
 * 功能：
 *   - cacheMessageImages / resolveCachedImageUrl：缓存刚收到的 QQ 图片地址，供模型随时“偷图”；
 *   - saveMemeFromUrl：下载图片 -> 通过魔数识别真实后缀 -> SHA-1 自动去重 -> 写入本地与 index.json；
 *   - listLocalMemes ：实时扫描目录（兼容用户手动拖入的图片）并支持按文件名/描述/标签筛选；
 *   - readMemeBase64 ：安全校验路径不越界后编码为 OneBot 通用的 base64:// 字符串发送。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { formatNow } from './memory.js';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const INDEX_NAME = 'index.json';

// 缓存最近收到消息的图片 URL，方便模型随时调用 meme_save 存图
const messageImageCache = new Map(); // message_id -> [url, ...]
const chatLatestImageCache = new Map(); // chatKey -> { messageId, urls }

/** 缓存单条消息中的图片链接（自动淘汰最旧记录，防止内存增长） */
export function cacheMessageImages(chatKey, messageId, urls) {
  if (!Array.isArray(urls) || urls.length === 0) return;
  const clean = urls.filter(Boolean);
  if (clean.length === 0) return;

  if (messageId) {
    messageImageCache.set(String(messageId), clean);
    if (messageImageCache.size > 300) {
      const first = messageImageCache.keys().next().value;
      messageImageCache.delete(first);
    }
  }
  chatLatestImageCache.set(chatKey, { messageId: String(messageId || ''), urls: clean });
}

export function resolveCachedImageUrl(chatKey, messageId, index = 0) {
  if (messageId) {
    const byId = messageImageCache.get(String(messageId));
    if (byId && byId[index]) return byId[index];
  }
  const latest = chatLatestImageCache.get(chatKey);
  if (latest && latest.urls[index]) return latest.urls[index];
  return null;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadIndex(memeDir) {
  const idxPath = path.join(memeDir, INDEX_NAME);
  try {
    if (fs.existsSync(idxPath)) {
      return JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    }
  } catch {}
  return {};
}

function saveIndex(memeDir, data) {
  ensureDir(memeDir);
  fs.writeFileSync(path.join(memeDir, INDEX_NAME), JSON.stringify(data, null, 2), 'utf8');
}

function detectExt(buf, contentType = '') {
  // 先看魔数（最准）
  if (buf.length >= 6 && buf.slice(0, 4).toString('ascii') === 'GIF8') return '.gif';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (
    buf.length >= 12 &&
    buf.slice(0, 4).toString('ascii') === 'RIFF' &&
    buf.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return '.webp';
  }
  const ct = contentType.toLowerCase();
  if (ct.includes('gif')) return '.gif';
  if (ct.includes('png')) return '.png';
  if (ct.includes('webp')) return '.webp';
  return '.jpg';
}

function sanitizeFileName(raw) {
  const s = String(raw || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\.+$/g, '')
    .trim()
    .slice(0, 40);
  return s || `meme_${Date.now()}`;
}

export function listLocalMemes(memeDir, { keyword = '', limit = 30 } = {}) {
  ensureDir(memeDir);
  const index = loadIndex(memeDir);
  const files = fs
    .readdirSync(memeDir)
    .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()));

  let items = files.map((filename) => {
    const meta = index[filename] || {};
    const stem = path.basename(filename, path.extname(filename));
    return {
      filename,
      desc: meta.desc || stem,
      tags: Array.isArray(meta.tags) ? meta.tags : [],
    };
  });

  const kw = String(keyword || '').trim().toLowerCase();
  if (kw) {
    items = items.filter(
      (it) =>
        it.filename.toLowerCase().includes(kw) ||
        it.desc.toLowerCase().includes(kw) ||
        it.tags.some((t) => String(t).toLowerCase().includes(kw))
    );
  }

  const maxN = Math.max(1, Math.min(50, Number(limit) || 30));
  return { total: files.length, count: Math.min(items.length, maxN), memes: items.slice(0, maxN) };
}

export async function saveMemeFromUrl(memeDir, { url, name, desc = '', tags = [], maxBytes = 8 * 1024 * 1024 }) {
  ensureDir(memeDir);
  if (!url) return { ok: false, error: '找不到要保存的图片地址，请确认最近消息里包含图片' };

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return { ok: false, error: `下载图片失败: HTTP ${res.status}` };
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) return { ok: false, error: '图片为空' };
  if (buf.length > maxBytes) return { ok: false, error: `图片太大（>${Math.round(maxBytes / 1024 / 1024)}MB）` };

  const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
  const index = loadIndex(memeDir);

  // 去重：已经存过一模一样的图就直接更新备注/标签并返回
  for (const [existingFile, meta] of Object.entries(index)) {
    if (meta?.sha1 === sha1 && fs.existsSync(path.join(memeDir, existingFile))) {
      if (desc) meta.desc = String(desc).trim();
      if (Array.isArray(tags) && tags.length > 0) meta.tags = tags.map(String);
      saveIndex(memeDir, index);
      return { ok: true, filename: existingFile, duplicate: true, message: '这张表情包已经存过啦' };
    }
  }

  const ext = detectExt(buf, res.headers.get('content-type') || '');
  const baseName = sanitizeFileName(name || desc);
  let filename = `${baseName}${ext}`;
  let seq = 2;
  while (fs.existsSync(path.join(memeDir, filename))) {
    filename = `${baseName}_${seq}${ext}`;
    seq += 1;
  }

  fs.writeFileSync(path.join(memeDir, filename), buf);
  index[filename] = {
    desc: String(desc || baseName).trim(),
    tags: Array.isArray(tags) ? tags.map(String) : [],
    sha1,
    savedAt: formatNow(),
  };
  saveIndex(memeDir, index);

  return { ok: true, filename, size: buf.length };
}

export function readMemeBase64(memeDir, filename) {
  ensureDir(memeDir);
  const safeName = path.basename(String(filename || '').trim());
  if (!safeName || safeName === INDEX_NAME) {
    return { ok: false, error: '无效的表情包文件名' };
  }
  const fullPath = path.resolve(memeDir, safeName);
  const resolvedRoot = path.resolve(memeDir);
  if (!fullPath.startsWith(resolvedRoot + path.sep)) {
    return { ok: false, error: '非法路径' };
  }
  if (!fs.existsSync(fullPath)) {
    return { ok: false, error: `表情包不存在: ${safeName}` };
  }
  const buf = fs.readFileSync(fullPath);
  return { ok: true, filename: safeName, base64: `base64://${buf.toString('base64')}` };
}
