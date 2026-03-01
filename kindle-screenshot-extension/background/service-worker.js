'use strict';

// ============================================================
// Kindle Cloud Reader Screenshot - Service Worker
// Controls the capture loop: zoom → capture → restore → next
// ============================================================

const captureState = {
  isRunning: false,
  currentPage: 0,
  startPage: 1,
  endPage: 10,
  totalPages: 0,
  pageDirection: 'left', // 'left' = 左送り(漫画), 'right' = 右送り(小説)
  cropWidth: 0,   // 0 = no crop
  cropHeight: 0,  // 0 = no crop
  outputWidth: 0,   // 0 = original size
  outputHeight: 0,  // 0 = original size
  zoomLevel: 2.0,
  delay: 2000,
  images: [],
  tabId: null,
  windowId: null,
};

// Keep service worker alive during capture with periodic alarms
const KEEP_ALIVE_ALARM = 'keepAlive';

function startKeepAlive() {
  chrome.alarms.create(KEEP_ALIVE_ALARM, { periodInMinutes: 0.4 });
}

function stopKeepAlive() {
  chrome.alarms.clear(KEEP_ALIVE_ALARM);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEP_ALIVE_ALARM && captureState.isRunning) {
    // No-op: just keeps the service worker alive
  }
});

// ============================================================
// Message handling
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case 'startCapture':
      handleStartCapture(msg, sendResponse);
      return true;

    case 'stopCapture':
      captureState.isRunning = false;
      sendResponse({ ok: true });
      return false;

    case 'getStatus':
      sendResponse({
        isRunning: captureState.isRunning,
        currentPage: captureState.currentPage,
        startPage: captureState.startPage,
        totalPages: captureState.totalPages,
      });
      return false;

    case 'pdfReady':
      handlePdfReady(msg);
      sendResponse({ ok: true });
      return false;
  }
});

// ============================================================
// Capture orchestration
// ============================================================

async function handleStartCapture(msg, sendResponse) {
  if (captureState.isRunning) {
    sendResponse({ error: '既に撮影中です' });
    return;
  }

  try {
    // Get the active Kindle tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      sendResponse({ error: 'アクティブなタブが見つかりません' });
      return;
    }

    const url = tab.url || '';
    if (!url.includes('read.amazon.')) {
      sendResponse({ error: 'Kindle Cloud Readerのページで実行してください' });
      return;
    }

    // Initialize state
    captureState.isRunning = true;
    captureState.startPage = msg.startPage;
    captureState.endPage = msg.endPage;
    captureState.totalPages = msg.endPage - msg.startPage + 1;
    captureState.currentPage = msg.startPage;
    captureState.pageDirection = msg.pageDirection || 'left';
    captureState.cropWidth = msg.cropWidth || 0;
    captureState.cropHeight = msg.cropHeight || 0;
    captureState.outputWidth = msg.outputWidth || 0;
    captureState.outputHeight = msg.outputHeight || 0;
    captureState.zoomLevel = msg.zoomLevel;
    captureState.delay = msg.delay;
    captureState.images = [];
    captureState.tabId = tab.id;
    captureState.windowId = tab.windowId;

    sendResponse({ ok: true });

    // Ensure content script is injected
    await ensureContentScript(tab.id);

    startKeepAlive();

    // Run the capture loop
    await captureLoop();
  } catch (err) {
    captureState.isRunning = false;
    stopKeepAlive();
    sendResponse({ error: err.message });
  }
}

async function ensureContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    if (response && response.ready) return;
  } catch {
    // Content script not yet injected, inject it
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content.js'],
    });
    // Wait for script to initialize
    await sleep(300);
  }
}

