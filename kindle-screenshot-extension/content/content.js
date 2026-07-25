'use strict';

// Kindle Cloud Reader content script
// Handles page navigation and render-completion detection within the reader.
//
// Kindle renders pages into <canvas>, so DOM mutation events are useless for
// detecting page turns. Instead we compute a small pixel-hash "signature" of
// the visible canvases and wait until it changes and stabilizes.

(() => {
  // Avoid double injection
  if (window.__kindleScreenshotInjected) return;
  window.__kindleScreenshotInjected = true;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Simulate a keyboard event on the document.
   * Kindle Cloud Reader listens for arrow key events for page navigation.
   */
  function simulateKey(key) {
    const opts = {
      key,
      code: key === 'ArrowRight' ? 'ArrowRight' : 'ArrowLeft',
      keyCode: key === 'ArrowRight' ? 39 : 37,
      which: key === 'ArrowRight' ? 39 : 37,
      bubbles: true,
      cancelable: true,
    };
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
    document.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  /**
   * Fallback: click on the right or left edge of the viewport to turn pages.
   * Kindle Cloud Reader has invisible click zones on the edges.
   */
  function clickPageTurn(direction) {
    // Try known selector first
    const selectorId = direction === 'next'
      ? 'kindleReader_pageTurnAreaRight'
      : 'kindleReader_pageTurnAreaLeft';
    const knownEl = document.getElementById(selectorId);
    if (knownEl) {
      knownEl.click();
      return;
    }

    // Fallback: click on edge of viewport
    const x = direction === 'next'
      ? window.innerWidth - 30
      : 30;
    const y = window.innerHeight / 2;
    const target = document.elementFromPoint(x, y);
    if (target) {
      target.dispatchEvent(new MouseEvent('click', {
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
      }));
    }
  }

  /**
   * Compute a cheap signature of the currently rendered content.
   * Samples pixels from visible canvases (downscaled to 16x16) plus image
   * sources. Two different rendered pages produce different signatures;
   * the same page produces the same signature.
   */
  function getContentSignature() {
    let hash = 5381;
    const mix = (n) => { hash = (((hash << 5) + hash) + (n | 0)) >>> 0; };
    let sampled = false;

    const canvases = document.querySelectorAll('canvas');
    for (const canvas of canvases) {
      if (canvas.offsetParent === null) continue;
      if (canvas.width === 0 || canvas.height === 0) continue;
      mix(canvas.width);
      mix(canvas.height);
      try {
        const S = 16;
        const small = document.createElement('canvas');
        small.width = S;
        small.height = S;
        const sctx = small.getContext('2d', { willReadFrequently: true });
        sctx.drawImage(canvas, 0, 0, S, S);
        const data = sctx.getImageData(0, 0, S, S).data;
        for (let i = 0; i < data.length; i += 8) mix(data[i]);
        sampled = true;
      } catch {
        // Tainted canvas; fall through to other sources
      }
    }

    const imgs = document.querySelectorAll('img');
    mix(imgs.length);
    for (const img of imgs) {
      if (img.offsetParent === null) continue;
      const src = img.currentSrc || img.src || '';
      for (let i = 0; i < src.length && i < 300; i += 7) mix(src.charCodeAt(i));
      mix(img.naturalWidth);
      mix(img.naturalHeight);
      sampled = true;
    }

    if (!sampled && document.body) {
      const text = document.body.innerText || '';
      mix(text.length);
      for (let i = 0; i < text.length && i < 500; i += 11) mix(text.charCodeAt(i));
    }

    return hash.toString(36);
  }

  /**
   * After triggering a page turn, wait until the content signature differs
   * from `prevSig` and then stays identical across two consecutive samples
   * (i.e. the new page has finished rendering). Resolves early as soon as
   * the page is stable — no fixed delay wasted on fast machines.
   */
  async function waitForPageChange(prevSig, timeoutMs) {
    const POLL_MS = 250;
    const deadline = Date.now() + timeoutMs;
    let lastSig = null;
    let changed = false;

    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      const sig = getContentSignature();
      if (sig !== prevSig) {
        changed = true;
        if (sig === lastSig && isContentRendered()) {
          return { changed: true, stable: true };
        }
      }
      lastSig = sig;
    }
    return { changed, stable: false };
  }

  /**
   * Check if all visible images appear to be loaded.
   */
  function areImagesLoaded() {
    const images = document.querySelectorAll('img');
    for (const img of images) {
      if (img.offsetParent !== null && !img.complete) {
        return false;
      }
    }
    return true;
  }

  /**
   * Check if the Kindle reader content appears to be actually rendered
   * (not a blank/loading state). Examines canvas pixels and loading overlays.
   */
  function isContentRendered() {
    // Check canvas elements - Kindle uses canvas for page rendering
    const canvases = document.querySelectorAll('canvas');
    for (const canvas of canvases) {
      if (canvas.offsetParent === null) continue; // not visible
      if (canvas.width === 0 || canvas.height === 0) return false;
      // Sample a few pixels to check if canvas has actual content
      try {
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        const w = canvas.width;
        const h = canvas.height;
        const points = [
          [Math.floor(w / 2), Math.floor(h / 2)],
          [Math.floor(w / 4), Math.floor(h / 4)],
          [Math.floor(3 * w / 4), Math.floor(3 * h / 4)],
        ];
        let hasContent = false;
        for (const [x, y] of points) {
          const pixel = ctx.getImageData(x, y, 1, 1).data;
          // Non-white, non-transparent pixel means content is rendered
          if (pixel[3] > 0 && (pixel[0] < 250 || pixel[1] < 250 || pixel[2] < 250)) {
            hasContent = true;
            break;
          }
        }
        if (!hasContent) return false;
      } catch {
        // Canvas may be cross-origin; skip check
      }
    }

    // Check for loading spinners/overlays
    const loadingSelectors = [
      '[class*="loading"]',
      '[class*="spinner"]',
      '[class*="overlay"]',
    ];
    for (const sel of loadingSelectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null &&
          getComputedStyle(el).display !== 'none' &&
          getComputedStyle(el).visibility !== 'hidden') {
        const text = el.textContent || '';
        if (text.includes('loading') || text.includes('読み込み') || el.children.length === 0) {
          return false;
        }
      }
    }

    return areImagesLoaded();
  }

  /**
   * Try to extract current page/location info from the reader UI.
   */
  function getPageInfo() {
    const selectors = [
      '#kindleReader_footer',
      '[class*="progress"]',
      '[class*="location"]',
      '[class*="page"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) {
        return el.textContent.trim();
      }
    }
    return null;
  }

  // Message listener for commands from service worker
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'turnPage' || msg.action === 'turnPageClick') {
      const direction = msg.direction || 'next';
      const timeout = msg.timeout || 5000;
      const prevSig = getContentSignature();

      if (msg.action === 'turnPage') {
        simulateKey(direction === 'next' ? 'ArrowRight' : 'ArrowLeft');
      } else {
        clickPageTurn(direction);
      }

      waitForPageChange(prevSig, timeout).then((result) => {
        sendResponse({ success: true, ...result, pageInfo: getPageInfo() });
      });
      return true; // Keep message channel open for async response
    }

    if (msg.action === 'getSignature') {
      sendResponse({ signature: getContentSignature() });
      return false;
    }

    if (msg.action === 'isContentReady') {
      sendResponse({ ready: isContentRendered() });
      return false;
    }

    if (msg.action === 'getPageInfo') {
      sendResponse({ pageInfo: getPageInfo() });
      return false;
    }

    if (msg.action === 'ping') {
      sendResponse({ ready: true });
      return false;
    }
  });
})();
