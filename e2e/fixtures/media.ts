/**
 * Media a journey can send. The photo is a real PNG the browser can decode — `ConversationScreen`
 * draws an attached image into an `Image` to learn its size before uploading, so a stand-in that
 * merely has the right extension would be refused on the way in — and small enough not to slow a
 * run. Playwright hands it to a file chooser as `{ name, mimeType, buffer }`.
 */
import { deflateSync } from 'node:zlib'

export interface FilePayload {
  readonly name: string
  readonly mimeType: string
  readonly buffer: Buffer
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const COLOR_TYPE_RGB = 2
const BIT_DEPTH = 8

const CRC_TABLE: readonly number[] = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** One PNG chunk: length, type, data, and the CRC over type + data. */
function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0)
  return Buffer.concat([length, typeBytes, data, crc])
}

/** A `width` × `height` PNG of one colour, as a file chooser payload. */
export function pngFile(
  width: number,
  height: number,
  rgb: readonly [number, number, number],
  name = 'photo.png',
): FilePayload {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = BIT_DEPTH
  header[9] = COLOR_TYPE_RGB
  // compression method, filter method, interlace: the only values PNG defines
  header[10] = 0
  header[11] = 0
  header[12] = 0

  // Each scanline starts with its filter byte (0 = none) and then its RGB triples.
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = rgb[0]
    row[2 + x * 3] = rgb[1]
    row[3 + x * 3] = rgb[2]
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row))

  return {
    name,
    mimeType: 'image/png',
    buffer: Buffer.concat([
      PNG_SIGNATURE,
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  }
}
