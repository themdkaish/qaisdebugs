/**
 * What the Sources view remembers across a reload of the inspector, in this browser only:
 * breakpoints, which targets were connected, the project shown, its open tabs and the pane layout.
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

export interface StoredTabs {
  files: string[];
  active?: string;
}

const KEYS = {
  breakpoints: 'qaisdebugs.breakpoints',
  targets: 'qaisdebugs.targets',
  layout: 'qaisdebugs.layout',
  file: 'qaisdebugs.file',
  tabs: 'qaisdebugs.tabs',
  project: 'qaisdebugs.project',
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
  /** The open tabs of each project, by project root ('' for the inspector's own project). */
  tabs: (project: string): StoredTabs | undefined => {
    const saved = read<Record<string, StoredTabs>>(KEYS.tabs, {})[project];

    return saved && Array.isArray(saved.files) ? { files: saved.files.filter((file) => typeof file === 'string'), active: saved.active } : undefined;
  },
  saveTabs: (project: string, tabs: StoredTabs): void => write(KEYS.tabs, { ...read<Record<string, StoredTabs>>(KEYS.tabs, {}), [project]: tabs }),
  project: (): string | undefined => read<string | undefined>(KEYS.project, undefined) ?? undefined,
  saveProject: (root: string): void => write(KEYS.project, root),
};
