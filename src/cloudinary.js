// Cloudinary image uploads (free tier) — MeetBook's photo storage while the
// Firebase project stays on the Spark plan (Firebase Storage needs Blaze).
//
// A Cloudinary *cloud name* and an *unsigned upload preset* are NOT secrets:
// unsigned presets are designed to be used from public web code, and uploads
// through them are constrained by the preset's settings in the Cloudinary
// console. The API key/secret are never used by this app and never appear
// here. If this config is emptied, uploads fall back to Firebase Storage
// (Blaze) and then to compressed data URLs in Firestore, as before.
export const CLOUDINARY_CONFIG = {
  cloudName: 'e3sdmsgs',
  uploadPreset: 'meetbook'
};

export function isCloudinaryConfigured(cfg = CLOUDINARY_CONFIG) {
  return Boolean(cfg && cfg.cloudName && cfg.uploadPreset);
}

export function cloudinaryUploadUrl(cfg = CLOUDINARY_CONFIG) {
  return `https://api.cloudinary.com/v1_1/${cfg.cloudName}/image/upload`;
}

// Upload one image file via the unsigned preset; resolves to the hosted
// secure_url. Throws on any failure so callers can fall back.
export async function uploadToCloudinary(file, cfg = CLOUDINARY_CONFIG, fetchImpl = fetch) {
  const body = new FormData();
  body.append('file', file);
  body.append('upload_preset', cfg.uploadPreset);
  const res = await fetchImpl(cloudinaryUploadUrl(cfg), { method: 'POST', body });
  if (!res || !res.ok) throw new Error(`Cloudinary upload failed (HTTP ${res ? res.status : 'no response'})`);
  const data = await res.json();
  if (!data || !data.secure_url) throw new Error('Cloudinary upload returned no URL');
  return data.secure_url;
}

// Right-size a Cloudinary delivery URL at render time: f_auto serves
// WebP/AVIF where the browser supports them, q_auto picks a sane quality,
// and w_<n>,c_limit caps the width without ever upscaling — so a phone on a
// slow connection downloads a few hundred KB instead of the full-size
// original. Non-Cloudinary URLs (data:, Firebase Storage, anything else)
// and URLs that already carry a transformation pass through untouched.
export function cldImg(url, width = 1080) {
  if (!url || typeof url !== 'string') return url;
  if (!url.includes('res.cloudinary.com') || !url.includes('/image/upload/')) return url;
  const after = url.split('/image/upload/')[1] || '';
  const firstSegment = after.split('/')[0] || '';
  if (/(^|,)(f_auto|q_auto|w_\d+)/.test(firstSegment)) return url;
  const w = Math.max(16, Math.min(2048, Math.round(Number(width) || 1080)));
  return url.replace('/image/upload/', `/image/upload/f_auto,q_auto,w_${w},c_limit/`);
}
