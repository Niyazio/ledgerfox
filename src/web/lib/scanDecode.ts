/**
 * Barcode/QR reading without the browser's BarcodeDetector (which is missing on iPhones, Firefox and any page opened
 * over plain http, such as a phone using the office PC's network link). Uses ZXing (Apache-2.0), loaded only when a
 * scan starts.
 */
type ZX = typeof import("@zxing/library");
let zx: Promise<ZX> | null = null;
const lib = () => (zx ??= import("@zxing/library"));

/** Decode RGBA pixels (as from canvas getImageData). Returns the text, or null when no code is found. */
export async function decodePixels(rgba: Uint8ClampedArray, width: number, height: number): Promise<string | null> {
  const z = await lib();
  const lum = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) lum[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
  const reader = new z.MultiFormatReader();
  const formats = [z.BarcodeFormat.QR_CODE, z.BarcodeFormat.CODE_128, z.BarcodeFormat.EAN_13, z.BarcodeFormat.EAN_8, z.BarcodeFormat.UPC_A, z.BarcodeFormat.UPC_E, z.BarcodeFormat.CODE_39];
  reader.setHints(new Map<number, unknown>([[z.DecodeHintType.POSSIBLE_FORMATS, formats], [z.DecodeHintType.TRY_HARDER, true]]) as never);
  const source = new z.RGBLuminanceSource(lum, width, height);
  for (const bitmap of [new z.BinaryBitmap(new z.HybridBinarizer(source)), new z.BinaryBitmap(new z.GlobalHistogramBinarizer(source))]) {
    try { return reader.decode(bitmap).getText(); } catch { /* try the next binarizer */ }
  }
  return null;
}

function pixelsAt(img: CanvasImageSource, w: number, h: number, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, cw, ch);
  return { data: ctx.getImageData(0, 0, cw, ch).data, width: cw, height: ch };
}

/** A photo from the phone camera: tried at a few sizes (small codes in big photos need more pixels). */
export async function decodeImageFile(file: Blob): Promise<string | null> {
  const bmp = await createImageBitmap(file);
  try {
    for (const side of [1280, 2000, 800]) {
      const p = pixelsAt(bmp, bmp.width, bmp.height, side);
      const text = await decodePixels(p.data, p.width, p.height);
      if (text) return text;
    }
    return null;
  } finally { bmp.close(); }
}

/** One frame of a live camera video. */
export async function decodeVideoFrame(video: HTMLVideoElement): Promise<string | null> {
  if (!video.videoWidth) return null;
  const p = pixelsAt(video, video.videoWidth, video.videoHeight, 960);
  return decodePixels(p.data, p.width, p.height);
}
