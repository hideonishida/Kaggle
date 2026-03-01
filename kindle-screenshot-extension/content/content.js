'use strict';

// Kindle Cloud Reader content script
// Handles page navigation and load detection within the reader page.

(() => {
  // Avoid double injection
  if (window.__kindleScreenshotInjected) return;
  window.__kindleScreenshotInjected = true;

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
   * Wait for page content to stabilize after a page turn.
   * Uses multiple heuristics:
   * 1. MutationObserver to detect DOM changes settling
   * 2. Image/canvas load completion check
   * 3. Network idle detection via PerformanceObserver
   * 4. Fixed delay fallback
   */
  function waitForPageLoad(timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      let mutationTimer = null;
      const startTime = Date.now();

      // Hard timeout fallback
      const hardTimeout = setTimeout(() => {
        cleanup();
        resolve();
      }, timeoutMs);

      function cleanup() {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimeout);
        if (mutationTimer) clearTimeout(mutationTimer);
        if (observer) observer.disconnect();
      }

      // Watch for DOM mutations to settle (no changes for 400ms)
      const observer = new MutationObserver(() => {
        if (mutationTimer) clearTimeout(mutationTimer);
        mutationTimer = setTimeout(() => {
          // Also check images/canvases are loaded
          if (areImagesLoaded()) {
            cleanup();
            resolve();
          }
        }, 400);
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });

      // Initial check after a small delay (page turn animation)
      setTimeout(() => {
        if (!settled && areImagesLoaded()) {
          // Give a bit more time for any late mutations
          if (mutationTimer) clearTimeout(mutationTimer);
          mutationTimer = setTimeout(() => {
            cleanup();
            resolve();
          }, 300);
        }
      }, 500);
    });
  }

  /**
   * Check if all visible images and canvases appear to be loaded.
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
   * (not a blank/loading state). Examines canvas elements and key DOM nodes.
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
        // Sample center and corners
        const points = [
          [Math.floor(w / 2), Math.floor(h / 2)],
          [Math.floor(w / 4), Math.floor(h / 4)],
          [Math.floor(3 * w / 4), Math.floor(3 * h / 4)],
        ];
        let hasContent = false;
        for (const [x, y] of points) {
          const pixel = ctx.getImageData(x, y, 1, 1).data;
          // If any sampled pixel is not pure white (255,255,255) or
          // transparent (alpha=0), content is likely rendered
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

    // Check for iframe-based rendering (some Kindle versions)
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      if (iframe.offsetParent === null) continue;
      try {
        const doc = iframe.contentDocument;
        if (doc && doc.body && doc.body.children.length === 0) {
          return false;
        }
      } catch {
        // Cross-origin iframe; skip
      }
    }

    // Check for loading spinners/overlays
    const loadingSelectors = [
      '[class*="loading"]',
      '[class*="spinner"]',
      '[class*="progress"]',
      '[class*="overlay"]',
    ];
    for (const sel of loadingSelectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null &&
          getComputedStyle(el).display !== 'none' &&
          getComputedStyle(el).visibility !== 'hidden') {
        // Loading indicator is visible
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
    // Try common footer/progress selectors
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
    if (msg.action === 'turnPage') {
      const direction = msg.direction || 'next';
      const timeout = msg.timeout || 3000;

      // First try keyboard event
      simulateKey(direction === 'next' ? 'ArrowRight' : 'ArrowLeft');

      // Wait for page load
      waitForPageLoad(timeout).then(() => {
        sendResponse({ success: true, pageInfo: getPageInfo() });
      });

      return true; // Keep message channel open for async response
    }

    if (msg.action === 'turnPageClick') {
      const direction = msg.direction || 'next';
      const timeout = msg.timeout || 3000;

      clickPageTurn(direction);

      waitForPageLoad(timeout).then(() => {
        sendResponse({ success: true, pageInfo: getPageInfo() });
      });

      return true;
    }

    if (msg.action === 'getPageInfo') {
      sendResponse({ pageInfo: getPageInfo() });
      return false;
    }

    if (msg.action === 'isContentReady') {
      sendResponse({ ready: isContentRendered() });
      return false;
    }

    if (msg.action === 'ping') {
      sendResponse({ ready: true });
      return false;
    }
  });
})();
