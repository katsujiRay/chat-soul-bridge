/**
 * 本地轻量图片记忆归档库（state/media/）
 *
 * 作用：
 *   QQ 的图片 CDN 链接（gchat.qpic.cn）通常几天后会过期失效。
 *   本模块将触发交互时的收图、AI 画出的图，以及历史追回的原图按 message_id 归档到本地 state/media/：
 *     1. 按魔数识别真实格式（png / jpg / gif / webp）+ SHA-1 去重；
 *     2. 记录来源分区（scope / groupId / userId），在外部群查询时严格校验防跨群泄密；
 *     3. 按 maxFiles / maxTotalMB 自动 LRU 滚动清理最旧图片，绝不撑爆硬盘。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STATE_DIR = path.resolve(process.cwd(), 'state');
const MEDIA_DIR = path.join(STATE_DIR, 'media');
const INDEX_FILE = path.join(MEDIA_DIR, 'index.json');

export function getMediaArchiveDir() {
  return MEDIA_DIR;
}

export function ensureMediaArchiveDir() {
  const existed = fs.existsSync(MEDIA_DIR);
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  if (!fs.existsSync(INDEX_FILE)) {
    fs.writeFileSync(INDEX_FILE, '{}\n', 'utf8');
  }
  return existed;
}

function loadIndex() {
  ensureMediaArchiveDir();
  try {
    const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveIndex(idx) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  fs.writeFileSync(INDEX_FILE, `${JSON.stringify(idx, null, 2)}\n`, 'utf8');
}

function detectImageType(buf, fallbackMime = 'image/jpeg') {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: '.png', mimeType: 'image/png' };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: '.jpg', mimeType: 'image/jpeg' };
  }
  if (buf.length >= 6 && buf.slice(0, 4).toString('ascii') === 'GIF8') {
    return { ext: '.gif', mimeType: 'image/gif' };
  }
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') {
    return { ext: '.webp', mimeType: 'image/webp' };
  }
  const m = String(fallbackMime || 'image/jpeg').toLowerCase();
  if (m.includes('png')) return { ext: '.png', mimeType: 'image/png' };
  if (m.includes('webp')) return { ext: '.webp', mimeType: 'image/webp' };
  if (m.includes('gif')) return { ext: '.gif', mimeType: 'image/gif' };
  return { ext: '.jpg', mimeType: 'image/jpeg' };
}

function sanitizeMsgId(messageId) {
  return String(messageId || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
}

/** 按 maxFiles / maxTotalMB 自动 LRU 清理最旧归档文件 */
function pruneArchive(idx, maxFiles = 300, maxTotalMB = 200) {
  const maxBytes = Math.max(10, Number(maxTotalMB) || 200) * 1024 * 1024;
  const maxCount = Math.max(10, Number(maxFiles) || 300);

  const entries = Object.entries(idx).sort(
    (a, b) => Number(a[1]?.savedAt || 0) - Number(b[1]?.savedAt || 0)
  );
  let totalFiles = 0;
  let totalBytes = 0;
  for (const [, meta] of entries) {
    for (const f of meta?.files || []) {
      totalFiles += 1;
      totalBytes += Number(f.size || 0);
    }
  }

  let changed = false;
  for (const [msgId, meta] of entries) {
    if (totalFiles <= maxCount && totalBytes <= maxBytes) break;
    for (const f of meta?.files || []) {
      const full = path.join(MEDIA_DIR, path.basename(f.file || ''));
      try {
        if (fs.existsSync(full)) fs.unlinkSync(full);
      } catch {}
      totalFiles -= 1;
      totalBytes -= Number(f.size || 0);
    }
    delete idx[msgId];
    changed = true;
  }
  return changed;
}

/** 将一组 base64 图片按 message_id 归档至 state/media/ */
export function archiveImagesForMessage({
  messageId,
  images = [],
  scope = 'private',
  groupId = null,
  userId = null,
  maxFiles = 300,
  maxTotalMB = 200,
}) {
  const key = String(messageId || '').trim();
  if (!key || !Array.isArray(images) || images.length === 0) return [];

  const idx = loadIndex();
  const existing = idx[key] || {
    scope,
    groupId: groupId != null ? String(groupId) : null,
    userId: userId != null ? String(userId) : null,
    savedAt: Date.now(),
    files: [],
  };
  const seenHashes = new Set((existing.files || []).map((f) => f.sha1));
  const safePrefix = sanitizeMsgId(key);
  const savedFiles = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img?.data) continue;
    const buf = Buffer.from(img.data, 'base64');
    if (buf.length === 0) continue;
    const sha1 = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
    if (seenHashes.has(sha1)) continue;

    const { ext, mimeType } = detectImageType(buf, img.mimeType);
    const filename = `m_${safePrefix}_${existing.files.length + 1}_${sha1}${ext}`;
    const fullPath = path.join(MEDIA_DIR, filename);
    fs.writeFileSync(fullPath, buf);

    const record = { file: filename, mimeType, size: buf.length, sha1 };
    existing.files.push(record);
    seenHashes.add(sha1);
    savedFiles.push(record);
  }

  if (existing.files.length > 0) {
    existing.savedAt = Date.now();
    idx[key] = existing;
    pruneArchive(idx, maxFiles, maxTotalMB);
    saveIndex(idx);
  }
  return savedFiles;
}

export function getArchivedMeta(messageId) {
  const key = String(messageId || '').trim();
  if (!key) return null;
  const idx = loadIndex();
  const meta = idx[key];
  if (!meta || !Array.isArray(meta.files) || meta.files.length === 0) return null;
  // 校验磁盘文件仍存在
  const liveFiles = meta.files.filter((f) => fs.existsSync(path.join(MEDIA_DIR, path.basename(f.file || ''))));
  if (liveFiles.length === 0) return null;
  return { ...meta, files: liveFiles };
}

export function hasArchivedImages(messageId) {
  return Boolean(getArchivedMeta(messageId));
}

/** 隐私校验：外部普通群只能看本群自己的归档图，非主人私聊只能看自己私聊的图 */
export function canReadArchivedMeta(meta, { isUntrustedGroup = false, groupId = null, isOtherPrivate = false, userId = null } = {}) {
  if (!meta) return true;
  if (isUntrustedGroup) {
    return meta.scope === 'group' && String(meta.groupId || '') === String(groupId || '');
  }
  if (isOtherPrivate) {
    return meta.scope === 'private' && String(meta.userId || '') === String(userId || '');
  }
  return true;
}

/** 读取某条 message_id 已归档的本地原图（返回 base64 列表） */
export function readArchivedImages(messageId, maxCount = 2) {
  const meta = getArchivedMeta(messageId);
  if (!meta) return [];

  const result = [];
  for (const f of meta.files.slice(0, Math.max(1, maxCount))) {
    const safeName = path.basename(f.file || '');
    const fullPath = path.join(MEDIA_DIR, safeName);
    if (!fullPath.startsWith(MEDIA_DIR + path.sep)) continue;
    try {
      const buf = fs.readFileSync(fullPath);
      if (buf.length > 0) {
        result.push({
          file: safeName,
          mimeType: f.mimeType || 'image/jpeg',
          data: buf.toString('base64'),
        });
      }
    } catch {}
  }
  return result;
}
