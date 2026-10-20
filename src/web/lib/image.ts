/** Read an image file, shrink it to fit `max` px and return a PNG data URL (keeps logos and QR codes sharp). */
export async function imageToDataUrl(file: File, max: number): Promise<string> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error("Choose a PNG, JPG or WebP image");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("That file is not a readable image"));
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = scale < 1;
    ctx.drawImage(img, 0, 0, w, h);
    const out = canvas.toDataURL("image/png");
    if (out.length > 400_000) return canvas.toDataURL("image/jpeg", 0.85);
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}
