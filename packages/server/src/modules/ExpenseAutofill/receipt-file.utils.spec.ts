import { sniffReceiptMediaType } from './receipt-file.utils';

const pad = (bytes: number[]) =>
  Buffer.concat([Buffer.from(bytes), Buffer.alloc(32)]);

describe('sniffReceiptMediaType', () => {
  it('recognises a PDF', () => {
    expect(sniffReceiptMediaType(Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj'))).toBe(
      'application/pdf',
    );
  });

  it('recognises a PNG', () => {
    expect(
      sniffReceiptMediaType(
        pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe('image/png');
  });

  it('recognises a JPEG', () => {
    expect(sniffReceiptMediaType(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      'image/jpeg',
    );
  });

  it('recognises GIF and WebP', () => {
    expect(sniffReceiptMediaType(Buffer.from('GIF89a' + '\0'.repeat(20)))).toBe(
      'image/gif',
    );
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([1, 2, 3, 4]),
      Buffer.from('WEBP'),
      Buffer.alloc(16),
    ]);
    expect(sniffReceiptMediaType(webp)).toBe('image/webp');
  });

  it('refuses HEIC photos, which the reader cannot take', () => {
    const heic = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypheic'),
      Buffer.alloc(24),
    ]);
    expect(sniffReceiptMediaType(heic)).toBeNull();
  });

  it('judges by content, not by what the file claims to be', () => {
    // A script or text file renamed to receipt.pdf is still not a PDF.
    expect(
      sniffReceiptMediaType(Buffer.from('<script>alert(1)</script>........')),
    ).toBeNull();
    expect(
      sniffReceiptMediaType(Buffer.from('just some text, not a pdf')),
    ).toBeNull();
  });

  it('refuses empty and tiny buffers', () => {
    expect(sniffReceiptMediaType(Buffer.alloc(0))).toBeNull();
    expect(sniffReceiptMediaType(Buffer.from('%PDF-'))).toBeNull();
  });
});
