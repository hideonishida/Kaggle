'use strict';

// ============================================================
// Offscreen Document - PDF Generation
// Receives captured images from the service worker and
// assembles them into a downloadable PDF using jsPDF.
// ============================================================

let batchedImages = [];
let totalBatches = 0;
let receivedBatches = 0;
let cropSettings = { cropWidth: 0, cropHeight: 0 };
let sizeSettings = { outputWidth: 0, outputHeight: 0 };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  switch (msg.action) {
    case 'generatePdf':
      cropSettings = { cropWidth: msg.cropWidth || 0, cropHeight: msg.cropHeight || 0 };
      sizeSettings = { outputWidth: msg.outputWidth || 0, outputHeight: msg.outputHeight || 0 };
      buildPdf(msg.images);
      sendResponse({ ok: true });
      break;

    case 'generatePdfBatchInit':
      batchedImages = [];
      totalBatches = msg.totalBatches;
      receivedBatches = 0;
      cropSettings = { cropWidth: msg.cropWidth || 0, cropHeight: msg.cropHeight || 0 };
      sizeSettings = { outputWidth: msg.outputWidth || 0, outputHeight: msg.outputHeight || 0 };
      sendResponse({ ok: true });
      break;

    case 'generatePdfBatch':
      batchedImages.push(...msg.images);
      receivedBatches++;
      if (msg.isLast || receivedBatches >= totalBatches) {
        buildPdf(batchedImages);
        batchedImages = [];
      }
      sendResponse({ ok: true });
      break;
  }
});

/**
 * Load a data URL as an Image and return its natural dimensions.
 */
function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error('Image load failed'));
    img.src = dataUrl;
  });
}

/**
 * Center-crop an image to the specified dimensions using a canvas.
 * Returns a PNG data URL of the cropped image.
 * If crop dimensions are 0 or larger than the image, returns the original.
 */
function cropImage(img, targetWidth, targetHeight) {
  const srcW = img.naturalWidth;
  const srcH = img.naturalHeight;

  // If no crop needed or crop is larger than source, return original
  if ((!targetWidth && !targetHeight) ||
      (targetWidth >= srcW && targetHeight >= srcH)) {
    return { dataUrl: img.src, width: srcW, height: srcH };
  }

  const cropW = targetWidth && targetWidth < srcW ? targetWidth : srcW;
  const cropH = targetHeight && targetHeight < srcH ? targetHeight : srcH;

  // Center crop offset
  const sx = Math.floor((srcW - cropW) / 2);
  const sy = Math.floor((srcH - cropH) / 2);

  const canvas = document.createElement('canvas');
  canvas.width = cropW;
  canvas.height = cropH;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, sx, sy, cropW, cropH, 0, 0, cropW, cropH);

  return { dataUrl: canvas.toDataURL('image/png'), width: cropW, height: cropH };
}

/**
 * Resize an image to fit within target dimensions, maintaining aspect ratio.
 * Returns a PNG data URL of the resized image.
 * If target dimensions are 0, returns the original.
 */
function resizeImage(img, targetWidth, targetHeight) {
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;

  if (!targetWidth && !targetHeight) {
    return { dataUrl: img.src, width: srcW, height: srcH };
  }

  // Calculate scale to fit within target dimensions while maintaining aspect ratio
  let scale = 1;
  if (targetWidth && targetHeight) {
    scale = Math.min(targetWidth / srcW, targetHeight / srcH);
  } else if (targetWidth) {
    scale = targetWidth / srcW;
  } else {
    scale = targetHeight / srcH;
  }

  // Don't upscale
  if (scale >= 1) {
    return { dataUrl: img.src, width: srcW, height: srcH };
  }

  const newW = Math.round(srcW * scale);
  const newH = Math.round(srcH * scale);

  const canvas = document.createElement('canvas');
  canvas.width = newW;
  canvas.height = newH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, newW, newH);

  return { dataUrl: canvas.toDataURL('image/png'), width: newW, height: newH };
}

/**
 * Apply crop then resize to an image, returning the processed result.
 */
async function processImage(img, dataUrl, needsCrop, cropW, cropH, needsResize, outW, outH) {
  let result = needsCrop
    ? cropImage(img, cropW, cropH)
    : { dataUrl, width: img.naturalWidth, height: img.naturalHeight };

  if (needsResize) {
    // Load the cropped image so canvas drawImage works correctly
    const tempImg = await loadImage(result.dataUrl);
    result = resizeImage(tempImg, outW, outH);
  }

  return result;
}

/**
 * Build a PDF from an array of image data URLs.
 * Each image becomes one page, sized to match the image aspect ratio.
 * If cropSettings are provided, images are center-cropped first.
 * If sizeSettings are provided, images are resized to fit the target.
 */
async function buildPdf(images) {
  try {
    if (!images || images.length === 0) {
      chrome.runtime.sendMessage({
        action: 'captureError',
        error: 'PDF生成する画像がありません',
      });
      return;
    }

    const { cropWidth, cropHeight } = cropSettings;
    const { outputWidth, outputHeight } = sizeSettings;
    const needsCrop = cropWidth > 0 || cropHeight > 0;
    const needsResize = outputWidth > 0 || outputHeight > 0;

    // Load the first image and process to determine page dimensions
    const firstImg = await loadImage(images[0]);
    const first = await processImage(firstImg, images[0], needsCrop, cropWidth, cropHeight, needsResize, outputWidth, outputHeight);

    // Use pixel dimensions converted to mm (72 DPI as base)
    // jsPDF uses mm by default; we set custom page size based on image aspect ratio
    const pxToMm = 25.4 / 72; // 1 point = 1/72 inch = 25.4/72 mm
    const pageWidth = first.width * pxToMm;
    const pageHeight = first.height * pxToMm;

    const orientation = first.width > first.height ? 'landscape' : 'portrait';

    // Create jsPDF instance with custom page size
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({
      orientation,
      unit: 'mm',
      format: [pageWidth, pageHeight],
      compress: true,
    });

    for (let i = 0; i < images.length; i++) {
      const img = await loadImage(images[i]);
      const processed = await processImage(img, images[i], needsCrop, cropWidth, cropHeight, needsResize, outputWidth, outputHeight);

      const w = processed.width * pxToMm;
      const h = processed.height * pxToMm;

      if (i > 0) {
        const orient = processed.width > processed.height ? 'l' : 'p';
        pdf.addPage([w, h], orient);
      }

      pdf.addImage(processed.dataUrl, 'PNG', 0, 0, w, h);
    }

    // Generate blob URL
    const pdfBlob = pdf.output('blob');
    const blobUrl = URL.createObjectURL(pdfBlob);

    // Notify service worker that PDF is ready for download
    chrome.runtime.sendMessage({
      action: 'pdfReady',
      blobUrl,
    });
  } catch (err) {
    console.error('PDF build error:', err);
    chrome.runtime.sendMessage({
      action: 'captureError',
      error: 'PDF生成中にエラーが発生しました: ' + err.message,
    });
  }
}
