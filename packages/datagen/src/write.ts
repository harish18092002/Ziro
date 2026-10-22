import { closeSync, existsSync, mkdirSync, openSync, readdirSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { outputFiles } from './render/files.js';
import type { Dataset } from './world/types.js';

const FLUSH_AT = 1 << 20;

function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
}

/**
 * Streams every output file into `dir`. Refuses a non-empty directory unless `force` is set, so a
 * mistyped --out cannot silently clobber another dataset. Returns the files written.
 */
export function writeDataset(
  dir: string,
  data: Dataset,
  options: { force?: boolean } = {},
): string[] {
  if (existsSync(dir) && readdirSync(dir).length > 0 && !options.force) {
    throw new Error(`${dir} is not empty; choose another --out or pass --force to overwrite`);
  }
  mkdirSync(dir, { recursive: true });

  const written: string[] = [];
  for (const file of outputFiles(data)) {
    const fd = openSync(join(dir, file.name), 'w');
    try {
      let buffer = '';
      for (const chunk of file.chunks()) {
        buffer += chunk;
        if (buffer.length >= FLUSH_AT) {
          writeAll(fd, buffer);
          buffer = '';
        }
      }
      if (buffer.length > 0) writeAll(fd, buffer);
    } finally {
      closeSync(fd);
    }
    written.push(file.name);
  }
  return written;
}
