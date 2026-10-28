/** The Sources view's keyboard shortcuts: Cmd on macOS, Ctrl elsewhere, like an IDE. */

export type Shortcut = 'quickOpen' | 'find' | 'goToLine' | 'searchProject';

export interface KeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function isMacPlatform(): boolean {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;

  return /mac|iphone|ipad/i.test(platform);
}

export function shortcutFor(event: KeyInput, isMac: boolean): Shortcut | undefined {
  const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod || event.altKey) return undefined;
  const key = event.key.toLowerCase();

  if (event.shiftKey) return key === 'f' ? 'searchProject' : undefined;
  if (key === 'p') return 'quickOpen';
  if (key === 'f') return 'find';
  if (key === 'g') return 'goToLine';

  return undefined;
}

/** How a shortcut is written on this platform: `⌘P` on a Mac, `Ctrl+P` elsewhere. */
export function shortcutLabel(shortcut: Shortcut, isMac: boolean): string {
  const keys = { quickOpen: 'P', find: 'F', goToLine: 'G', searchProject: 'F' }[shortcut];
  const shift = shortcut === 'searchProject';
  if (isMac) return `${shift ? '⇧' : ''}⌘${keys}`;

  return `Ctrl+${shift ? 'Shift+' : ''}${keys}`;
}
