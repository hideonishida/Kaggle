'use strict';

// ============================================================
// Offscreen Document - PDF Generation
// Receives captured images from the service worker and
// assembles them into a downloadable PDF using jsPDF.
// ============================================================

let batchedImages = [];
let totalBatches = 0;
let receivedBatches = 0;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  switch (msg.action) {
    case 'generatePdf':
      buildPdf(msg.images);
      sendResponse({ ok: true });
      break;

    case 'generatePdfBatchInit':
      batchedImages = [];
      totalBatches = msg.totalBatches;
      receivedBatches = 0;
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
 * Build a PDF from an array of image data URLs.
 * Each image becomes one page, sized to match the image aspect ratio.
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

    // Load the first image to determine page dimensions
    const firstImg = await loadImage(images[0]);
    const imgWidth = firstImg.naturalWidth;
    const imgHeight = firstImg.naturalHeight;

    // Use pixel dimensions converted to mm (72 DPI as base)
    // jsPDF uses mm by default; we set custom page size based on image aspect ratio
    const pxToMm = 25.4 / 72; // 1 point = 1/72 inch = 25.4/72 mm
    const pageWidth = imgWidth * pxToMm;
    const pageHeight = imgHeight * pxToMm;

    const orientation = imgWidth > imgHeight ? 'landscape' : 'portrait';

    // Create jsPDF instance with custom page size
    // jsPDF constructor: (orientation, unit, format)
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({
      orientation,
      unit: 'mm',
      format: [pageWidth, pageHeight],
      compress: true,
    });

    for (let i = 0; i < images.length; i++) {
      if (i > 0) {
        // For subsequent pages, load image to get its dimensions
        const img = await loadImage(images[i]);
        const w = img.naturalWidth * pxToMm;
        const h = img.naturalHeight * pxToMm;
        const orient = img.naturalWidth > img.naturalHeight ? 'l' : 'p';
        pdf.addPage([w, h], orient);
      }

      // Add image to fill the entire page
      const img = await loadImage(images[i]);
      const w = img.naturalWidth * pxToMm;
      const h = img.naturalHeight * pxToMm;
      pdf.addImage(images[i], 'PNG', 0, 0, w, h);
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
