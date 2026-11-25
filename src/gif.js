/**
 * 零依赖纯 JS GIF 动图解码与分镜拼图渲染器（src/gif.js）
 *
 * 作用：
 *   主流多模态接口对 image/gif 兼容性差异极大（Gemini 直接拒收、部分 OpenAI/CLI 仅看首帧或报错），
 *   本模块在保留 state/media/ 原始 GIF 归档的前提下，在送入大模型前将 GIF 转为标准 PNG：
 *     1. 静态单帧 GIF：直接无损转成单张 PNG；
 *     2. 动态多帧 GIF：两遍式低内存解码（完整支持 GIF87a/89a、LZW、局部色表、隔行扫描、透明色与 4 种 disposal 模式），
 *        按时间均匀抽取关键帧并渲染为带帧序号的网格分镜图（2x1 / 3x1 / 2x2 / 3x2 / 3x3），
 *        让 Gemini / OpenAI / Anthropic / agy-cli 全部零依赖看懂动图动作与字幕变化。
 */
import zlib from 'node:zlib';

const MAX_GIF_DIM = 2048;
const MAX_GIF_PIXELS = MAX_GIF_DIM * MAX_GIF_DIM;
const MAX_GIF_FRAMES = 600;

// 预计算 PNG CRC32 查找表
const CRC32_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/** 将 RGB24 缓冲区编码为标准 PNG（使用 Node 内置 zlib，零外部依赖） */
export function encodeRgbToPng(rgb, width, height) {
  const stride = width * 3;
  // 每行前加 1 字节过滤类型（1 = Sub 过滤，对动图与纯色块压缩率显著高于 0）
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const dstRow = y * (stride + 1);
    const srcRow = y * stride;
    raw[dstRow] = 1; // Sub filter
    for (let x = 0; x < stride; x++) {
      const cur = rgb[srcRow + x];
      const left = x >= 3 ? rgb[srcRow + x - 3] : 0;
      raw[dstRow + 1 + x] = (cur - left) & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: Truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = zlib.deflateSync(raw, { level: 6 });
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', idat),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 通过文件魔数精确识别常见图片格式（修复部分 CDN 返回 application/octet-stream 或错误 Content-Type 的问题） */
export function detectImageMime(buf, fallbackMime = '') {
  if (Buffer.isBuffer(buf) && buf.length >= 4) {
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return 'image/png';
    }
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return 'image/jpeg';
    }
    if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
      return 'image/gif';
    }
    if (
      buf.length >= 12 &&
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46 &&
      buf[8] === 0x57 &&
      buf[9] === 0x45 &&
      buf[10] === 0x42 &&
      buf[11] === 0x50
    ) {
      return 'image/webp';
    }
  }
  const lower = String(fallbackMime || '').split(';')[0].trim().toLowerCase();
  if (lower.startsWith('image/')) return lower;
  return '';
}

export function isGifBuffer(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  );
}

/** 跳过 GIF 子块序列并返回新游标 */
function skipSubBlocks(buf, pos) {
  let p = pos;
  while (p < buf.length) {
    const len = buf[p++];
    if (len === 0) break;
    p += len;
  }
  return Math.min(p, buf.length);
}

/** 读取 GIF 子块拼接后的原始字节并返回 { data, nextPos } */
function readSubBlocks(buf, pos) {
  let total = 0;
  let scan = pos;
  while (scan < buf.length) {
    const len = buf[scan++];
    if (len === 0) break;
    const avail = Math.min(len, buf.length - scan);
    total += avail;
    scan += avail;
  }
  const out = new Uint8Array(total);
  let p = pos;
  let offset = 0;
  while (p < buf.length) {
    const len = buf[p++];
    if (len === 0) break;
    const avail = Math.min(len, buf.length - p);
    out.set(buf.subarray(p, p + avail), offset);
    offset += avail;
    p += avail;
  }
  return { data: out, nextPos: Math.min(p, buf.length) };
}

