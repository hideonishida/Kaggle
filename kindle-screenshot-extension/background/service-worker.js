'use strict';

// ============================================================
// Kindle Cloud Reader Screenshot - Service Worker
//
// Capture flow (v2):
//   1. Zoom in ONCE at the start of the run
//   2. For each page: turn page → wait until the rendered content
//      actually changes and stabilizes (canvas signature) → capture
//   3. Restore zoom once at the end
//
// The previous per-page zoom-in/zoom-out cycle forced two full
// re-renders per capture, which was slow and produced blank shots
// on slow machines. Waits are now adaptive: they end as soon as the
// page is confirmed rendered, and `delay` acts as the upper limit.
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
  delay: 5000,    // max wait per page (ms)
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
    // Best-effort zoom restore on unexpected failure
    try { await chrome.tabs.setZoom(captureState.tabId, 1.0); } catch { /* ignore */ }
    broadcast({ action: 'captureError', error: err.message });
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

  let stopped = false;

  try {
    // Navigate to start page BEFORE zooming (page turns at 100% are faster)
    if (startPage > 1) {
      broadcastProgress(0, captureState.totalPages);
      for (let i = 1; i < startPage; i++) {
        if (!captureState.isRunning) break;
        await turnPage(tabId, nextDirection, delay);
      }
    }

    if (captureState.isRunning) {
      // Zoom in ONCE for the entire run. The high-res re-render happens a
      // single time here instead of twice per page.
      await chrome.tabs.setZoom(tabId, zoomLevel);
      await waitForContentReady(tabId, Math.max(delay, 5000));
      await sleep(500); // small settle margin after zoom re-render
    }

    let lastImage = null;

    // Main capture loop
    for (let page = startPage; page <= endPage; page++) {
      if (!captureState.isRunning) { stopped = true; break; }

      captureState.currentPage = page;

      if (page > startPage) {
        // Turn page and wait until the rendered content actually changed.
        // The content script resolves early once the new page is stable.
        const result = await turnPage(tabId, nextDirection, delay);
        if (!result || !result.changed) {
          // Keyboard turn didn't change the content — try click fallback
          console.warn(`Page ${page}: keyboard turn had no effect, trying click`);
          await turnPageClick(tabId, nextDirection, delay);
        }
      } else {
        // First page: just make sure current content is rendered
        await waitForContentReady(tabId, delay);
      }

      if (!captureState.isRunning) { stopped = true; break; }

      // Capture, retrying if the shot is blank or identical to the
      // previous page (i.e. rendering lagged behind)
      const dataUrl = await captureStablePage(tabId, windowId, delay, lastImage);
      if (dataUrl) {
        captureState.images.push(dataUrl);
        lastImage = dataUrl;
      }

      broadcastProgress(page - startPage + 1, captureState.totalPages);
    }
  } finally {
    // Always restore zoom, even on stop/error
    try {
      await chrome.tabs.setZoom(tabId, 1.0);
    } catch { /* tab may be gone */ }
  }

  finishCapture(stopped);
}

// `stopped` = true when the user pressed 停止 mid-run.
function finishCapture(stopped) {
  captureState.isRunning = false;
  stopKeepAlive();

  if (stopped) {
    broadcast({ action: 'captureStopped' });
  } else {
    broadcast({ action: 'captureComplete' });
  }

  if (captureState.images.length > 0) {
    generatePdf();
  }
}

// ============================================================
// Capture with stability checks
// ============================================================

async function captureOnce(windowId) {
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  } catch (err) {
    console.warn('captureVisibleTab failed:', err.message);
    return null;
  }
}

/**
 * Capture the visible tab, verifying the result is neither blank nor
 * identical to the previous page's capture. On a bad shot, waits for the
 * content to finish rendering and retries with growing backoff.
 */
async function captureStablePage(tabId, windowId, maxWaitMs, lastImage) {
  const MAX_ATTEMPTS = 4;
  let dataUrl = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (!captureState.isRunning) break;

    dataUrl = await captureOnce(windowId);

    if (dataUrl) {
      // Blank check: a blank/white PNG compresses to a very small size
      const sizeKB = (dataUrl.length * 3) / 4 / 1024;
      const isBlank = sizeKB < 30;
      // Duplicate check: identical to previous page = render hasn't caught up
      const isDuplicate = lastImage !== null && dataUrl === lastImage;

      if (!isBlank && !isDuplicate) {
        return dataUrl;
      }
      console.warn(
        `Capture attempt ${attempt + 1}: ` +
        (isBlank ? `blank (${Math.round(sizeKB)}KB)` : 'identical to previous page') +
        ', retrying...'
      );
    }

    // Wait for rendering to catch up, then retry (500ms, 1s, 1.5s ...)
    await sleep(500 * (attempt + 1));
    await waitForContentReady(tabId, maxWaitMs);
  }

  // Return whatever we have rather than dropping the page silently
  return dataUrl;
}

/**
 * Poll the content script until the page reports itself rendered,
 * up to maxWaitMs. Returns as soon as it's ready.
 */
async function waitForContentReady(tabId, maxWaitMs) {
  const POLL_MS = 400;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        action: 'isContentReady',
      });
      if (response && response.ready) return true;
    } catch {
      // Content script unavailable; don't block the loop
      return false;
    }
    await sleep(POLL_MS);
  }
  return false;
}

// ============================================================
// Page turning
// ============================================================

async function turnPage(tabId, direction, waitMs) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      action: 'turnPage',
      direction,
      timeout: waitMs,
    });
  } catch (err) {
    console.warn('Page turn (keyboard) failed:', err.message);
    return null;
  }
}

async function turnPageClick(tabId, direction, waitMs) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      action: 'turnPageClick',
      direction,
      timeout: waitMs,
    });
  } catch (err) {
    console.warn('Page turn (click) failed:', err.message);
    return null;
  }
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
