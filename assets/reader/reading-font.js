/* Article-local reading type size. No note data, DOM text or page scale is changed. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MicroPaperReadingFont = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const MIN_SIZE = 14, MAX_SIZE = 26, DEFAULT_SIZE = 18, STEP = 1;
  const PROPERTY = '--reading-font-size';
  const clamp = n => Math.max(MIN_SIZE, Math.min(MAX_SIZE, n));
  function normalizeSize(value, fallback = DEFAULT_SIZE) {
    const safeFallback = typeof fallback === 'number' && Number.isFinite(fallback)
      ? clamp(Math.round(fallback)) : DEFAULT_SIZE;
    return typeof value === 'number' && Number.isFinite(value)
      ? clamp(Math.round(value)) : safeFallback;
  }
  function nextSize(current, direction) {
    return normalizeSize(normalizeSize(current) + Math.sign(Number(direction) || 0) * STEP);
  }
  function preferenceKey(paper) {
    if (typeof paper?.documentId !== 'string' || !paper.documentId ||
        typeof paper?.sourceSha256 !== 'string' || !paper.sourceSha256) return null;
    // Tuple encoding keeps identities containing punctuation unambiguous.
    return 'micro-paper:reading-font:v1:' + JSON.stringify([paper.documentId, paper.sourceSha256]);
  }
  function readStoredSize(raw, fallback = DEFAULT_SIZE) {
    try {
      const value = JSON.parse(raw);
      return value?.schemaVersion === 1 && Number.isInteger(value.fontSize) &&
        value.fontSize >= MIN_SIZE && value.fontSize <= MAX_SIZE
        ? value.fontSize : normalizeSize(fallback);
    } catch (_) {return normalizeSize(fallback);}
  }

  function create(options = {}) {
    const doc = options.document || (typeof document === 'object' ? document : null);
    const win = options.window || doc?.defaultView;
    if (!doc?.documentElement || !win) throw TypeError('Reading font requires a browser document');
    const find = (value, selector) => value || doc.querySelector(selector);
    const smaller = find(options.decreaseButton, '#reading-font-decrease');
    const larger = find(options.increaseButton, '#reading-font-increase');
    const status = find(options.status, '#reading-font-status');
    const article = find(options.article, '#article');
    const legend = find(options.legend, '#figure-caption-content');
    const pane = find(options.figurePane, '#figure-pane');
    const toolbar = find(options.toolbar, '.toolbar');
    const key = preferenceKey(options.paper);
    let size = normalizeSize(options.paper?.readerSettings?.readingFontSize);
    let storage, storageFailed = false, destroyed = false;
    const listeners = [];
    function storageFailure(error) {
      if (storageFailed) return;
      storageFailed = true;
      options.onStorageError?.(error);
    }
    if (key) {
      try {
        storage = Object.prototype.hasOwnProperty.call(options, 'storage') ? options.storage : win.localStorage;
        if (storage) size = readStoredSize(storage.getItem(key), size);
      } catch (error) {storageFailure(error);}
    }
    function visible(element) {return Boolean(element?.getClientRects().length);}
    function toolbarBottom() {
      return Math.max(0, toolbar?.getBoundingClientRect().bottom || 0);
    }
    function rangeAt(prose, x, y) {
      // A Range follows the same character when line wrapping changes. It does
      // not insert markers into canonical text or the annotation coordinate space.
      try {
        let range;
        if (doc.caretPositionFromPoint) {
          const caret = doc.caretPositionFromPoint(x, y);
          if (caret) {range = doc.createRange(); range.setStart(caret.offsetNode, caret.offset); range.collapse(true);}
        } else if (doc.caretRangeFromPoint) range = doc.caretRangeFromPoint(x, y);
        if (!range || !prose.contains(range.startContainer)) return null;
        const text = range.startContainer, offset = range.startOffset;
        if (text.nodeType === 3 && text.length) {
          const start = Math.min(offset, text.length - 1);
          range.setStart(text, start); range.setEnd(text, start + 1);
        }
        return range.getClientRects().length ? range : null;
      } catch (_) {return null;}
    }
    function capture(root, top, bottom) {
      if (!visible(root) || bottom <= top) return null;
      for (const prose of root.querySelectorAll('.prose[data-block-id][data-language]')) {
        if (!visible(prose)) continue;
        const rect = prose.getBoundingClientRect();
        if (rect.bottom <= top || rect.top >= bottom) continue;
        const x = Math.min(rect.right - 1, rect.left + Math.min(28, rect.width / 2));
        const y = Math.min(rect.bottom - 1, Math.max(rect.top + 2, top + 2));
        const range = rangeAt(prose, x, y);
        if (range) return {range, top:range.getBoundingClientRect().top};
        // Engines without point-to-caret support still retain the visible
        // paragraph and its relative reading position through reflow.
        const fraction = Math.max(0, Math.min(1, (top - rect.top) / Math.max(1, rect.height)));
        return {element:prose, fraction, top:rect.top + fraction * rect.height};
      }
      return null;
    }
    function captureAnchors() {
      const height = win.innerHeight || doc.documentElement.clientHeight;
      const page = capture(article, toolbarBottom() + 12, height - 8);
      if (!visible(pane)) return {page};
      const rect = pane.getBoundingClientRect();
      const controls = pane.querySelector('.figure-controls');
      const top = Math.max(toolbarBottom(), rect.top, controls?.getBoundingClientRect().bottom || rect.top) + 10;
      return {page, paneScroll:pane.scrollTop,
        figure:capture(legend, top, Math.min(height - 8, rect.bottom - 8))};
    }
    function anchorDelta(anchor) {
      if (!anchor) return 0;
      if (anchor.range) {
        if (anchor.range.startContainer.isConnected === false) return 0;
        return anchor.range.getBoundingClientRect().top - anchor.top;
      }
      if (anchor.element.isConnected === false) return 0;
      const rect = anchor.element.getBoundingClientRect();
      return rect.top + anchor.fraction * rect.height - anchor.top;
    }
    function restoreAnchors(anchors) {
      const delta = anchorDelta(anchors.page);
      if (Math.abs(delta) > .5) win.scrollBy({top:delta, left:0, behavior:'instant'});
      if (anchors.paneScroll !== undefined) {
        if (anchors.figure) pane.scrollTop += anchorDelta(anchors.figure);
        else pane.scrollTop = anchors.paneScroll;
      }
    }
    function syncControls() {
      for (const [button, decrease] of [[smaller, true], [larger, false]]) {
        if (!button) continue;
        button.disabled = decrease ? size <= MIN_SIZE : size >= MAX_SIZE;
        button.setAttribute('aria-label', (decrease ? '减小' : '增大') + '正文字号，当前 ' + size + ' 像素');
        button.title = button.disabled ? '已到' + (decrease ? '最小' : '最大') + '字号（' + size + 'px）'
          : (decrease ? '减小' : '增大') + '正文字号';
      }
      if (status) status.textContent = '正文及图注字号：' + size + 'px';
    }
    function layout() {options.measureToolbar?.(); options.refreshImages?.();}
    function setSize(value, settings = {}) {
      if (destroyed) return size;
      const next = normalizeSize(value, size);
      if (next === size) return size;
      const anchors = settings.preserveAnchor === false ? null : captureAnchors();
      size = next;
      doc.documentElement.style.setProperty(PROPERTY, size + 'px');
      syncControls();
      layout();
      if (anchors) restoreAnchors(anchors);
      options.measureToolbar?.();
      options.queueFollow?.();
      if (settings.persist !== false && key && storage) {
        try {storage.setItem(key, JSON.stringify({schemaVersion:1, fontSize:size}));}
        catch (error) {storageFailure(error);}
      }
      options.onChange?.(size);
      return size;
    }
    function step(direction) {return setSize(nextSize(size, direction));}
    function listen(element, handler) {
      if (!element) return;
      element.addEventListener('click', handler);
      listeners.push(() => element.removeEventListener('click', handler));
    }
    listen(smaller, () => step(-1));
    listen(larger, () => step(1));
    doc.documentElement.style.setProperty(PROPERTY, size + 'px');
    syncControls();
    layout();
    options.onChange?.(size);
    return {
      getSize:() => size,
      getSettings:() => ({readingFontSize:size}),
      setSize, step,
      getStorageKey:() => key,
      destroy() {if (!destroyed) {destroyed = true; listeners.forEach(remove => remove());}}
    };
  }
  return {create, normalizeSize, nextSize, preferenceKey, readStoredSize,
    MIN_SIZE, MAX_SIZE, DEFAULT_SIZE, STEP};
});