/** GIF LZW 解码器（完整支持 Clear / EOI / 4096 满表延迟重置） */
function decodeLzw(minCodeSize, data, pixelCount) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const output = new Uint8Array(pixelCount);

  const prefix = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4096);

  let codeSize = minCodeSize + 1;
  let codeMask = (1 << codeSize) - 1;
  let available = eoiCode + 1;
  let prevCode = -1;
  let firstChar = 0;
  let outPos = 0;

  let bitBuf = 0;
  let bitCount = 0;
  let bytePos = 0;

  const resetTable = () => {
    codeSize = minCodeSize + 1;
    codeMask = (1 << codeSize) - 1;
    available = eoiCode + 1;
    prevCode = -1;
  };

  while (outPos < pixelCount) {
    while (bitCount < codeSize && bytePos < data.length) {
      bitBuf |= data[bytePos++] << bitCount;
      bitCount += 8;
    }
    if (bitCount < codeSize) break;

    const code = bitBuf & codeMask;
    bitBuf >>>= codeSize;
    bitCount -= codeSize;

    if (code === clearCode) {
      resetTable();
      continue;
    }
    if (code === eoiCode) {
      break;
    }

    if (prevCode === -1) {
      if (code < clearCode) {
        output[outPos++] = code;
        prevCode = code;
        firstChar = code;
      }
      continue;
    }

    let inCode = code;
    let stackTop = 0;
    if (code >= available) {
      if (code > available) break; // 畸形码流安全退出
      stack[stackTop++] = firstChar;
      inCode = prevCode;
    }

    while (inCode >= clearCode) {
      if (stackTop >= 4096) break;
      stack[stackTop++] = suffix[inCode];
      inCode = prefix[inCode];
    }
    firstChar = inCode & 0xff;
    stack[stackTop++] = firstChar;

    if (available < 4096) {
      prefix[available] = prevCode;
      suffix[available] = firstChar;
      available++;
      if (available === 1 << codeSize && codeSize < 12) {
        codeSize++;
        codeMask = (1 << codeSize) - 1;
      }
    }
    prevCode = code;

    while (stackTop > 0 && outPos < pixelCount) {
      output[outPos++] = stack[--stackTop];
    }
  }

  return output;
}

/** 反隔行扫描（Interlaced GIF 4-pass 还原） */
function deinterlace(pixels, width, height) {
  const out = new Uint8Array(width * height);
  const starts = [0, 4, 2, 1];
  const steps = [8, 8, 4, 2];
  let srcY = 0;
  for (let pass = 0; pass < 4; pass++) {
    for (let y = starts[pass]; y < height; y += steps[pass]) {
      const dstOff = y * width;
      const srcOff = srcY * width;
      if (srcOff + width <= pixels.length) {
        out.set(pixels.subarray(srcOff, srcOff + width), dstOff);
      }
      srcY++;
    }
  }
  return out;
}

/** Pass 1：极速扫描帧数、总时长与画布尺寸（不解压 LZW，零大图内存占用） */
function scanGifMetadata(buf) {
  if (!isGifBuffer(buf) || buf.length < 13) return null;
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  if (width <= 0 || height <= 0 || width > MAX_GIF_DIM || height > MAX_GIF_DIM || width * height > MAX_GIF_PIXELS) {
    return null;
  }

  const packed = buf[10];
  const gctFlag = (packed & 0x80) !== 0;
  const gctSize = gctFlag ? 1 << ((packed & 7) + 1) : 0;
  let pos = 13 + gctSize * 3;
  if (pos > buf.length) return null;

  let frameCount = 0;
  let totalDurationMs = 0;
  let pendingDelayMs = 100;

  while (pos < buf.length && frameCount < MAX_GIF_FRAMES) {
    const blockId = buf[pos++];
    if (blockId === 0x3b) break; // Trailer
    if (blockId === 0x21) {
      if (pos >= buf.length) break;
      const label = buf[pos++];
      if (label === 0xf9 && pos + 5 <= buf.length && buf[pos] === 4) {
        const delayCs = buf.readUInt16LE(pos + 2);
        pendingDelayMs = delayCs > 0 ? delayCs * 10 : 100;
        pos += 6; // blockSize(1) + data(4) + terminator(1)
      } else {
        pos = skipSubBlocks(buf, pos);
      }
    } else if (blockId === 0x2c) {
      if (pos + 9 > buf.length) break;
      const imgPacked = buf[pos + 8];
      const lctFlag = (imgPacked & 0x80) !== 0;
      const lctSize = lctFlag ? 1 << ((imgPacked & 7) + 1) : 0;
      pos += 9 + lctSize * 3;
      if (pos >= buf.length) break;
      pos++; // LZW minCodeSize
      pos = skipSubBlocks(buf, pos);
      frameCount++;
      totalDurationMs += pendingDelayMs;
      pendingDelayMs = 100;
    } else {
      break;
    }
  }

  if (frameCount === 0) return null;
  return { width, height, frameCount, totalDurationMs };
}