async function captureLoop() {
  const { startPage, endPage, tabId, windowId, zoomLevel, delay, pageDirection } = captureState;

  // Determine the arrow key direction based on user's selection
  // 'left' = 左送り(漫画/右綴じ) → ArrowLeft is "next page"
  // 'right' = 右送り(小説/左綴じ) → ArrowRight is "next page"
  const nextDirection = pageDirection === 'left' ? 'prev' : 'next';

  // Navigate to start page: if startPage > 1, turn pages to reach it
  // (The user should already be near the desired page, but we skip ahead if needed)
  if (startPage > 1) {
    broadcastProgress(0, captureState.totalPages);
    for (let i = 1; i < startPage; i++) {
      if (!captureState.isRunning) break;
      await turnPage(tabId, nextDirection, delay);
    }
  }

  // Main capture loop
  for (let page = startPage; page <= endPage; page++) {
    if (!captureState.isRunning) {
      broadcast({ action: 'captureStopped' });
      stopKeepAlive();
      // If we have images, still offer PDF
      if (captureState.images.length > 0) {
        await generatePdf();
      }
      return;
    }

    captureState.currentPage = page;

    // If not the very first page, turn to next page
    if (page > startPage) {
      await turnPage(tabId, nextDirection, delay);
    } else {
      // Wait for current page to be stable
      await sleep(Math.min(delay, 1000));
    }

    if (!captureState.isRunning) break;

    // Check content is ready before capturing (blank page prevention)
    await waitForContentReady(tabId, delay);

    // Capture with zoom, retry if blank
    const dataUrl = await captureWithRetry(tabId, windowId, zoomLevel, delay);
    if (dataUrl) {
      captureState.images.push(dataUrl);
    }

    const captured = page - startPage + 1;
    broadcastProgress(captured, captureState.totalPages);
  }

  if (!captureState.isRunning && captureState.images.length === 0) {
    stopKeepAlive();
    return;
  }

  captureState.isRunning = false;
  stopKeepAlive();

  broadcast({ action: 'captureComplete' });

  // Generate PDF
  await generatePdf();
}

// ============================================================
// Capture with zoom
// ============================================================

async function captureWithZoom(tabId, windowId, zoomLevel) {
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // Step 1: Zoom in
      await chrome.tabs.setZoom(tabId, zoomLevel);
      await sleep(400); // Wait for zoom to render

      // Step 2: Capture
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
        format: 'png',
      });

      // Step 3: Restore zoom
      await chrome.tabs.setZoom(tabId, 1.0);
      await sleep(200);

      return dataUrl;
    } catch (err) {
      console.warn(`Capture attempt ${attempt + 1} failed:`, err.message);
      // Try to restore zoom even on error
      try {
        await chrome.tabs.setZoom(tabId, 1.0);
      } catch { /* ignore */ }
      await sleep(300);

      if (attempt === MAX_RETRIES - 1) {
        // Last attempt: try without zoom
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
            format: 'png',
          });
          return dataUrl;
        } catch (finalErr) {
          console.error('All capture attempts failed:', finalErr.message);
          return null;
        }
      }
    }
  }
  return null;
}

// ============================================================
// Page turning
// ============================================================

async function turnPage(tabId, direction, waitMs) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      action: 'turnPage',
      direction,
      timeout: waitMs,
    });
  } catch {
    // Fallback: try click-based page turn
    try {
      await chrome.tabs.sendMessage(tabId, {
        action: 'turnPageClick',
        direction,
        timeout: waitMs,
      });
    } catch (err) {
      console.warn('Page turn failed:', err.message);
    }
  }
  // Additional stabilization wait
  await sleep(300);
}

// ============================================================
// PDF generation via offscreen document
// ============================================================

