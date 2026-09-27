/** Largest receipt accepted (the API itself allows 32 MB per request). */
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

export type ReceiptMediaType =
  | 'application/pdf'
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp';

/**
 * What a receipt file really is, judged by its first bytes rather than by the
 * name or the type the browser claimed. Returns null for anything the reader
 * cannot take (including HEIC photos, which must be converted first).
 * @param {Buffer} buffer
 * @returns {ReceiptMediaType | null}
 */
export const sniffReceiptMediaType = (
  buffer: Buffer,
): ReceiptMediaType | null => {
  if (!buffer || buffer.length < 12) return null;

  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
    return 'application/pdf';
  }
  if (
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  const head = buffer.subarray(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') {
    return 'image/gif';
  }
  if (
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
};