/** 均匀挑选关键帧索引（始终包含首帧与尾帧） */
function pickKeyFrameIndices(totalFrames, maxKeyFrames = 9) {
  if (totalFrames <= 1) return [0];
  const count = Math.min(totalFrames, Math.max(2, maxKeyFrames));
  if (count === totalFrames) {
    return Array.from({ length: totalFrames }, (_, i) => i);
  }
  const indices = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.round((i * (totalFrames - 1)) / (count - 1));
    if (indices.length === 0 || indices[indices.length - 1] !== idx) {
      indices.push(idx);
    }
  }
  return indices;
}

/** 双线性缩放 RGBA 画布并合成到白色背景上，返回 RGB24 缓冲区 */
function resizeRgbaToRgbOnWhite(rgba, srcW, srcH, dstW, dstH) {
  const out = new Uint8Array(dstW * dstH * 3);
  if (srcW === dstW && srcH === dstH) {
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      const a = rgba[i + 3];
      if (a === 255) {
        out[j] = rgba[i];
        out[j + 1] = rgba[i + 1];
        out[j + 2] = rgba[i + 2];
      } else if (a === 0) {
        out[j] = 255;
        out[j + 1] = 255;
        out[j + 2] = 255;
      } else {
        const inv = 255 - a;
        out[j] = (rgba[i] * a + 255 * inv) / 255;
        out[j + 1] = (rgba[i + 1] * a + 255 * inv) / 255;
        out[j + 2] = (rgba[i + 2] * a + 255 * inv) / 255;
      }
    }
    return out;
  }

  const xScale = srcW / dstW;
  const yScale = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    const sy = (dy + 0.5) * yScale - 0.5;
    const y0 = Math.max(0, Math.min(srcH - 1, Math.floor(sy)));
    const y1 = Math.min(srcH - 1, y0 + 1);
    const fy = Math.max(0, sy - y0);
    const wy0 = 1 - fy;
    const wy1 = fy;

    for (let dx = 0; dx < dstW; dx++) {
      const sx = (dx + 0.5) * xScale - 0.5;
      const x0 = Math.max(0, Math.min(srcW - 1, Math.floor(sx)));
      const x1 = Math.min(srcW - 1, x0 + 1);
      const fx = Math.max(0, sx - x0);
      const wx0 = 1 - fx;
      const wx1 = fx;

      const i00 = (y0 * srcW + x0) * 4;
      const i10 = (y0 * srcW + x1) * 4;
      const i01 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;

      const w00 = wx0 * wy0;
      const w10 = wx1 * wy0;
      const w01 = wx0 * wy1;
      const w11 = wx1 * wy1;

      // 先将各采样点预合成为白底 RGB，再做双线性插值（避免透明边缘黑晕）
      const blend = (idx, ch) => {
        const a = rgba[idx + 3] / 255;
        return rgba[idx + ch] * a + 255 * (1 - a);
      };

      const dstIdx = (dy * dstW + dx) * 3;
      out[dstIdx] = Math.round(
        blend(i00, 0) * w00 + blend(i10, 0) * w10 + blend(i01, 0) * w01 + blend(i11, 0) * w11
      );
      out[dstIdx + 1] = Math.round(
        blend(i00, 1) * w00 + blend(i10, 1) * w10 + blend(i01, 1) * w01 + blend(i11, 1) * w11
      );
      out[dstIdx + 2] = Math.round(
        blend(i00, 2) * w00 + blend(i10, 2) * w10 + blend(i01, 2) * w01 + blend(i11, 2) * w11
      );
    }
  }
  return out;
}

