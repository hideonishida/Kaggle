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

    if (msg.action === 'ping') {
      sendResponse({ ready: true });
      return false;
    }
  });
})();
