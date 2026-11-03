/**
 * 聊天图片的显示框 (M-L3)。
 *
 * M-C2 起图片只靠 `max-width: 150px; max-height: 220px` 等比缩。普通照片没问题，两头会坏：
 * 一张长截图（1080×9000）缩成 26×220 的一条缝，一张全景（4000×500）缩成 150×19 的一道线，
 * 一张 40×40 的小图就画成 40×40 的一个点。微信的做法是：框的长宽比有上下限，超出的部分
 * 裁掉（长图从顶上看起——截图的要紧处在上面；宽图取中间），太小的图放大到一个最小边。
 *
 * 普通比例（宽高比 0.4 … 2.5）的照片仍落在原来的 150×220 信封里，尺寸与此前一致（只差
 * 取整的半个像素），所以老消息不会忽然变样。
 *
 * 纯函数：输入原图的像素宽高，输出 CSS 像素的框与裁切锚点。
 */

/** The envelope M-C2 shipped with — unchanged. */
export const IMG_MAX_W = 150;
export const IMG_MAX_H = 220;
/** A picture is never drawn with a side shorter than this (tiny images scale up). */
export const IMG_MIN_SIDE = 60;
/** Width / height limits of the BOX. A picture beyond them is cropped, not squeezed. */
export const IMG_RATIO_MIN = 0.4;
export const IMG_RATIO_MAX = 2.5;

export interface ImageBox {
  width: number;
  height: number;
  /** Where the crop keeps the picture: long screenshots from the top, the rest centred. */
  anchor: 'top' | 'center';
}

export function imageBox(naturalW: number, naturalH: number): ImageBox | null {
  if (!(naturalW > 0 && naturalH > 0) || !Number.isFinite(naturalW) || !Number.isFinite(naturalH)) return null;
  const ratio = naturalW / naturalH;
  const tall = ratio < IMG_RATIO_MIN;
  // The part of the picture the box will show, in source pixels.
  const vw = ratio > IMG_RATIO_MAX ? naturalH * IMG_RATIO_MAX : naturalW;
  const vh = tall ? naturalW / IMG_RATIO_MIN : naturalH;
  // Shrink into the envelope; never enlarge here (that is the min-side step's job).
  let s = Math.min(1, IMG_MAX_W / vw, IMG_MAX_H / vh);
  let w = vw * s;
  let h = vh * s;
  // Scale tiny pictures up to the minimum side. The ratio clamp guarantees the
  // other side still fits the envelope: 60 / 0.4 = 150 ≤ 220, 60 × 2.5 = 150 ≤ 150.
  const short = Math.min(w, h);
  if (short < IMG_MIN_SIDE) {
    s = IMG_MIN_SIDE / short;
    w *= s;
    h *= s;
  }
  return { width: Math.round(w), height: Math.round(h), anchor: tall ? 'top' : 'center' };
}

/** `meta.w` / `meta.h` as stored on an image message at send time, if present and sane. */
export function storedImageSize(meta: Record<string, unknown> | undefined): { w: number; h: number } | null {
  const w = meta?.w;
  const h = meta?.h;
  return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 ? { w, h } : null;
}

/**
 * The decoded size of a picture the user is about to send, or null when the
 * WebView cannot decode it (the box then comes from the <img> once it loads).
 * Through an <img> on purpose: it applies EXIF orientation exactly as the
 * bubble's own <img> will, so a portrait phone photo is measured portrait.
 */
export async function measureImage(url: string): Promise<{ w: number; h: number } | null> {
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img.naturalWidth > 0 && img.naturalHeight > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null;
  } catch {
    return null;
  }
}
