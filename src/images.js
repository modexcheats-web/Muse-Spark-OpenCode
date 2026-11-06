'use strict';

const path = require('path');

// The Muse web client refuses inline attachments above ~16 MiB per encrypted
// request. Keep a margin for the prompt text and JSON overhead.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 14 * 1024 * 1024;

const MIME_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/svg+xml': 'svg',
};

class ImageError extends Error {
  constructor(message, code = 'INVALID_IMAGE') {
    super(message);
    this.name = 'ImageError';
    this.code = code;
    this.statusCode = 400;
  }
}

function cleanFilename(value, index, mimeType) {
  const fallback = `image-${index + 1}.${MIME_EXTENSIONS[mimeType] || 'bin'}`;
  if (typeof value !== 'string') return fallback;
  const base = value.split(/[\\/]/).pop() || '';
  const safe = base.replace(/[^\w.\- ]+/g, '_').trim().slice(0, 120);
  return safe || fallback;
}

function decodeDataUrl(value, index, part) {
  if (typeof value !== 'string') {
    throw new ImageError(
      `Image ${index + 1} is not a data: URL. Send images as data:image/...;base64,... URLs.`,
      'UNSUPPORTED_IMAGE_SOURCE'
    );
  }
  const trimmed = value.trim();
  if (!/^data:/i.test(trimmed)) {
    throw new ImageError(
      `Image ${index + 1} uses a non-data URL. For privacy and offline use, the proxy only accepts ` +
        'data:image/...;base64,... URLs.',
      'UNSUPPORTED_IMAGE_SOURCE'
    );
  }
  const comma = trimmed.indexOf(',');
  if (comma < 0) throw new ImageError(`Image ${index + 1} has a malformed data: URL.`);
  const header = trimmed.slice(5, comma);
  if (!/(^|;)base64(;|$)/i.test(header)) {
    throw new ImageError(`Image ${index + 1} must be base64-encoded (data:image/...;base64,...).`);
  }
  const mimeType = (header.split(';')[0] || '').trim().toLowerCase();
  const declared = String(part?.mime_type || part?.mimeType || '').toLowerCase();
  const effectiveMime = mimeType.startsWith('image/')
    ? mimeType
    : declared.startsWith('image/')
      ? declared
      : '';
  if (!effectiveMime) {
    throw new ImageError(`Image ${index + 1} does not declare an image MIME type.`);
  }
  const clean = trimmed.slice(comma + 1).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) {
    throw new ImageError(`Image ${index + 1} is not valid base64.`);
  }
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const bytes = Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
  if (bytes === 0) throw new ImageError(`Image ${index + 1} is empty.`);
  if (bytes > MAX_IMAGE_BYTES) {
    throw new ImageError(
      `Image ${index + 1} is ${Math.round(bytes / (1024 * 1024))} MiB; the limit is ` +
        `${MAX_IMAGE_BYTES / (1024 * 1024)} MiB per image.`,
      'IMAGE_TOO_LARGE'
    );
  }
  return {
    mimeType: effectiveMime,
    dataBase64: clean,
    filename: cleanFilename(
      part?.filename || part?.image_url?.filename || part?.name,
      index,
      effectiveMime
    ),
    bytes,
  };
}

/**
 * Extracts image attachments from OpenAI-style messages.
 *
 * Supported content parts:
 *   { type: "image_url", image_url: { url: "data:..." } }
 *   { type: "image_url", image_url: "data:..." }
 *   { type: "input_image", image_url: "data:..." }
 *   { type: "image", image: "data:...", mime_type: "image/png" }
 */
function readPart(part, index) {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'image_url') {
    const source = part.image_url;
    const url = typeof source === 'string' ? source : source?.url;
    if (url == null) return null;
    return decodeDataUrl(url, index, {
      ...part,
      ...(typeof source === 'object' ? source : {}),
      mime_type: part.mime_type || part.mimeType || source?.mime_type || source?.mimeType,
    });
  }
  if (part.type === 'input_image') {
    const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
    if (url == null) return null;
    return decodeDataUrl(url, index, part);
  }
  if (part.type === 'image') {
    const source = part.image ?? part.data ?? part.data_base64;
    if (typeof source === 'string') {
      if (!/^data:/i.test(source)) {
        const mime = String(part.mime_type || part.mimeType || '').toLowerCase();
        if (mime.startsWith('image/')) {
          return decodeDataUrl(`data:${mime};base64,${source}`, index, part);
        }
      }
      return decodeDataUrl(source, index, part);
    }
    if (source && typeof source === 'object' && typeof source.url === 'string') {
      return decodeDataUrl(source.url, index, part);
    }
    throw new ImageError(
      `Image ${index + 1} has an unsupported payload. Send it as a data: URL.`,
      'UNSUPPORTED_IMAGE_SOURCE'
    );
  }
  return null;
}

function collectImages(messages) {
  const images = [];
  let totalBytes = 0;
  let index = 0;
  for (const message of messages || []) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      const image = readPart(part, index);
      if (!image) continue;
      index++;
      totalBytes += image.bytes;
      if (totalBytes > MAX_IMAGE_TOTAL_BYTES) {
        throw new ImageError(
          `Images total more than ${MAX_IMAGE_TOTAL_BYTES / (1024 * 1024)} MiB. ` +
            'Send fewer or smaller images in one request.',
          'IMAGES_TOO_LARGE'
        );
      }
      images.push(image);
    }
  }
  return images;
}

module.exports = {
  ImageError,
  collectImages,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_TOTAL_BYTES,
};
