/**
 * The editor tabs of the Sources view: which files are open, in which order, and what each tab
 * is called. Pure functions, so the rules are easy to test.
 */

export interface EditorTab {
  file: string;
  /** When the tab was last shown, so the oldest one makes room when there are too many. */
  usedAt: number;
}

/** Stepping through code opens a file per frame; past this many tabs, the least recently used one closes. */
export const MAX_TABS = 15;

/**
 * Shows `file`: an open tab is reused where it is, a new one goes right after the active tab.
 * Returns the tabs in display order.
 */
export function openTab(tabs: EditorTab[], file: string, active: string | undefined, now: number, max = MAX_TABS): EditorTab[] {
  if (tabs.some((tab) => tab.file === file)) return tabs.map((tab) => (tab.file === file ? { ...tab, usedAt: now } : tab));

  const activeIndex = tabs.findIndex((tab) => tab.file === active);
  const next = [...tabs];
  next.splice(activeIndex >= 0 ? activeIndex + 1 : next.length, 0, { file, usedAt: now });
  while (next.length > max) {
    const oldest = next.filter((tab) => tab.file !== file).reduce((a, b) => (b.usedAt < a.usedAt ? b : a));
    next.splice(next.indexOf(oldest), 1);
  }

  return next;
}

/** Closes `file`. Closing the active tab activates its right neighbour, else its left one, like an IDE. */
export function closeTab(tabs: EditorTab[], file: string, active: string | undefined): { tabs: EditorTab[]; active: string | undefined } {
  const index = tabs.findIndex((tab) => tab.file === file);
  if (index < 0) return { tabs, active };
  const next = tabs.filter((tab) => tab.file !== file);
  if (file !== active) return { tabs: next, active };

  return { tabs: next, active: (next[index] ?? next[index - 1])?.file };
}

export interface TabLabel {
  name: string;
  /** The folders that tell two tabs with the same name apart (`app/shop` for two `page.tsx`), or ''. */
  hint: string;
}

/** The label of each file: its name, plus just enough of its folder when another open file has the same name. */
export function tabLabels(files: string[]): Map<string, TabLabel> {
  const labels = new Map<string, TabLabel>();
  const segments = new Map(files.map((file) => [file, file.split('/').filter(Boolean)]));

  for (const file of files) {
    const own = segments.get(file) ?? [];
    const name = own[own.length - 1] ?? file;
    const twins = files.filter((other) => other !== file && (segments.get(other) ?? []).at(-1) === name);
    if (twins.length === 0) {
      labels.set(file, { name, hint: '' });
      continue;
    }

    // Add parent folders until no twin ends with the same ones.
    let depth = 1;
    const suffix = (parts: string[], count: number): string => parts.slice(-1 - count, -1).join('/');
    while (depth < own.length - 1 && twins.some((twin) => suffix(segments.get(twin) ?? [], depth) === suffix(own, depth))) depth += 1;
    labels.set(file, { name, hint: suffix(own, depth) });
  }

  return labels;
}
