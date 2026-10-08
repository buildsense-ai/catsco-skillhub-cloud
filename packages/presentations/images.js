import { ValidationError } from "../domain/index.js";

export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_REQUEST_MAX_BYTES = 3 * 1024 * 1024;
export const IMAGE_MAX_DIMENSION = 4096;
export const IMAGE_MAX_PIXELS = 16_000_000;

function invalid() {
  return new ValidationError("Use a complete, static PNG, JPEG or WebP image, at most 2 MiB, 4096 pixels per side and 16 megapixels.", "presentation.image_invalid", 400);
}

// Never fetch a URL or trust an extension/MIME supplied by the client. Re-encode
// pixels, discarding EXIF (including GPS), comments, profiles and trailing data.
export async function normalizePresentationImage(base64) {
  if (typeof base64 !== "string" || !base64.length || base64.length > Math.ceil(IMAGE_MAX_BYTES / 3) * 4
      || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw invalid();
  const input = Buffer.from(base64, "base64");
  if (input.length > IMAGE_MAX_BYTES || input.toString("base64") !== base64) throw invalid();
  const png = input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = input[0] === 255 && input[1] === 216 && input[2] === 255;
  const webp = input.subarray(0, 4).toString() === "RIFF" && input.subarray(8, 12).toString() === "WEBP";
  if (!png && !jpeg && !webp) throw invalid();
  // Some PNG decoders expose only APNG's default frame, without `pages`.
  // Walk bounded chunk headers so animated PNG cannot silently lose frames.
  if (png) {
    let offset = 8;
    while (offset + 12 <= input.length) {
      const length = input.readUInt32BE(offset);
      const type = input.toString("ascii", offset + 4, offset + 8);
      if (length > input.length - offset - 12 || type === "acTL") throw invalid();
      offset += length + 12;
      if (type === "IEND") break;
    }
  }
  // Lazy load: a missing native codec must not prevent the legacy API starting.
  let sharp;
  try { ({ default: sharp } = await import("sharp")); } catch {
    throw new ValidationError("Image processing is unavailable.", "presentation.image_processor_unavailable", 503);
  }
  try {
    const options = { limitInputPixels: IMAGE_MAX_PIXELS, failOn: "warning" };
    const metadata = await sharp(input, options).metadata();
    if (!["png", "jpeg", "webp"].includes(metadata.format) || (metadata.pages || 1) !== 1
        || !metadata.width || !metadata.height || metadata.width > IMAGE_MAX_DIMENSION || metadata.height > IMAGE_MAX_DIMENSION) throw invalid();
    const { data, info } = await sharp(input, options).rotate().webp({ quality: 85 }).timeout({ seconds: 5 }).toBuffer({ resolveWithObject: true });
    if (data.length > IMAGE_MAX_BYTES) throw invalid();
    return { data, width: info.width, height: info.height };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw invalid();
  }
}
