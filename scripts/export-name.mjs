import {createRequire} from 'node:module';
import {open, readdir, link, unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
const require = createRequire(import.meta.url);
const names = require('../assets/reader/export-name.js');
export const {DEFAULT_TEMPLATE, TOKENS, validDate, generatedDate, sanitizeFilename, renderFilename, filenameKey, collisionFilename, unusedFilename} = names;

export function parseExportOptions(args) {
  const options = {preview: false};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--preview') options.preview = true;
    else if (arg === '--filename-template' || arg === '--date') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) throw Error('Missing value for ' + arg);
      options[arg === '--date' ? 'date' : 'template'] = value;
    } else throw Error('Unsupported package option: ' + arg);
  }
  if (options.date !== undefined && !validDate(options.date)) throw Error('Invalid --date; expected a real YYYY-MM-DD date');
  return options;
}

export async function previewNamedHtml(work, filename) {
  const used = new Set((await readdir(work)).map(filenameKey));
  const candidate = unusedFilename(filename, used);
  return {filename: candidate, output: resolve(work, candidate), renamed: candidate !== filename};
}

// Exclusive creation prevents races or a differently cased existing file from being overwritten.
export async function writeNamedHtml(work, filename, html) {
  const used = new Set((await readdir(work)).map(filenameKey));
  const temporary = resolve(work, '.micro-paper-' + randomUUID() + '.tmp');
  const file = await open(temporary, 'wx');
  try {
    await file.writeFile(html, 'utf8');
    await file.close();
    for (;;) {
      const candidate = unusedFilename(filename, used), path = resolve(work, candidate);
      try {
        // Linking a completed file publishes all bytes atomically and refuses an existing target.
        await link(temporary, path);
        return {filename: candidate, output: path, renamed: candidate !== filename};
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        used.add(filenameKey(candidate));
      }
    }
  } finally {
    await file.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}
