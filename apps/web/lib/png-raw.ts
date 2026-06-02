// png-raw.ts — Decodificador/codificador PNG mínimo en Node, SIN dependencias.
//
// Por qué: el ffmpeg recortado de Remotion no trae muxer rawvideo ni filtro chromakey,
// y el proyecto no tiene sharp/jimp. Para procesar frames por píxel en Node (motion-map,
// cutout de video) extraemos/escribimos PNG (muxer image2, que SÍ funciona) y los
// decodificamos/codificamos a mano con zlib. Solo el caso que produce/consume ffmpeg:
// 8-bit, colorType 2 (RGB) o 6 (RGBA), sin interlace.

import { deflateSync, inflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface DecodedPng {
  w: number;
  h: number;
  /** bytes por píxel: 3 (RGB) o 4 (RGBA). */
  bpp: number;
  /** píxeles crudos (w*h*bpp), sin filtrar. */
  px: Buffer;
}

/** Decodifica un PNG simple (8-bit, colorType 2/6, sin interlace). */
export function decodePng(buf: Buffer): DecodedPng {
  let pos = 8; // saltar firma
  let w = 0;
  let h = 0;
  let colorType = 2;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      colorType = data[9]!;
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = w * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[rp++]!;
    for (let x = 0; x < stride; x++) {
      const cur = raw[rp++]!;
      const a = x >= bpp ? px[y * stride + x - bpp]! : 0;
      const b = y > 0 ? px[(y - 1) * stride + x]! : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp]! : 0;
      let val: number;
      switch (ft) {
        case 1:
          val = cur + a;
          break;
        case 2:
          val = cur + b;
          break;
        case 3:
          val = cur + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          val = cur + pr;
          break;
        }
        default:
          val = cur;
      }
      px[y * stride + x] = val & 0xff;
    }
  }
  return { w, h, bpp, px };
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** Codifica píxeles RGBA (w*h*4) a un PNG (colorType 6, filtro 0 None). */
export function encodePngRGBA(w: number, h: number, rgba: Buffer): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colorType RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filtro None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