// 3x5 极简点阵数字字模（用于分镜网格左上角标注帧序 1~9）
const DIGIT_FONT = {
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
};

/** 在分镜格左上角绘制半透明深色底 + 白色清晰序号角标 */
function drawFrameBadge(gridRgb, gridW, gridH, cellX, cellY, num) {
  const glyph = DIGIT_FONT[num];
  if (!glyph) return;
  const scale = 2;
  const padX = 4;
  const padY = 3;
  const badgeW = 3 * scale + padX * 2;
  const badgeH = 5 * scale + padY * 2;
  const bx0 = cellX + 4;
  const by0 = cellY + 4;

  // 半透明深色背景块（alpha ≈ 0.65）
  for (let y = 0; y < badgeH; y++) {
    const py = by0 + y;
    if (py < 0 || py >= gridH) continue;
    for (let x = 0; x < badgeW; x++) {
      const px = bx0 + x;
      if (px < 0 || px >= gridW) continue;
      const idx = (py * gridW + px) * 3;
      gridRgb[idx] = Math.round(gridRgb[idx] * 0.32 + 18 * 0.68);
      gridRgb[idx + 1] = Math.round(gridRgb[idx + 1] * 0.32 + 18 * 0.68);
      gridRgb[idx + 2] = Math.round(gridRgb[idx + 2] * 0.32 + 18 * 0.68);
    }
  }

  // 白色数字
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 3; col++) {
      if (glyph[row][col] !== '1') continue;
      for (let sy = 0; sy < scale; sy++) {
        const py = by0 + padY + row * scale + sy;
        if (py < 0 || py >= gridH) continue;
        for (let sx = 0; sx < scale; sx++) {
          const px = bx0 + padX + col * scale + sx;
          if (px < 0 || px >= gridW) continue;
          const idx = (py * gridW + px) * 3;
          gridRgb[idx] = 255;
          gridRgb[idx + 1] = 255;
          gridRgb[idx + 2] = 255;
        }
      }
    }
  }
}

/**
 * 将 GIF Buffer 解码并渲染为标准 PNG（单帧直出 PNG，多帧渲染为带序号的关键帧分镜图）
 */