async function generatePdf() {
  if (captureState.images.length === 0) return;

  try {
    await setupOffscreenDocument();

    // Send images to offscreen document for PDF generation
    // Split into batches if too many images (message size limit)
    const BATCH_SIZE = 20;
    const images = captureState.images;

    const pdfOpts = {
      cropWidth: captureState.cropWidth,
      cropHeight: captureState.cropHeight,
      outputWidth: captureState.outputWidth,
      outputHeight: captureState.outputHeight,
    };

    if (images.length <= BATCH_SIZE) {
      chrome.runtime.sendMessage({
        action: 'generatePdf',
        target: 'offscreen',
        images,
        ...pdfOpts,
      });
    } else {
      // Send init message
      chrome.runtime.sendMessage({
        action: 'generatePdfBatchInit',
        target: 'offscreen',
        totalBatches: Math.ceil(images.length / BATCH_SIZE),
        totalImages: images.length,
        ...pdfOpts,
      });
      // Send batches
      for (let i = 0; i < images.length; i += BATCH_SIZE) {
        const batch = images.slice(i, i + BATCH_SIZE);
        chrome.runtime.sendMessage({
          action: 'generatePdfBatch',
          target: 'offscreen',
          batchIndex: Math.floor(i / BATCH_SIZE),
          images: batch,
          isLast: i + BATCH_SIZE >= images.length,
        });
      }
    }
  } catch (err) {
    console.error('PDF generation setup failed:', err.message);
    broadcast({ action: 'captureError', error: 'PDF生成に失敗しました: ' + err.message });
  }
}

async function setupOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });

  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['DOM_PARSER'],
    justification: 'Generate PDF from captured images using jsPDF',
  });
}

// Handle PDF ready from offscreen document
async function handlePdfReady(msg) {
  try {
    // Download the PDF blob
    await chrome.downloads.download({
      url: msg.blobUrl,
      filename: `kindle-screenshot-${Date.now()}.pdf`,
      saveAs: true,
    });

    broadcast({
      action: 'downloadReady',
      total: captureState.images.length,
    });

    // Clean up
    captureState.images = [];

    // Close offscreen document
    try {
      await chrome.offscreen.closeDocument();
    } catch { /* ignore */ }
  } catch (err) {
    broadcast({ action: 'captureError', error: 'ダウンロードに失敗しました: ' + err.message });
  }
}

// ============================================================
// Blank page detection & retry
// ============================================================

/**
 * Ask the content script whether the page content appears to be rendered.
 * Returns true if content is visible, false if it seems blank/loading.
 */
async function waitForContentReady(tabId, delay) {
  const MAX_CHECKS = 5;
  const CHECK_INTERVAL = 600;

  for (let i = 0; i < MAX_CHECKS; i++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        action: 'isContentReady',
      });
      if (response && response.ready) return;
    } catch {
      // Content script may not support the message yet; skip
      return;
    }
    await sleep(CHECK_INTERVAL);
  }
  // Even if not confirmed ready, proceed (fallback)
}

/**
 * Capture with zoom, then verify the capture isn't blank.
 * Retries up to 3 times with increasing wait if blank is detected.
 */
async function captureWithRetry(tabId, windowId, zoomLevel, delay) {
  const MAX_RETRIES = 3;
  const RETRY_WAIT = 1500;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const dataUrl = await captureWithZoom(tabId, windowId, zoomLevel);
    if (!dataUrl) return null;

    // Check if the captured image is blank by examining data URL size.
    // A completely blank/white PNG at typical screen resolution compresses
    // to a very small size. Real content is significantly larger.
    // Threshold: a blank 1920x1080 PNG is ~5-15KB, real content is 100KB+
    const sizeKB = (dataUrl.length * 3) / 4 / 1024; // approximate decoded size
    if (sizeKB > 30) {
      // Looks like real content
      return dataUrl;
    }

    // Possibly blank, wait and retry
    console.warn(`Capture attempt ${attempt + 1}: image seems blank (${Math.round(sizeKB)}KB), retrying...`);
    await sleep(RETRY_WAIT * (attempt + 1));

    // Ask content script to re-check readiness
    await waitForContentReady(tabId, delay);
  }

  // After all retries, return whatever we captured
  const dataUrl = await captureWithZoom(tabId, windowId, zoomLevel);
  return dataUrl;
}

// ============================================================
// Utilities
// ============================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {
    // Popup might be closed; ignore errors
  });
}

function broadcastProgress(captured, total) {
  broadcast({ action: 'progress', captured, total });
}
