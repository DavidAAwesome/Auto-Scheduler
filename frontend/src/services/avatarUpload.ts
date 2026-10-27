/**
 * Avatar rules shared by the picker and the upload. The API enforces the same
 * types and limit (backend/app/avatars.py); these checks only fail faster.
 */
export const AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const AVATAR_ACCEPT = AVATAR_TYPES.join(",");
export const AVATAR_GUIDANCE = "JPG, PNG, or WebP, up to 5 MB. Square photos look best.";
const MAX_EDGE = 256;

/** "Lan Phan" → "LP", "lan" → "L": shown when there is no avatar image. */
export function initials(name: string | undefined) {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0]?.[0] ?? "?").toUpperCase();
}

/** Returns an actionable message, or "" when the file may be uploaded. */
export function avatarFileError(file: { type: string; size: number }) {
  if (!AVATAR_TYPES.includes(file.type)) return "That file type isn't supported. Choose a JPG, PNG, or WebP image.";
  if (file.size > AVATAR_MAX_BYTES) return `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB. Choose one of 5 MB or less.`;
  if (file.size === 0) return "That file is empty. Choose a different image.";
  return "";
}

/** Shrinks to a small JPEG in the browser so uploads stay fast; the original is never stored. */
export async function prepareAvatar(file: File): Promise<Blob> {
  const problem = avatarFileError(file);
  if (problem) throw new Error(problem);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That image couldn't be read. Choose a different JPG, PNG, or WebP file.");
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Your browser couldn't process that image. Try another browser.");
  context.fillStyle = "#fff"; // JPEG has no transparency; avoid black behind transparent PNGs.
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
  if (!blob) throw new Error("Your browser couldn't process that image. Try another browser.");
  return blob;
}