export function convertGifToStoryboardPng(buf, { maxKeyFrames = 9 } = {}) {
  const meta = scanGifMetadata(buf);
  if (!meta) return { ok: false, error: '无效或超限的 GIF 文件' };

  const { width, height, frameCount, totalDurationMs } = meta;
  const selectedIndices = pickKeyFrameIndices(frameCount, maxKeyFrames);
  const selectedSet = new Set(selectedIndices);
  const lastNeededIdx = selectedIndices[selectedIndices.length - 1];

  // 计算目标单格尺寸
  const isAnimated = selectedIndices.length > 1;
  let cols = 1;
  let rows = 1;
  if (selectedIndices.length === 2) {
    cols = 2;
    rows = 1;
  } else if (selectedIndices.length === 3) {
    cols = 3;
    rows = 1;
  } else if (selectedIndices.length === 4) {
    cols = 2;
    rows = 2;
  } else if (selectedIndices.length <= 6) {
    cols = 3;
    rows = 2;
  } else if (selectedIndices.length > 6) {
    cols = 3;
    rows = 3;
  }

  const maxCellDim = !isAnimated ? 1024 : cols === 2 ? 384 : 300;
  const scale = Math.min(1, maxCellDim / Math.max(width, height));
  const cellW = Math.max(1, Math.round(width * scale));
  const cellH = Math.max(1, Math.round(height * scale));

  // Pass 2：按帧合成并仅在命中的关键帧处采集缩略 RGB
  const packed = buf[10];
  const gctFlag = (packed & 0x80) !== 0;
  const gctSize = gctFlag ? 1 << ((packed & 7) + 1) : 0;
  const gctStart = 13;
  const gct = gctFlag ? buf.subarray(gctStart, gctStart + gctSize * 3) : null;
  let pos = gctStart + gctSize * 3;

  const canvas = new Uint8Array(width * height * 4); // 默认全透明 (0,0,0,0)
  let prevCanvas = null;
  let disposal = 0;
  let hasTrans = false;
  let transIndex = -1;
  let frameIdx = 0;
  const sampledCells = [];

  while (pos < buf.length && frameIdx <= lastNeededIdx) {
    const blockId = buf[pos++];
    if (blockId === 0x3b) break;
    if (blockId === 0x21) {
      if (pos >= buf.length) break;
      const label = buf[pos++];
      if (label === 0xf9 && pos + 5 <= buf.length && buf[pos] === 4) {
        const gcePacked = buf[pos + 1];
        disposal = (gcePacked >> 2) & 7;
        hasTrans = (gcePacked & 1) !== 0;
        transIndex = buf[pos + 4];
        pos += 6;
      } else {
        pos = skipSubBlocks(buf, pos);
      }
    } else if (blockId === 0x2c) {
      if (pos + 9 > buf.length) break;
      const left = buf.readUInt16LE(pos);
      const top = buf.readUInt16LE(pos + 2);
      const fw = buf.readUInt16LE(pos + 4);
      const fh = buf.readUInt16LE(pos + 6);
      const imgPacked = buf[pos + 8];
      const lctFlag = (imgPacked & 0x80) !== 0;
      const interlaced = (imgPacked & 0x40) !== 0;
      const lctSize = lctFlag ? 1 << ((imgPacked & 7) + 1) : 0;
      pos += 9;

      const palette = lctFlag ? buf.subarray(pos, pos + lctSize * 3) : gct;
      pos += lctSize * 3;
      if (pos >= buf.length) break;

      const minCodeSize = buf[pos++];
      const { data: lzwData, nextPos } = readSubBlocks(buf, pos);
      pos = nextPos;

      if (disposal === 3) {
        if (!prevCanvas) prevCanvas = new Uint8Array(canvas.length);
        prevCanvas.set(canvas);
      }

      if (palette && fw > 0 && fh > 0 && minCodeSize >= 2 && minCodeSize <= 8) {
        const rawPixels = decodeLzw(minCodeSize, lzwData, fw * fh);
        const pixels = interlaced ? deinterlace(rawPixels, fw, fh) : rawPixels;
        const maxColorIdx = Math.floor(palette.length / 3);

        for (let py = 0; py < fh; py++) {
          const cy = top + py;
          if (cy < 0 || cy >= height) continue;
          const rowOff = py * fw;
          const canvasRowOff = cy * width;
          for (let px = 0; px < fw; px++) {
            const cx = left + px;
            if (cx < 0 || cx >= width) continue;
            const colorIdx = pixels[rowOff + px];
            if (hasTrans && colorIdx === transIndex) continue;
            if (colorIdx >= maxColorIdx) continue;
            const cOff = (canvasRowOff + cx) * 4;
            const pOff = colorIdx * 3;
            canvas[cOff] = palette[pOff];
            canvas[cOff + 1] = palette[pOff + 1];
            canvas[cOff + 2] = palette[pOff + 2];
            canvas[cOff + 3] = 255;
          }
        }
      }

      if (selectedSet.has(frameIdx)) {
        sampledCells.push(resizeRgbaToRgbOnWhite(canvas, width, height, cellW, cellH));
      }

      // 执行当前帧的 disposal 清理逻辑（为下一帧准备画布）
      if (disposal === 2) {
        for (let py = 0; py < fh; py++) {
          const cy = top + py;
          if (cy < 0 || cy >= height) continue;
          const canvasRowOff = cy * width;
          for (let px = 0; px < fw; px++) {
            const cx = left + px;
            if (cx < 0 || cx >= width) continue;
            const cOff = (canvasRowOff + cx) * 4;
            canvas[cOff] = 0;
            canvas[cOff + 1] = 0;
            canvas[cOff + 2] = 0;
            canvas[cOff + 3] = 0;
          }
        }
      } else if (disposal === 3 && prevCanvas) {
        canvas.set(prevCanvas);
      }

      // 每帧消费完重置 GCE 状态
      disposal = 0;
      hasTrans = false;
      transIndex = -1;
      frameIdx++;
    } else {
      break;
    }
  }

  if (sampledCells.length === 0) {
    return { ok: false, error: '未能从 GIF 中解码出有效帧' };
  }

  let pngBuf;
  let outW;
  let outH;
  if (!isAnimated || sampledCells.length === 1) {
    outW = cellW;
    outH = cellH;
    pngBuf = encodeRgbToPng(sampledCells[0], outW, outH);
  } else {
    const gap = 3;
    outW = cols * cellW + (cols - 1) * gap;
    outH = rows * cellH + (rows - 1) * gap;
    const gridRgb = new Uint8Array(outW * outH * 3);
    // 分隔线与空余格填充柔和浅灰 (#DCDFE6)
    for (let i = 0; i < gridRgb.length; i += 3) {
      gridRgb[i] = 220;
      gridRgb[i + 1] = 223;
      gridRgb[i + 2] = 230;
    }

    for (let idx = 0; idx < sampledCells.length; idx++) {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const ox = col * (cellW + gap);
      const oy = row * (cellH + gap);
      const cell = sampledCells[idx];
      for (let y = 0; y < cellH; y++) {
        const srcOff = y * cellW * 3;
        const dstOff = ((oy + y) * outW + ox) * 3;
        gridRgb.set(cell.subarray(srcOff, srcOff + cellW * 3), dstOff);
      }
      drawFrameBadge(gridRgb, outW, outH, ox, oy, idx + 1);
    }

    pngBuf = encodeRgbToPng(gridRgb, outW, outH);
  }

  return {
    ok: true,
    data: pngBuf.toString('base64'),
    mimeType: 'image/png',
    isAnimated: sampledCells.length > 1,
    totalFrames: frameCount,
    sampledFrames: sampledCells.length,
    durationMs: totalDurationMs,
    width: outW,
    height: outH,
    cols,
    rows,
  };
}

