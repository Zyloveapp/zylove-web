// Stage B (F-052): profile photos lose their metadata on the server too, not
// only in the browser — EXIF can carry the exact GPS spot a photo was taken
// (often home). JPEG only (the app uploads nothing else): the APPn segments
// other than JFIF (APP0) and colour profiles (APP2 ICC_PROFILE), and
// comments, are dropped; the image data is untouched.

export const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff

// The JPEG without its metadata segments, or null if it isn't a well-formed JPEG.
export function stripJpegMetadata(b: Buffer): Buffer | null {
  if (!isJpeg(b)) return null
  const out: Buffer[] = [b.subarray(0, 2)]
  let i = 2
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]
    if (marker === 0xff) {
      i++ // fill byte
      continue
    }
    if (marker === 0xda) {
      // Start of scan: the rest is image data.
      out.push(b.subarray(i))
      return Buffer.concat(out)
    }
    // Markers without a length.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(b.subarray(i, i + 2))
      i += 2
      continue
    }
    const len = b.readUInt16BE(i + 2)
    if (len < 2 || i + 2 + len > b.length) return null
    const seg = b.subarray(i, i + 2 + len)
    const isApp = marker >= 0xe0 && marker <= 0xef
    const keep =
      (!isApp && marker !== 0xfe) ||
      marker === 0xe0 ||
      (marker === 0xe2 && seg.subarray(4, 15).toString('latin1') === 'ICC_PROFILE')
    if (keep) out.push(seg)
    i += 2 + len
  }
  return null
}

export const isPng = (b: Buffer) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

// PNG: only the chunks that draw the image (eXIf, text chunks and the rest
// dropped), or null if malformed.
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs'])
export function stripPngMetadata(b: Buffer): Buffer | null {
  if (!isPng(b)) return null
  const out: Buffer[] = [b.subarray(0, 8)]
  let i = 8
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i)
    const type = b.subarray(i + 4, i + 8).toString('latin1')
    const end = i + 12 + len
    if (end > b.length) return null
    if (PNG_KEEP.has(type)) out.push(b.subarray(i, end))
    i = end
    if (type === 'IEND') return Buffer.concat(out)
  }
  return null
}

// The photo without metadata (with its content type), or null when it's
// neither a well-formed JPEG nor PNG — such a file isn't published.
export function stripPhotoMetadata(b: Buffer): { bytes: Buffer; contentType: string } | null {
  const jpeg = stripJpegMetadata(b)
  if (jpeg) return { bytes: jpeg, contentType: 'image/jpeg' }
  const png = stripPngMetadata(b)
  return png ? { bytes: png, contentType: 'image/png' } : null
}
