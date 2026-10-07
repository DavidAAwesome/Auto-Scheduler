import {
  deleteObject,
  getDownloadURL,
  ref,
  uploadBytes,
} from "firebase/storage";
import { auth, storage } from "../firebase";

const MAX_EDGE = 256;
const MAX_BYTES = 900_000;

function requireStorage() {
  if (!storage || !auth?.currentUser) {
    throw new Error(
      "Avatar uploads need Firebase Auth and a configured storage bucket.",
    );
  }
  return { storage, user: auth.currentUser };
}

/** Resize/compress in the browser so MongoDB never stores raw image bytes. */
async function prepareImage(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Choose an image file (JPG, PNG, or WebP).");
  }
  if (file.size > 8 * 1024 * 1024) {
    throw new Error("Choose an image smaller than 8 MB.");
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not process that image.");
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.88),
  );
  if (!blob || blob.size > MAX_BYTES) {
    throw new Error("Could not compress that image. Try a simpler photo.");
  }
  return blob;
}

export function avatarObjectPath(uid: string) {
  return `avatars/${uid}/avatar.jpg`;
}

export async function uploadAvatar(file: File) {
  const { storage: bucket, user } = requireStorage();
  const blob = await prepareImage(file);
  const object = ref(bucket, avatarObjectPath(user.uid));
  await uploadBytes(object, blob, {
    contentType: "image/jpeg",
    cacheControl: "public,max-age=3600",
  });
  return getDownloadURL(object);
}

export async function deleteAvatarFile() {
  const { storage: bucket, user } = requireStorage();
  try {
    await deleteObject(ref(bucket, avatarObjectPath(user.uid)));
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "storage/object-not-found") throw error;
  }
}
