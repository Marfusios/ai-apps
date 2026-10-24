/**
 * A small ICO encoder for favicon.ico (scripts/build-brand-assets.ts): PNG images stored as they
 * are, which every current browser and Windows since Vista read.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const HEADER_BYTES = 6;
const ENTRY_BYTES = 16;

/** A PNG's width and height, read from its IHDR chunk, which every PNG starts with. */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  const isPng =
    png.length >= 24 &&
    PNG_SIGNATURE.every((byte, i) => png[i] === byte) &&
    String.fromCharCode(...png.subarray(12, 16)) === 'IHDR';
  if (!isPng) throw new Error('not a PNG image');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * An ICO file of the given PNG images, each at most 256 px square, in the order given: the
 * header (reserved 0, type 1 for an icon, the number of images), one 16-byte directory entry per
 * image (width and height, where 0 means 256; no palette; one colour plane; 32 bits per pixel;
 * the image's length and its offset in the file), then the images. All numbers little-endian.
 */
export function encodeIco(pngs: readonly Uint8Array[]): Uint8Array {
  const total = pngs.reduce((sum, png) => sum + png.length, HEADER_BYTES + ENTRY_BYTES * pngs.length);
  const ico = new Uint8Array(total);
  const view = new DataView(ico.buffer);
  view.setUint16(0, 0, true);
  view.setUint16(2, 1, true);
  view.setUint16(4, pngs.length, true);
  let offset = HEADER_BYTES + ENTRY_BYTES * pngs.length;
  pngs.forEach((png, i) => {
    const { width, height } = pngSize(png);
    if (width > 256 || height > 256) throw new Error(`an ICO image is at most 256 px square, not ${width}×${height}`);
    const entry = HEADER_BYTES + ENTRY_BYTES * i;
    view.setUint8(entry, width % 256);
    view.setUint8(entry + 1, height % 256);
    view.setUint8(entry + 2, 0);
    view.setUint8(entry + 3, 0);
    view.setUint16(entry + 4, 1, true);
    view.setUint16(entry + 6, 32, true);
    view.setUint32(entry + 8, png.length, true);
    view.setUint32(entry + 12, offset, true);
    ico.set(png, offset);
    offset += png.length;
  });
  return ico;
}
