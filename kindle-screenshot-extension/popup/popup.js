'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  pageDirection: $('pageDirection'),
  startPage: $('startPage'),
  endPage: $('endPage'),
  zoomLevel: $('zoomLevel'),
  delay: $('delay'),
  startBtn: $('startBtn'),
  stopBtn: $('stopBtn'),
  progressSection: $('progressSection'),
  progressBar: $('progressBar'),
  progressText: $('progressText'),
  statusBar: $('status-bar'),
  statusText: $('status-text'),
  settingsPanel: $('settings-panel'),
  errorText: $('errorText'),
};

function showError(msg) {
  els.errorText.textContent = msg;
  els.errorText.classList.remove('hidden');
}

function clearError() {
  els.errorText.textContent = '';
  els.errorText.classList.add('hidden');
}

function setStatus(msg, isError = false) {
  els.statusBar.classList.remove('hidden', 'error');
  if (isError) els.statusBar.classList.add('error');
  els.statusText.textContent = msg;
}

function updateProgress(current, total) {
  els.progressSection.classList.remove('hidden');
  const pct = Math.round((current / total) * 100);
  els.progressBar.style.width = pct + '%';
  els.progressText.textContent = `${current} / ${total} ページ撮影完了`;
}

function setRunningUI(running) {
  els.startBtn.classList.toggle('hidden', running);
  els.stopBtn.classList.toggle('hidden', !running);
  els.pageDirection.disabled = running;
  els.startPage.disabled = running;
  els.endPage.disabled = running;
  els.zoomLevel.disabled = running;
  els.delay.disabled = running;
}

// Restore state on popup open
chrome.runtime.sendMessage({ action: 'getStatus' }, (res) => {
  if (chrome.runtime.lastError || !res) return;
  if (res.isRunning) {
    setRunningUI(true);
    setStatus('撮影中...');
    updateProgress(res.currentPage - res.startPage, res.totalPages);
  }
});

// Listen for progress updates from service worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'progress') {
    updateProgress(msg.captured, msg.total);
    setStatus(`撮影中... (${msg.captured}/${msg.total})`);
  } else if (msg.action === 'captureComplete') {
    setRunningUI(false);
    setStatus('PDF生成中...');
  } else if (msg.action === 'downloadReady') {
    setRunningUI(false);
    setStatus('ダウンロード完了!');
    updateProgress(msg.total, msg.total);
  } else if (msg.action === 'captureError') {
    setRunningUI(false);
    setStatus(msg.error, true);
  } else if (msg.action === 'captureStopped') {
    setRunningUI(false);
    setStatus('撮影を停止しました');
  }
});

els.startBtn.addEventListener('click', () => {
  clearError();

  const pageDirection = els.pageDirection.value;
  const startPage = parseInt(els.startPage.value, 10);
  const endPage = parseInt(els.endPage.value, 10);
  const zoomLevel = parseFloat(els.zoomLevel.value);
  const delay = parseInt(els.delay.value, 10);

  if (isNaN(startPage) || isNaN(endPage) || startPage < 1 || endPage < 1) {
    showError('ページ番号を正しく入力してください');
    return;
  }
  if (startPage > endPage) {
    showError('開始ページは終了ページ以下にしてください');
    return;
  }
  if (isNaN(delay) || delay < 500) {
    showError('撮影間隔は500ms以上にしてください');
    return;
  }

  setRunningUI(true);
  setStatus('撮影準備中...');
  updateProgress(0, endPage - startPage + 1);

  chrome.runtime.sendMessage({
    action: 'startCapture',
    pageDirection,
    startPage,
    endPage,
    zoomLevel,
    delay,
  }, (res) => {
    if (chrome.runtime.lastError) {
      showError('Service Workerとの通信に失敗しました');
      setRunningUI(false);
      return;
    }
    if (res && res.error) {
      showError(res.error);
      setRunningUI(false);
    }
  });
});

els.stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'stopCapture' });
  setRunningUI(false);
  setStatus('停止を要求しました...');
});
