/**
 * Prepare a browser-selected image for WhatsApp Web.
 *
 * whatsapp-web.js hands the bytes to WhatsApp Web's internal media pipeline.
 * That pipeline is happiest with a clean, reasonably sized JPEG/PNG; odd
 * formats, very large photos and files that are not really the MIME type they
 * claim can make it fail before the message is sent. Re-encoding through the
 * browser gives us a predictable JPEG, keeps transparency from turning into
 * black, and keeps the upload under the server's media limit.
 *
 * Animated GIFs and SVGs are sent as documents instead: rasterising them would
 * silently drop animation or vector data. Formats the browser cannot decode
 * (for example HEIC in Chrome) also fall back to a document with an honest
 * notice rather than failing the send.
 */

export const IMAGE_MAX_DIMENSION = 2048;
export const IMAGE_TARGET_BYTES = 4 * 1024 * 1024;

function outputName(name) {
  const base = String(name || 'image').replace(/\.[^.\\/]+$/, '') || 'image';
  return `${base}.jpg`;
}

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall through to the <img> path for browsers/builds that refuse a Blob.
    }
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('The image could not be decoded.'));
    };
    image.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The image could not be encoded.'))),
      type,
      quality,
    );
  });
}

/**
 * @param {File} file
 * @param {{maxBytes?: number}} [options]
 * @returns {Promise<{file: File, asDocument: boolean, notice: string|null, converted: boolean}>}
 */
export async function prepareOutboundImage(file, { maxBytes = 0 } = {}) {
  const mimeType = String(file?.type ?? '').toLowerCase();
  if (!mimeType.startsWith('image/')) {
    return { file, asDocument: false, notice: null, converted: false };
  }

  if (mimeType === 'image/gif' || mimeType === 'image/svg+xml') {
    return {
      file,
      asDocument: true,
      notice: 'Animated GIFs and SVG files are sent as documents because WhatsApp Web cannot process them as photos.',
      converted: false,
    };
  }

  let source;
  try {
    source = await decodeImage(file);
  } catch {
    return {
      file,
      asDocument: true,
      notice: 'This image format cannot be prepared in the browser, so it will be sent as a file.',
      converted: false,
    };
  }

  try {
    const width = Number(source.width || source.naturalWidth || 0);
    const height = Number(source.height || source.naturalHeight || 0);
    if (!width || !height) throw new Error('The image has no dimensions.');

    const target = Math.min(
      maxBytes > 0 ? maxBytes : IMAGE_TARGET_BYTES,
      IMAGE_TARGET_BYTES,
    );
    const attempts = [
      { dimension: IMAGE_MAX_DIMENSION, quality: 0.9 },
      { dimension: 1600, quality: 0.82 },
      { dimension: 1280, quality: 0.74 },
    ];

    let encoded = null;
    for (const attempt of attempts) {
      const scale = Math.min(1, attempt.dimension / Math.max(width, height));
      const targetWidth = Math.max(1, Math.round(width * scale));
      const targetHeight = Math.max(1, Math.round(height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('The image canvas is unavailable.');
      // JPEG has no alpha channel. Flatten onto white so transparent PNGs do
      // not turn into black rectangles on the recipient's phone.
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, targetWidth, targetHeight);
      context.drawImage(source, 0, 0, targetWidth, targetHeight);
      const blob = await canvasToBlob(canvas, 'image/jpeg', attempt.quality);
      encoded = { blob, width: targetWidth, height: targetHeight };
      if (!target || blob.size <= target) break;
    }

    if (!encoded) throw new Error('The image could not be encoded.');
    const prepared = new File([encoded.blob], outputName(file.name), {
      type: 'image/jpeg',
      lastModified: file.lastModified || Date.now(),
    });
    return { file: prepared, asDocument: false, notice: null, converted: true };
  } catch {
    return {
      file,
      asDocument: true,
      notice: 'This image could not be prepared in the browser, so it will be sent as a file.',
      converted: false,
    };
  } finally {
    source.close?.();
  }
}
