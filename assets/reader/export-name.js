(function (global, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (global) global.MicroPaperExportNames = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const DEFAULT_TEMPLATE = 'reader.html';
  const TOKENS = ['year', 'title', 'titleEn', 'titleZh', 'date', 'documentId'];
  const MAX_FILENAME_BYTES = 240;
  const byteLength = text => new TextEncoder().encode(text).length;
  function trimBytes(text, limit) {
    let result = '';
    for (const char of text) {
      if (byteLength(result + char) > limit) break;
      result += char;
    }
    return result;
  }
  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  function generatedDate(paper, override) {
    const value = override === undefined ? paper?.readerSettings?.generatedDate : override;
    if (value !== undefined && !validDate(value)) throw Error('生成日期须为有效的 YYYY-MM-DD');
    return value || new Date().toISOString().slice(0, 10);
  }
  function sanitizeFilename(value, fallback = 'reader') {
    let base = typeof value === 'string' ? value.normalize('NFC') : '';
    base = base.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
      .replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim()
      .replace(/^[. ]+|[. ]+$/g, '').replace(/\.(?:html?)$/i, '').replace(/[. ]+$/g, '');
    if (!base) base = fallback;
    if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(base)) base = '_' + base;
    base = trimBytes(base, MAX_FILENAME_BYTES - 5).replace(/[. ]+$/g, '') || fallback;
    return base + '.html';
  }
  function metadataValues(paper, date) {
    const metadata = paper?.metadata || {};
    const text = value => typeof value === 'string' && value.trim() ? value.trim() : '';
    const titleEn = text(metadata.titleEn), titleZh = text(metadata.titleZh);
    const year = [metadata.year, metadata.publicationYear].map(value => String(value ?? '').trim()).find(value => /^(?:1|2)\d{3}$/.test(value)) || '';
    return {
      year: year || 'unknown-year',
      title: titleEn || titleZh || 'untitled-paper',
      titleEn: titleEn || 'untitled-paper',
      titleZh: titleZh || 'untitled-paper',
      date,
      documentId: text(paper?.documentId) || 'paper',
      missing: {year: !year, title: !titleEn && !titleZh, titleEn: !titleEn, titleZh: !titleZh, documentId: !text(paper?.documentId)}
    };
  }
  function renderFilename(template, paper, dateOverride) {
    if (template !== undefined && typeof template !== 'string') throw Error('文件名模板须为文本');
    template = template?.trim() || DEFAULT_TEMPLATE;
    if (template.length > 500) throw Error('文件名模板过长（最多 500 个字符）');
    const date = generatedDate(paper, dateOverride), values = metadataValues(paper, date), missing = new Set();
    const expanded = template.replace(/\{([^{}]+)\}/g, (_, token) => {
      if (!TOKENS.includes(token)) throw Error('不支持的占位符 {' + token + '}');
      if (values.missing[token]) missing.add(token);
      return values[token];
    });
    // Unpaired braces are usually a mistyped token, so require a reviewable correction.
    if (/[{}]/.test(template.replace(/\{([^{}]+)\}/g, ''))) throw Error('占位符括号不完整');
    return {template, date, filename: sanitizeFilename(expanded), missing: [...missing]};
  }
  function filenameKey(name) { return name.normalize('NFC').toLocaleLowerCase('en-US'); }
  function collisionFilename(name, number) {
    const safe = sanitizeFilename(name);
    if (number < 2) return safe;
    const suffix = ' (' + number + ').html';
    return trimBytes(safe.slice(0, -5), MAX_FILENAME_BYTES - byteLength(suffix)).replace(/[. ]+$/g, '') + suffix;
  }
  function unusedFilename(name, used) {
    let number = 1, candidate = collisionFilename(name, number);
    while (used.has(filenameKey(candidate))) candidate = collisionFilename(name, ++number);
    return candidate;
  }
  const jsonScriptData=value=>JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  function htmlWithSettings(originalHtml, paper, template, date, notesEnvelope) {
    const copy = JSON.parse(JSON.stringify(paper));
    copy.readerSettings = {...copy.readerSettings, exportFilenameTemplate: template, generatedDate: date};
    const data = jsonScriptData(copy);
    const pattern = /(<script\b[^>]*\sid\s*=\s*["']paper-data["'][^>]*>)[\s\S]*?(<\/script\s*>)/gi;
    let count = 0;
    let html = originalHtml.replace(pattern, (_, start, end) => { count++; return start + data + end; });
    if (count !== 1) throw Error('无法核实 HTML 数据槽，已停止下载');
    if (notesEnvelope !== undefined) {
      if (notesEnvelope !== null && (!notesEnvelope || notesEnvelope.format !== 'micro-paper-notes' || notesEnvelope.schemaVersion !== 1 || typeof notesEnvelope.documentId !== 'string' || typeof notesEnvelope.sourceSha256 !== 'string' || typeof notesEnvelope.contentFingerprint !== 'string' || !Array.isArray(notesEnvelope.annotations))) throw Error('无法核实笔记快照，已停止下载');
      const notesData = jsonScriptData(notesEnvelope);
      const notesPattern = /(<script\b[^>]*\sid\s*=\s*["']embedded-notes["'][^>]*>)[\s\S]*?(<\/script\s*>)/gi;
      let notesCount = 0;
      html = html.replace(notesPattern, (_, start, end) => {notesCount++; return start + notesData + end;});
      if (notesCount > 1) throw Error('笔记数据槽重复，已停止下载');
      if (!notesCount) {
        // Keep raw script delimiters out of this helper's own inline source.
        const slot = '<' + 'script type="application/json" id="embedded-notes">' + notesData + '<' + '/script>';
        if (/<\/body\s*>/i.test(html)) html = html.replace(/<\/body\s*>/i, end => slot + end);
        else if (/<\/html\s*>/i.test(html)) html = html.replace(/<\/html\s*>/i, end => slot + end);
        else throw Error('无法核实笔记数据槽，已停止下载');
      }
    }
    return html;
  }
  function createExportNames({paper, originalHtml, download, toast, onSettingsChange, getEnvelope, getAnnotations}) {
    const ids = ['export-dialog', 'export-form', 'export-template', 'export-name', 'export-preview', 'export-warning', 'export-reset', 'export-confirm'];
    const elements = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
    for (const id of ids) if (!elements[id]) throw Error('缺少导出控件：' + id);
    const dialog = elements['export-dialog'], templateInput = elements['export-template'], nameInput = elements['export-name'];
    const preview = elements['export-preview'], warning = elements['export-warning'], confirm = elements['export-confirm'];
    const date = generatedDate(paper), used = new Set();
    let template = paper.readerSettings?.exportFilenameTemplate || DEFAULT_TEMPLATE, current = null;
    const diskNotice = '本次会话重名会添加序号；浏览器决定磁盘保存位置。若磁盘已有同名文件，请选择新名称，或在浏览器保存提示中明确确认覆盖。';
    function update(fromTemplate) {
      try {
        const rendered = renderFilename(templateInput.value, paper, date);
        if (fromTemplate) nameInput.value = rendered.filename;
        const sanitized = sanitizeFilename(nameInput.value);
        const filename = unusedFilename(sanitized, used);
        current = {...rendered, filename};
        preview.textContent = filename;
        const details = [];
        if (rendered.missing.length) details.push('缺少元数据：' + rendered.missing.map(token => '{' + token + '}').join('、') + '；已使用回退名称。');
        if (filename !== sanitized) details.push('本次会话已下载同名文件，预览已添加序号。');
        if (sanitized !== nameInput.value) details.push('名称已清理非法字符并保留 .html 后缀。');
        warning.textContent = [...details, diskNotice].join(' ');
        confirm.disabled = false;
      } catch (error) {
        current = null;
        preview.textContent = '请修正模板后再下载';
        warning.textContent = error.message + '。 ' + diskNotice;
        confirm.disabled = true;
      }
    }
    templateInput.addEventListener('input', () => update(true));
    nameInput.addEventListener('input', () => update(false));
    elements['export-reset'].addEventListener('click', () => {templateInput.value = DEFAULT_TEMPLATE; update(true);});
    elements['export-form'].addEventListener('submit', event => {
      event.preventDefault();
      update(false);
      if (!current) return;
      try {
        // Read at confirmation time, then serialize immediately from the pristine file.
        let notes;
        if (typeof getEnvelope === 'function') {notes = getEnvelope(); if (notes === undefined || notes === null) throw Error('无法核实笔记快照，已停止下载');}
        else if (typeof getAnnotations === 'function') notes = {format:'micro-paper-notes',schemaVersion:1,documentId:paper.documentId,sourceSha256:paper.sourceSha256,contentFingerprint:paper.contentFingerprint,exportedAt:new Date().toISOString(),annotations:getAnnotations()};
        const html = htmlWithSettings(originalHtml, paper, current.template, date, notes);
        download(current.filename, html, 'text/html');
        used.add(filenameKey(current.filename));
        template = current.template;
        paper.readerSettings = {...paper.readerSettings, exportFilenameTemplate: template, generatedDate: date};
        if (onSettingsChange) onSettingsChange(paper.readerSettings);
        nameInput.value = current.filename;
        dialog.close();
        toast('已请求下载 ' + current.filename + '；保存位置与覆盖提示由浏览器控制');
      } catch (error) {warning.textContent = error.message;}
    });
    return {open() {templateInput.value = template; update(true); dialog.showModal();}, date};
  }
  return {DEFAULT_TEMPLATE, TOKENS, MAX_FILENAME_BYTES, validDate, generatedDate, sanitizeFilename, renderFilename, filenameKey, collisionFilename, unusedFilename, htmlWithSettings, createExportNames};
});
