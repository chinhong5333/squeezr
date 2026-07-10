/**
 * Compression worker.
 *
 * Runs entirely off the main thread. Decodes each image with the browser's own
 * OffscreenCanvas (no decode WASM needed), then re-encodes with the appropriate
 * codec. Files are processed one message at a time — the main thread only sends
 * the next file after it receives `done`, which keeps peak WASM memory bounded.
 *
 * Codecs are dynamically imported on first real use so the ~MBs of WASM only
 * download when the user actually clicks Compress.
 */

const CONFIG = {
  // pngquant / libimagequant lossy palette quantization
  pngQualityMin: 65, // if this floor can't be met, quantization aborts -> lossless fallback
  pngQualityTarget: 80,
  pngSpeed: 4, // 1-10, lower = better quality; 4 is the library default
  // oxipng lossless squeeze
  oxipngLevel: 2,
  // MozJPEG
  jpegQuality: 80,
  // WebP
  webpQuality: 80,
  // Safety guard against pathological inputs blowing up WASM memory.
  maxMegapixels: 40,
};

// Lazily-loaded codec modules (cached after first load).
let _oxipng, _mozjpeg, _webp, _imagequant;

async function loadOxipng() {
  if (!_oxipng) _oxipng = (await import('@jsquash/oxipng/optimise')).default;
  return _oxipng;
}
async function loadMozjpeg() {
  if (!_mozjpeg) _mozjpeg = (await import('@jsquash/jpeg/encode')).default;
  return _mozjpeg;
}
async function loadWebp() {
  if (!_webp) _webp = (await import('@jsquash/webp/encode')).default;
  return _webp;
}
async function loadImagequant() {
  if (!_imagequant) {
    const mod = await import('imagequant');
    _imagequant = { Imagequant: mod.Imagequant, ImagequantImage: mod.ImagequantImage };
  }
  return _imagequant;
}

self.onmessage = (event) => {
  const msg = event.data;
  if (msg && msg.type === 'compress') {
    handleFile(msg);
  }
};

async function handleFile({ id, buffer, mime, name, webp, scale }) {
  try {
    const originalSize = buffer.byteLength;
    const pct = Math.min(100, Math.max(1, Math.round(scale || 100)));
    const { imageData, srcWidth, srcHeight } = await decodeToImageData(buffer, mime, pct);
    // Key "resizing" off the ACTUAL dimension change, not the requested percent: a tiny
    // image can round back to its original size at a <100% request (e.g. 1×1 at any %,
    // or a ≤5px axis at 90%). Treating that as a resize would wrongly skip the
    // keep-original safety net and stamp a false "resized to N%" label.
    const resizing = imageData.width !== srcWidth || imageData.height !== srcHeight;

    // Guard on the *source* dimensions — the full-size bitmap is decoded either way.
    const mp = (srcWidth * srcHeight) / 1_000_000;
    if (mp > CONFIG.maxMegapixels) {
      throw new Error(
        `Image is ${mp.toFixed(0)} MP (limit ${CONFIG.maxMegapixels} MP). Too large to process safely.`
      );
    }

    let outBuf; // ArrayBuffer
    let outMime;
    let outExt;
    let method;

    if (webp) {
      const encode = await loadWebp();
      outBuf = await encode(imageData, { quality: CONFIG.webpQuality });
      outMime = 'image/webp';
      outExt = 'webp';
      method = 'WebP';
    } else if (mime === 'image/jpeg') {
      const encode = await loadMozjpeg();
      outBuf = await encode(imageData, { quality: CONFIG.jpegQuality });
      outMime = 'image/jpeg';
      outExt = 'jpg';
      method = 'MozJPEG';
    } else {
      // PNG path: lossy quantize (best effort) -> lossless oxipng squeeze.
      const optimise = await loadOxipng();
      let pngBytes; // Uint8Array
      try {
        pngBytes = await quantize(imageData);
        method = 'pngquant + oxipng';
      } catch (_quantErr) {
        // Quality floor could not be met -> keep full color, lossless-only pass.
        // When resizing, the original bytes are the wrong dimensions — re-encode
        // the (already scaled) pixels to PNG first.
        pngBytes = resizing ? new Uint8Array(await encodePng(imageData)) : new Uint8Array(buffer);
        method = 'oxipng (lossless only)';
      }
      outBuf = await optimise(pngBytes.buffer, {
        level: CONFIG.oxipngLevel,
        interlace: false,
        optimiseAlpha: true,
      });
      outMime = 'image/png';
      outExt = 'png';
    }

    // Never hand back something bigger than the original — unless the user asked
    // for a resize, in which case the dimension change itself is the point and the
    // resized file must always ship.
    let finalBuf = outBuf;
    let finalMime = outMime;
    let finalName = renameExt(name, outExt);
    let keptOriginal = false;
    if (resizing) {
      method += ` · resized to ${pct}%`;
    } else if (outBuf.byteLength >= originalSize) {
      finalBuf = buffer;
      finalMime = mime;
      finalName = name;
      keptOriginal = true;
      method += ' — kept original (already smaller)';
    }

    self.postMessage(
      {
        type: 'done',
        id,
        ok: true,
        buffer: finalBuf,
        mime: finalMime,
        name: finalName,
        originalSize,
        newSize: finalBuf.byteLength,
        method,
        keptOriginal,
        srcWidth,
        srcHeight,
        outWidth: imageData.width,
        outHeight: imageData.height,
      },
      [finalBuf]
    );
  } catch (err) {
    self.postMessage({
      type: 'done',
      id,
      ok: false,
      error: (err && err.message) ? err.message : String(err),
    });
  }
}

/**
 * Decode any browser-supported image to RGBA ImageData via OffscreenCanvas,
 * optionally scaled down to `scalePct` percent (aspect ratio preserved).
 */
async function decodeToImageData(buffer, mime, scalePct = 100) {
  const blob = new Blob([buffer], { type: mime });
  const bitmap = await createImageBitmap(blob);
  try {
    const srcWidth = bitmap.width;
    const srcHeight = bitmap.height;
    const w = Math.max(1, Math.round((srcWidth * scalePct) / 100));
    const h = Math.max(1, Math.round((srcHeight * scalePct) / 100));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (scalePct < 100) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, w, h);
    } else {
      ctx.drawImage(bitmap, 0, 0);
    }
    return { imageData: ctx.getImageData(0, 0, w, h), srcWidth, srcHeight };
  } finally {
    bitmap.close();
  }
}

/** Encode ImageData to a PNG ArrayBuffer via OffscreenCanvas (resized lossless fallback). */
async function encodePng(imageData) {
  const canvas = new OffscreenCanvas(imageData.width, imageData.height);
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return blob.arrayBuffer();
}

/**
 * Lossy palette quantization. Returns a complete PNG (Uint8Array).
 * Throws if the minimum quality floor cannot be met — caller falls back to lossless.
 */
async function quantize(imageData) {
  const { Imagequant, ImagequantImage } = await loadImagequant();
  const iq = new Imagequant();
  try {
    iq.set_quality(CONFIG.pngQualityMin, CONFIG.pngQualityTarget);
    iq.set_speed(CONFIG.pngSpeed);
    // ImagequantImage takes ownership; `process` frees it internally.
    const image = new ImagequantImage(
      new Uint8Array(imageData.data.buffer),
      imageData.width,
      imageData.height,
      0.0 // sRGB gamma
    );
    return iq.process(image); // fresh Uint8Array (already .slice()'d by the codec)
  } finally {
    iq.free();
  }
}

/** Swap a filename's extension, preserving the rest of the name. */
function renameExt(name, ext) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base}.${ext}`;
}
