import { describe, it, expect, vi } from 'vitest';
import { CLOUDINARY_CONFIG, isCloudinaryConfigured, cloudinaryUploadUrl, uploadToCloudinary } from '../src/cloudinary.js';

describe('cloudinary', () => {
  it('is configured only when both cloud name and preset are set', () => {
    expect(isCloudinaryConfigured({ cloudName: 'demo', uploadPreset: 'p' })).toBe(true);
    expect(isCloudinaryConfigured({ cloudName: '', uploadPreset: 'p' })).toBe(false);
    expect(isCloudinaryConfigured({ cloudName: 'demo', uploadPreset: '' })).toBe(false);
    expect(isCloudinaryConfigured(null)).toBe(false);
  });

  it('builds the unsigned upload endpoint for the cloud', () => {
    expect(cloudinaryUploadUrl({ cloudName: 'mycloud' })).toBe('https://api.cloudinary.com/v1_1/mycloud/image/upload');
  });

  it('uploads via the preset and returns the secure_url', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ secure_url: 'https://res.cloudinary.com/x/image/upload/v1/a.jpg' }) }));
    const url = await uploadToCloudinary(new Blob(['x'], { type: 'image/png' }), { cloudName: 'c', uploadPreset: 'meetbook' }, fetchImpl);
    expect(url).toBe('https://res.cloudinary.com/x/image/upload/v1/a.jpg');
    const [endpoint, opts] = fetchImpl.mock.calls[0];
    expect(endpoint).toBe('https://api.cloudinary.com/v1_1/c/image/upload');
    expect(opts.method).toBe('POST');
    expect(opts.body.get('upload_preset')).toBe('meetbook');
  });

  it('throws on HTTP failure and on a response without a URL', async () => {
    const bad = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}) }));
    await expect(uploadToCloudinary(new Blob(['x']), { cloudName: 'c', uploadPreset: 'p' }, bad)).rejects.toThrow(/400/);
    const empty = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    await expect(uploadToCloudinary(new Blob(['x']), { cloudName: 'c', uploadPreset: 'p' }, empty)).rejects.toThrow(/no URL/);
  });

  it('ships configured with the MeetBook cloud and unsigned preset', () => {
    expect(CLOUDINARY_CONFIG.cloudName).toBe('e3sdmsgs');
    expect(CLOUDINARY_CONFIG.uploadPreset).toBe('meetbook');
    expect(isCloudinaryConfigured()).toBe(true);
  });
});
