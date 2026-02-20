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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  switch (msg.action) {
    case 'generatePdf':
      cropSettings = { cropWidth: msg.cropWidth || 0, cropHeight: msg.cropHeight || 0 };
      buildPdf(msg.images);
      sendResponse({ ok: true });
      break;

    case 'generatePdfBatchInit':
      batchedImages = [];
      totalBatches = msg.totalBatches;
      receivedBatches = 0;
      cropSettings = { cropWidth: msg.cropWidth || 0, cropHeight: msg.cropHeight || 0 };
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
 * Build a PDF from an array of image data URLs.
 * Each image becomes one page, sized to match the image aspect ratio.
 * If cropSettings are provided, images are center-cropped first.
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
    const needsCrop = cropWidth > 0 || cropHeight > 0;

    // Load the first image and optionally crop to determine page dimensions
    const firstImg = await loadImage(images[0]);
    const first = needsCrop
      ? cropImage(firstImg, cropWidth, cropHeight)
      : { dataUrl: images[0], width: firstImg.naturalWidth, height: firstImg.naturalHeight };

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
      const cropped = needsCrop
        ? cropImage(img, cropWidth, cropHeight)
        : { dataUrl: images[i], width: img.naturalWidth, height: img.naturalHeight };

      const w = cropped.width * pxToMm;
      const h = cropped.height * pxToMm;

      if (i > 0) {
        const orient = cropped.width > cropped.height ? 'l' : 'p';
        pdf.addPage([w, h], orient);
      }

      pdf.addImage(cropped.dataUrl, 'PNG', 0, 0, w, h);
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
