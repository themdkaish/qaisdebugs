import { findSourceMap } from 'node:module';
import { pathToFileURL } from 'node:url';

export interface MappedFrame {
  file: string;
  line: number;
  column: number;
}

/**
 * Maps a stack frame at a generated position to its original one through Node's source-map cache.
 *
 * With `--enable-source-maps`, Node keeps the map of every script it compiles that carries a
 * `sourceMappingURL`: webpack's eval'd modules (keyed by their `webpack-internal:///...` sourceURL)
 * and bundled chunk files such as Turbopack's `.next/dev/server/chunks/...` (keyed by file URL).
 * `line` and `column` are 1-based, as V8 prints them; the result is 1-based too, with `file`
 * exactly as the map names it (an absolute path, a `file://` URL or a `webpack://` name).
 */
export function mapGeneratedFrame(rawFile: string, line: number, column: number): MappedFrame | undefined {
  const map = lookup(rawFile);
  if (!map) return undefined;

  try {
    const origin = map.findOrigin(line, column) as { fileName?: string; lineNumber?: number; columnNumber?: number };
    if (origin.fileName && typeof origin.lineNumber === 'number') {
      return { file: origin.fileName, line: origin.lineNumber, column: origin.columnNumber ?? 1 };
    }
  } catch {
    // Fall through to the lower-level lookup.
  }

  try {
    const entry = map.findEntry(line - 1, column - 1) as { originalSource?: string; originalLine?: number; originalColumn?: number };
    if (entry.originalSource && typeof entry.originalLine === 'number') {
      return { file: entry.originalSource, line: entry.originalLine + 1, column: (entry.originalColumn ?? 0) + 1 };
    }
  } catch {
    // No usable mapping.
  }

  return undefined;
}

function lookup(rawFile: string): ReturnType<typeof findSourceMap> | undefined {
  const keys = [rawFile];
  if (rawFile.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rawFile)) {
    try {
      keys.push(pathToFileURL(rawFile).href);
    } catch {
      // Not a path after all.
    }
  }

  for (const key of keys) {
    try {
      const map = findSourceMap(key);
      if (map) return map;
    } catch {
      // Keep trying.
    }
  }

  return undefined;
}
