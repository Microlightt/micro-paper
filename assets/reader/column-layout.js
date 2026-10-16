/* Independent reading-column layout. No profile, note or storage access. */
(function (global) {
  'use strict';
  const BREAKPOINT = 800, HANDLE = 12;
  const clamp = (n, low, high) => Math.min(high, Math.max(low, n));
  const finite = (n, fallback) => typeof n === 'number' && Number.isFinite(n) ? n : fallback;

  function create(options) {
    const root = options?.root, reader = options?.reader;
    if (!root || !reader || reader.parentElement !== root) throw new TypeError('Columns require main and its reader-view child');
    const doc = root.ownerDocument, win = doc.defaultView || global;
    const sidebar = root.querySelector('#sidebar'), article = reader.querySelector('#article'), figure = reader.querySelector('#figure-pane');
    if (!sidebar || !article || !figure) throw new TypeError('Columns require sidebar, article and figure-pane');
    const listeners = [], made = [], savedHandles = [], html = doc.documentElement;
    const previousClass = root.classList.contains('micro-paper-columns');
    const previousMode = root.getAttribute('data-columns-mode');
    const vars = ['--sidebar-width', '--article-fraction', '--article-track', '--figure-track', '--column-splitter-size'];
    const savedVars = vars.map(key => [key, root.style.getPropertyValue(key), root.style.getPropertyPriority(key)]);
    const seed = options.settings || {};
    let preferences = {sidebarWidth: finite(seed.sidebarWidth, null), articleFraction: clamp(finite(seed.articleFraction, .5), 0, 1)};
    let current = null, active = null, destroyed = false, frame = null, signature = '', refreshing = false;
    const raf = fn => win.requestAnimationFrame(fn);

    function listen(target, name, fn, config) {
      target.addEventListener(name, fn, config);
      listeners.push(() => target.removeEventListener(name, fn, config));
    }
    function handle(id, parent, before, label, controls) {
      let node = parent.querySelector('#' + id);
      if (!node) {node = doc.createElement('div'); node.id = id; parent.insertBefore(node, before); made.push(node);}
      const attributes = ['class', 'role', 'tabindex', 'aria-label', 'aria-controls', 'aria-orientation', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext', 'aria-disabled', 'title', 'hidden'];
      savedHandles.push([node, attributes.map(a => [a, node.getAttribute(a)])]);
      node.classList.add('column-splitter');
      for (const [key, value] of Object.entries({role:'separator', tabindex:'0', 'aria-orientation':'vertical', 'aria-label':label, 'aria-controls':controls, title:label + '；方向键调整，Home/End 到边界，双击恢复默认'})) node.setAttribute(key, value);
      return node;
    }
    const sidebarHandle = handle('sidebar-splitter', root, reader, '调整目录宽度', 'sidebar');
    const figureHandle = handle('figure-splitter', reader, figure, '调整正文与图栏宽度', 'article figure-pane');
    root.classList.add('micro-paper-columns');

    function snapshot() {
      if (!current) return null;
      return {...current, limits:{...current.limits}, dragging:active?.kind || null};
    }
    function finish() {
      if (!active) return;
      const old = active; active = null;
      if (!old.hadDragClass) html.classList.remove('micro-paper-columns-dragging');
      try {if (old.node.hasPointerCapture?.(old.pointerId)) old.node.releasePointerCapture(old.pointerId);} catch (_) { /* Already lost capture. */ }
    }
    function measure() {
      const style = win.getComputedStyle(root);
      const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      const contentWidth = Math.max(0, root.clientWidth - padding);
      const desktop = win.innerWidth > BREAKPOINT && contentWidth > 0;
      const enabled = desktop && !root.hidden && !reader.hidden && win.getComputedStyle(reader).display !== 'none';
      // The two handles replace, rather than supplement, the old grid gaps.
      const total = Math.max(0, contentWidth - 2 * HANDLE);
      const sidebarMin = Math.min(total, contentWidth >= 1000 ? 160 : 140);
      const articleMin = Math.min(280, Math.max(0, total - sidebarMin - 240));
      const figureMin = Math.min(240, Math.max(0, total - sidebarMin - articleMin));
      const sidebarMax = Math.max(sidebarMin, Math.min(420, total - articleMin - figureMin));
      const desired = preferences.sidebarWidth === null ? clamp(contentWidth * .15, sidebarMin, 210) : preferences.sidebarWidth;
      const sidebarWidth = clamp(desired, sidebarMin, sidebarMax);
      const available = Math.max(0, total - sidebarWidth);
      const articleWidth = clamp(available * preferences.articleFraction, Math.min(articleMin, available), Math.max(0, available - figureMin));
      const figureWidth = Math.max(0, available - articleWidth);
      const articleFraction = available ? articleWidth / available : .5;
      return {enabled, desktop, mode:!desktop ? 'mobile' : enabled ? 'reader' : 'other', contentWidth,
        sidebarWidth, articleWidth, figureWidth, articleFraction, readerWidth:available + HANDLE,
        limits:{sidebarMin, sidebarMax, articleMin, articleMax:Math.max(0, available - figureMin), figureMin}};
    }
    function refresh() {
      if (destroyed || refreshing) return snapshot();
      refreshing = true;
      try {
        current = measure();
        if (!current.enabled) finish();
        if (root.getAttribute('data-columns-mode') !== current.mode) root.setAttribute('data-columns-mode', current.mode);
        if (current.desktop) {
          const values = [current.sidebarWidth + 'px', String(current.articleFraction), current.articleFraction + 'fr', (1 - current.articleFraction) + 'fr', HANDLE + 'px'];
          vars.forEach((key, i) => {if (root.style.getPropertyValue(key) !== values[i]) root.style.setProperty(key, values[i]);});
        }
        for (const [node, kind] of [[sidebarHandle,'sidebar'], [figureHandle,'figure']]) {
          node.hidden = !current.enabled;
          node.setAttribute('tabindex', current.enabled ? '0' : '-1');
          node.setAttribute('aria-disabled', String(!current.enabled));
          const min = kind === 'sidebar' ? current.limits.sidebarMin : current.limits.articleMin;
          const max = kind === 'sidebar' ? current.limits.sidebarMax : current.limits.articleMax;
          const now = kind === 'sidebar' ? current.sidebarWidth : current.articleWidth;
          node.setAttribute('aria-valuemin', String(Math.round(min)));
          node.setAttribute('aria-valuemax', String(Math.round(max)));
          node.setAttribute('aria-valuenow', String(Math.round(now)));
          node.setAttribute('aria-valuetext', kind === 'sidebar' ? '目录 ' + Math.round(now) + ' 像素' : '正文 ' + Math.round(now) + ' 像素，图栏 ' + Math.round(current.figureWidth) + ' 像素');
        }
        const next = JSON.stringify([current.mode, current.contentWidth, current.sidebarWidth, current.articleWidth, current.figureWidth]);
        if (next !== signature) {signature = next; if (typeof options.onResize === 'function') options.onResize(snapshot());}
      } finally {refreshing = false;}
      return snapshot();
    }
    function schedule() {
      if (!destroyed && frame === null) frame = raf(() => {frame = null; refresh();});
    }
    function setWidth(kind, width) {
      if (kind === 'sidebar') preferences.sidebarWidth = clamp(width, current.limits.sidebarMin, current.limits.sidebarMax);
      else {
        const available = current.articleWidth + current.figureWidth;
        preferences.articleFraction = available ? clamp(width, current.limits.articleMin, current.limits.articleMax) / available : .5;
      }
      refresh();
    }
    function start(kind, node, event) {
      refresh();
      if (!current.enabled || active || event.button !== 0 || event.isPrimary === false || !Number.isFinite(event.clientX)) return;
      event.preventDefault();
      active = {kind, node, pointerId:event.pointerId, x:event.clientX,
        width:kind === 'sidebar' ? current.sidebarWidth : current.articleWidth,
        hadDragClass:html.classList.contains('micro-paper-columns-dragging')};
      html.classList.add('micro-paper-columns-dragging');
      node.focus({preventScroll:true});
      try {node.setPointerCapture(event.pointerId);} catch (_) { /* Window listeners remain usable. */ }
    }
    for (const [node, kind] of [[sidebarHandle,'sidebar'], [figureHandle,'figure']]) {
      listen(node, 'pointerdown', e => start(kind, node, e));
      listen(node, 'lostpointercapture', e => {if (active?.node === node && active.pointerId === e.pointerId) finish();});
      listen(node, 'dblclick', e => {if (current?.enabled) {e.preventDefault(); reset();}});
      listen(node, 'keydown', e => {
        refresh();
        if (!current.enabled || e.altKey || e.ctrlKey || e.metaKey || !['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
        e.preventDefault(); e.stopPropagation(); finish();
        const low = kind === 'sidebar' ? current.limits.sidebarMin : current.limits.articleMin;
        const high = kind === 'sidebar' ? current.limits.sidebarMax : current.limits.articleMax;
        const now = kind === 'sidebar' ? current.sidebarWidth : current.articleWidth;
        const step = e.shiftKey ? 40 : 10;
        setWidth(kind, e.key === 'Home' ? low : e.key === 'End' ? high : now + (e.key === 'ArrowRight' ? step : -step));
      });
    }
    listen(win, 'pointermove', e => {
      if (!active || e.pointerId !== active.pointerId || !Number.isFinite(e.clientX)) return;
      if (e.buttons === 0 || reader.hidden || root.hidden || win.innerWidth <= BREAKPOINT) {finish(); schedule(); return;}
      e.preventDefault(); setWidth(active.kind, active.width + e.clientX - active.x);
    }, {passive:false});
    for (const name of ['pointerup','pointercancel']) listen(win, name, e => {if (active?.pointerId === e.pointerId) finish();});
    listen(win, 'blur', finish);
    listen(win, 'resize', () => {finish(); schedule();});
    listen(doc, 'visibilitychange', () => {if (doc.hidden) finish();});
    const resizeObserver = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(schedule) : null;
    resizeObserver?.observe(root);
    const mutationObserver = typeof win.MutationObserver === 'function' ? new win.MutationObserver(() => {if (reader.hidden || root.hidden) finish(); schedule();}) : null;
    mutationObserver?.observe(reader, {attributes:true, attributeFilter:['hidden','class','style']});
    mutationObserver?.observe(root, {attributes:true, attributeFilter:['hidden']});
    function reset() {if (!destroyed) {finish(); preferences = {sidebarWidth:null, articleFraction:.5}; return refresh();}}
    function destroy() {
      if (destroyed) return;
      finish(); destroyed = true;
      if (frame !== null) {win.cancelAnimationFrame(frame); frame = null;}
      resizeObserver?.disconnect(); mutationObserver?.disconnect(); listeners.splice(0).forEach(remove => remove());
      savedHandles.forEach(([node, attributes]) => attributes.forEach(([key, value]) => value === null ? node.removeAttribute(key) : node.setAttribute(key, value)));
      made.forEach(node => node.remove());
      if (!previousClass) root.classList.remove('micro-paper-columns');
      if (previousMode === null) root.removeAttribute('data-columns-mode'); else root.setAttribute('data-columns-mode', previousMode);
      savedVars.forEach(([key, value, priority]) => value ? root.style.setProperty(key, value, priority) : root.style.removeProperty(key));
    }
    refresh();
    return {refresh, reset, destroy, getState:snapshot, getSettings:() => ({sidebarWidth:preferences.sidebarWidth, articleFraction:preferences.articleFraction})};
  }
  global.MicroPaperColumns = {create};
})(typeof window === 'undefined' ? globalThis : window);
