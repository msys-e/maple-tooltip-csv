// 開発テスト用の最小PNGデコーダ/BMPエンコーダ (Node専用、本体からは未参照)
// 対応: 8bit RGB/RGBA 非インターレース
import { inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';

export function decodePNG(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let pos = 8;
  let w = 0, h = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      const bd = data[8];
      colorType = data[9];
      if (bd !== 8 || (colorType !== 2 && colorType !== 6) || data[12] !== 0) {
        throw new Error(`unsupported png: bd=${bd} ct=${colorType}`);
      }
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = new Uint8ClampedArray(w * h * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const rb = raw[rp + x];
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v;
      switch (filter) {
        case 0: v = rb; break;
        case 1: v = rb + a; break;
        case 2: v = rb + b; break;
        case 3: v = rb + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = rb + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error('bad filter');
      }
      cur[x] = v & 0xff;
    }
    rp += stride;
    for (let x = 0; x < w; x++) {
      const s = x * bpp, d = (y * w + x) * 4;
      out[d] = cur[s];
      out[d + 1] = cur[s + 1];
      out[d + 2] = cur[s + 2];
      out[d + 3] = bpp === 4 ? cur[s + 3] : 255;
    }
    prev.set(cur);
  }
  return { width: w, height: h, data: out };
}

// デバッグ可視化用BMP書き出し (24bit)
export function writeBMP(path, img) {
  const { width: w, height: h, data } = img;
  const rowSize = Math.ceil(w * 3 / 4) * 4;
  const size = 54 + rowSize * h;
  const b = Buffer.alloc(size);
  b.write('BM');
  b.writeUInt32LE(size, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(w, 18);
  b.writeInt32LE(-h, 22); // top-down
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = 54 + y * rowSize + x * 3;
      b[d] = data[s + 2];
      b[d + 1] = data[s + 1];
      b[d + 2] = data[s];
    }
  }
  writeFileSync(path, b);
}