/**
 * 批量预处理待送给大模型的图片列表：
 *   - 非 GIF 图片原样保留（顺手按魔数纠正错误 MIME）；
 *   - GIF 图片自动转为单帧 PNG 或带帧序号的分镜拼图 PNG，并附带清晰说明供模型理解动图动作。
 */
export function normalizeImagesForLlm(images = [], { maxKeyFrames = 9 } = {}) {
  if (!Array.isArray(images) || images.length === 0) {
    return { images: [], gifNotes: [] };
  }
  const normalized = [];
  const gifNotes = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img?.data) continue;
    const buf = Buffer.from(img.data, 'base64');
    if (buf.length === 0) continue;

    const detectedMime = detectImageMime(buf, img.mimeType || 'image/jpeg') || 'image/jpeg';
    if (detectedMime === 'image/gif' || isGifBuffer(buf)) {
      try {
        const converted = convertGifToStoryboardPng(buf, { maxKeyFrames });
        if (converted.ok) {
          normalized.push({
            ...img,
            data: converted.data,
            mimeType: 'image/png',
            wasGif: true,
            gifMeta: {
              isAnimated: converted.isAnimated,
              totalFrames: converted.totalFrames,
              sampledFrames: converted.sampledFrames,
              durationMs: converted.durationMs,
            },
          });
          if (converted.isAnimated) {
            const sec = (converted.durationMs / 1000).toFixed(1);
            gifNotes.push(
              `第 ${normalized.length} 张图是动态 GIF 动图（共 ${converted.totalFrames} 帧、约 ${sec} 秒），已按时间顺序从左到右、从上到下提取 ${converted.sampledFrames} 帧分镜拼图（每格左上角标有帧序 1~${converted.sampledFrames}），请将其当作一段连续动图/表情包理解。`
            );
          } else {
            gifNotes.push(`第 ${normalized.length} 张图原为静态 GIF，已转为 PNG 展示。`);
          }
          continue;
        }
      } catch {
        // 畸形 GIF 解码失败时静默降级，不阻塞正常聊天
      }
    }

    normalized.push({
      ...img,
      mimeType: detectedMime,
    });
  }

  return { images: normalized, gifNotes };
}
