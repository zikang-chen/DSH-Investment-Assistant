/**
 * 极简 GIF 编码器（无第三方依赖）：PNG → 固定调色板 → LZW。
 * 仅用于把 Chrome 的截图序列拼成 README 演示 GIF。
 */
import { inflateSync } from 'node:zlib'

export function readPNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let off = 8
  let width = 0, height = 0, depth = 0, colorType = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      depth = data[8]; colorType = data[9]
      if (depth !== 8 || (colorType !== 6 && colorType !== 2)) throw new Error(`unsupported PNG depth/colorType ${depth}/${colorType}`)
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  const channels = colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(width * height * 4)
  const prev = Buffer.alloc(stride)
  const line = Buffer.alloc(stride)
  let p = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]
    raw.copy(line, 0, p, p + stride); p += stride
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      line[x] = v & 0xff
    }
    line.copy(prev)
    for (let x = 0, q = y * width * 4; x < width; x++) {
      out[q++] = line[x * channels]
      out[q++] = line[x * channels + 1]
      out[q++] = line[x * channels + 2]
      out[q++] = channels === 4 ? line[x * channels + 3] : 255
    }
  }
  return { width, height, rgba: out }
}

/** 6×6×6 色立方 + 40 级灰阶：扁平 UI 上够用，且能压缩得动。 */
export function buildPalette() {
  const palette = []
  const levels = [0, 51, 102, 153, 204, 255]
  for (const r of levels) for (const g of levels) for (const b of levels) palette.push([r, g, b])
  for (let i = 0; i < 40; i++) { const v = Math.round((i * 255) / 39); palette.push([v, v, v]) }
  return palette
}

export function quantize(rgba, palette) {
  const idx = new Uint8Array(rgba.length / 4)
  const cache = new Map()
  const nearest = (r, g, b) => {
    const key = (r << 16) | (g << 8) | b
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    let best = 0, bestD = Infinity
    for (let i = 0; i < palette.length; i++) {
      const [pr, pg, pb] = palette[i]
      const d = (pr - r) ** 2 * 0.3 + (pg - g) ** 2 * 0.59 + (pb - b) ** 2 * 0.11
      if (d < bestD) { bestD = d; best = i; if (d === 0) break }
    }
    cache.set(key, best)
    return best
  }
  for (let i = 0, j = 0; i < idx.length; i++, j += 4) idx[i] = nearest(rgba[j], rgba[j + 1], rgba[j + 2])
  return idx
}

function lzw(indices, minCodeSize) {
  const clear = 1 << minCodeSize, end = clear + 1
  let codeSize = minCodeSize + 1, next = end + 1
  let dict = new Map()
  const bytes = []
  let cur = 0, curBits = 0
  const emit = (code) => {
    cur |= code << curBits; curBits += codeSize
    while (curBits >= 8) { bytes.push(cur & 0xff); cur >>= 8; curBits -= 8 }
  }
  emit(clear)
  let prefix = indices[0]
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]
    const key = prefix * 4096 + k
    const hit = dict.get(key)
    if (hit !== undefined) { prefix = hit; continue }
    emit(prefix)
    dict.set(key, next++)
    if (next > (1 << codeSize) && codeSize < 12) codeSize++
    if (next >= 4096) { emit(clear); dict = new Map(); codeSize = minCodeSize + 1; next = end + 1 }
    prefix = k
  }
  emit(prefix)
  emit(end)
  if (curBits > 0) bytes.push(cur & 0xff)
  return bytes
}

function subBlocks(bytes) {
  const out = []
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255)
    out.push(chunk.length, ...chunk)
  }
  out.push(0)
  return out
}

/** frames: Array<{width,height,indices}>，delayCs 为 1/100 秒。 */
export function encodeGIF(frames, palette, delayCs = 40) {
  const width = frames[0].width, height = frames[0].height
  const out = []
  const push = (...b) => out.push(...b)
  const u16 = (v) => push(v & 0xff, (v >> 8) & 0xff)
  push(...Buffer.from('GIF89a', 'ascii'))
  u16(width); u16(height)
  push(0xf7, 0, 0) // GCT 256 色
  for (let i = 0; i < 256; i++) { const c = palette[i] ?? [0, 0, 0]; push(c[0], c[1], c[2]) }
  push(0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'ascii'), 0x03, 0x01, 0x00, 0x00, 0x00)
  for (const frame of frames) {
    push(0x21, 0xf9, 0x04, 0x04, ...Buffer.from([delayCs & 0xff, (delayCs >> 8) & 0xff]), 0x00, 0x00)
    push(0x2c); u16(0); u16(0); u16(frame.width); u16(frame.height); push(0x00)
    push(0x08)
    push(...subBlocks(lzw(frame.indices, 8)))
  }
  push(0x3b)
  return Buffer.from(out)
}
