/**
 * What the Sources view remembers across a reload of the inspector, in this browser only:
 * breakpoints, which targets were connected, the open file and the pane layout.
 * Every access is guarded; a private window or blocked storage just means nothing is remembered.
 */

export interface StoredBreakpoint {
  file: string;
  line: number;
}

export type StoredTarget = { kind: 'server'; app: string } | { kind: 'page'; url: string };

export interface StoredLayout {
  treeOpen: boolean;
  panelOpen: boolean;
  treeWidth: number;
  panelWidth: number;
}

export interface StoredFile {
  file: string;
  line?: number;
}

const KEYS = {
  breakpoints: 'qaisdebugs.breakpoints',
  targets: 'qaisdebugs.targets',
  layout: 'qaisdebugs.layout',
  file: 'qaisdebugs.file',
} as const;

export const DEFAULT_LAYOUT: StoredLayout = { treeOpen: true, panelOpen: true, treeWidth: 260, panelWidth: 360 };

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);

    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: nothing to remember.
  }
}

export const storage = {
  breakpoints: (): StoredBreakpoint[] => read<StoredBreakpoint[]>(KEYS.breakpoints, []).filter((entry) => typeof entry.file === 'string' && typeof entry.line === 'number'),
  saveBreakpoints: (list: StoredBreakpoint[]): void => write(KEYS.breakpoints, list),
  targets: (): StoredTarget[] => read<StoredTarget[]>(KEYS.targets, []),
  saveTargets: (list: StoredTarget[]): void => write(KEYS.targets, list),
  layout: (): StoredLayout => ({ ...DEFAULT_LAYOUT, ...read<Partial<StoredLayout>>(KEYS.layout, {}) }),
  saveLayout: (layout: StoredLayout): void => write(KEYS.layout, layout),
  file: (): StoredFile | undefined => read<StoredFile | undefined>(KEYS.file, undefined),
  saveFile: (file: StoredFile | undefined): void => write(KEYS.file, file ?? null),
};
