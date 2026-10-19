import sharp from "sharp";
import { abortable, checkSignal, ImageError } from "./errors.ts";
import { LIMITS } from "./options.ts";

export interface NormalizedImage {
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
  readonly transparent: boolean;
}

/** Decode, validate and strip metadata; never trust a filename or a provider's dimensions. */
export async function normalizeImage(bytes: Buffer, reference = false, signal: AbortSignal = new AbortController().signal): Promise<NormalizedImage> {
  checkSignal(signal);
  const byteLimit = reference ? LIMITS.referenceBytes : LIMITS.imageBytes;
  if (!bytes.length || bytes.length > byteLimit) throw new ImageError("Image exceeds the permitted byte limit.");
  try {
    const image = sharp(bytes, { limitInputPixels: LIMITS.pixels, failOn: "warning", animated: false });
    // Stop waiting on cancellation; Sharp's native codec work may still finish.
    const metadata = await abortable(image.metadata(), signal);
    checkSignal(signal);
    if (!(reference ? ["png", "jpeg", "webp"] : ["png"]).includes(metadata.format ?? "")
      || (metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height
      || metadata.width * metadata.height > LIMITS.pixels)
      throw new ImageError(reference ? "Reference must be a single PNG, JPEG or WebP image within the 16 megapixel limit."
        : "Provider did not return a single PNG image within the 16 megapixel limit.");
    const { data: png, info } = await abortable(image.rotate().toColourspace("srgb").png().toBuffer({ resolveWithObject: true }), signal);
    checkSignal(signal);
    if (png.length > byteLimit) throw new ImageError("Decoded image exceeds the permitted byte limit.");
    const transparent = !(await abortable(sharp(png, { limitInputPixels: LIMITS.pixels, failOn: "warning" }).stats(), signal)).isOpaque;
    checkSignal(signal);
    return { png, width: info.width, height: info.height, transparent };
  } catch (error) {
    if (error instanceof ImageError) throw error;
    throw new ImageError("Image could not be safely decoded; expected a complete, bounded PNG, JPEG or WebP image.");
  }
}
