import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PropertyDescriptor, RemoteObject } from '../debugger/remoteObject';
import type { FindMatch } from './find';
import { type HoverTarget, HoverValue } from './HoverValue';
import { highlightLine } from './highlight';

interface CodeViewerProps {
  file?: string;
  content?: string;
  loading?: boolean;
  error?: string;
  /** 1-based line to scroll to and highlight softly. */
  focusLine?: number;
  /** Changes with each request to show `focusLine`, so asking for the same line twice still scrolls. */
  focusNonce?: number;
  /** Where this file was scrolled to when it was last shown; restored when it is shown again. */
  scrollTop?: number;
  onScrollTop?: (top: number) => void;
  /** Find in file: every match, highlighted, and the current one, scrolled into view. */
  find?: { matches: FindMatch[]; current: number };
  /** 1-based line the debugger is paused on, when this file is the paused one. */
  pausedLine?: number;
  /** 1-based lines with a breakpoint, and whether each one resolved in at least one session. */
  breakpointLines: Map<number, boolean>;
  canBreak: boolean;
  onToggleBreakpoint: (line: number) => void;
  /** When set, hovering an identifier evaluates it in the paused frame and shows the value. */
  hover?: {
    evaluate: (expression: string, options?: { sideEffectFree?: boolean }) => Promise<RemoteObject>;
    getProperties: (objectId: string) => Promise<PropertyDescriptor[]>;
  };
}

/** Highlighting more matches than this makes typing in the find bar slow on a huge file. */
const MAX_HIGHLIGHTS = 3000;

/** `a.b` or `a?.b` to the left of a token, so hovering `locale` in `params.locale` evaluates the whole chain. */
const CHAIN_BEFORE = /((?:[A-Za-z_$][\w$]*\??\.)+)$/;

export function CodeViewer({ file, content, loading, error, focusLine, focusNonce, scrollTop, onScrollTop, find, pausedLine, breakpointLines, canBreak, onToggleBreakpoint, hover }: CodeViewerProps): JSX.Element {
  const lines = useMemo(() => (content ?? '').split('\n'), [content]);
  const highlighted = useMemo(() => lines.map((line) => highlightLine(line)), [lines]);
  const container = useRef<HTMLDivElement>(null);
  const contentReady = content !== undefined && !error;
  const shownFile = useRef<string | undefined>();
  const appliedFocus = useRef<number | undefined>();
  const [hoverTarget, setHoverTarget] = useState<HoverTarget | undefined>();
  const hoverTimer = useRef<number | undefined>();
  const overTooltip = useRef(false);

  const clearHover = useCallback((delay = 150) => {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      if (!overTooltip.current) setHoverTarget(undefined);
    }, delay);
  }, []);

  useEffect(() => {
    if (!hover) setHoverTarget(undefined);
  }, [hover]);

  const onMouseOver = (event: React.MouseEvent<HTMLElement>): void => {
    if (!hover) return;
    const element = (event.target as HTMLElement).closest<HTMLElement>('[data-ident]');
    if (!element) {
      clearHover();

      return;
    }
    const row = element.closest<HTMLElement>('[data-line]');
    const lineNumber = Number(row?.dataset.line ?? 0);
    const column = Number(element.dataset.col ?? 0);
    const text = lines[lineNumber - 1] ?? '';
    const chain = CHAIN_BEFORE.exec(text.slice(0, column))?.[1] ?? '';
    const expression = `${chain}${element.dataset.ident}`;

    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      const box = element.getBoundingClientRect();
      setHoverTarget((current) => (current?.expression === expression ? current : { expression, left: box.left, top: box.top, bottom: box.bottom }));
    }, 250);
  };

  // A file shown again comes back where it was left; a request to show a line scrolls to it.
  useLayoutEffect(() => {
    const box = container.current;
    if (!box || !contentReady) return;
    const fileChanged = shownFile.current !== file;
    shownFile.current = file;
    if (focusLine && focusNonce !== appliedFocus.current) {
      appliedFocus.current = focusNonce;
      revealLine(box, focusLine, false);
    } else if (fileChanged) {
      box.scrollTop = scrollTop ?? 0;
    }
  }, [file, contentReady, focusLine, focusNonce]);

  useEffect(() => {
    if (pausedLine && container.current && contentReady) revealLine(container.current, pausedLine, false);
  }, [pausedLine, file, contentReady]);

  // Find matches are painted with the CSS Custom Highlight API, so the code is not re-rendered per keystroke.
  useEffect(() => {
    const box = container.current;
    if (!box || !contentReady || !find || !('highlights' in CSS) || typeof Highlight === 'undefined') return;
    const all = new Highlight();
    const current = new Highlight();
    find.matches.forEach((match, index) => {
      if (index >= MAX_HIGHLIGHTS && index !== find.current) return;
      const range = rangeFor(box, match);
      if (range) (index === find.current ? current : all).add(range);
    });
    CSS.highlights.set('qd-find', all);
    CSS.highlights.set('qd-find-current', current);

    return () => {
      CSS.highlights.delete('qd-find');
      CSS.highlights.delete('qd-find-current');
    };
  }, [find, contentReady, highlighted]);

  useEffect(() => {
    const match = find?.matches[find.current];
    if (match && container.current) revealLine(container.current, match.line, true);
  }, [find]);

  if (!file) {
    return <p className="p-6 text-center text-xs text-zinc-500">Pick a file on the left, or open one from a request's Initiator tab.</p>;
  }
  if (error) return <p className="p-6 text-xs text-amber-300">{error}</p>;
  if (loading || content === undefined) return <p className="p-6 text-xs text-zinc-500">Loading…</p>;

  return (
    <div
      ref={container}
      className="h-full overflow-auto font-mono text-[12px] leading-5"
      onMouseOver={onMouseOver}
      onMouseLeave={() => clearHover()}
      onScroll={(event) => onScrollTop?.(event.currentTarget.scrollTop)}
    >
      {hover && hoverTarget && (
        <HoverValue
          target={hoverTarget}
          evaluate={hover.evaluate}
          getProperties={hover.getProperties}
          onMouseEnter={() => {
            overTooltip.current = true;
            window.clearTimeout(hoverTimer.current);
          }}
          onMouseLeave={() => {
            overTooltip.current = false;
            clearHover();
          }}
        />
      )}
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((_, index) => {
            const number = index + 1;
            const breakpoint = breakpointLines.get(number);
            const hasBreakpoint = breakpoint !== undefined;
            const isPaused = number === pausedLine;
            const isFocus = number === focusLine && !isPaused;
            const rowTone = isPaused ? 'bg-amber-500/15' : isFocus ? 'bg-sky-500/10' : 'hover:bg-zinc-800/40';
            const gutterTone = isPaused ? 'border-amber-400 text-amber-200' : hasBreakpoint ? 'border-transparent text-zinc-300' : 'border-transparent text-zinc-600';

            return (
              <tr key={number} data-line={number} className={`group ${rowTone}`}>
                <td
                  onClick={() => canBreak && onToggleBreakpoint(number)}
                  title={!canBreak ? 'Connect a target to set breakpoints' : hasBreakpoint ? (breakpoint ? 'Breakpoint (click to remove)' : 'Breakpoint, waiting for the module to load (click to remove)') : 'Click to add a breakpoint'}
                  className={`w-16 select-none whitespace-nowrap border-l-2 pr-2 text-right align-top ${canBreak ? 'cursor-pointer' : ''} ${gutterTone}`}
                >
                  <span className={`mr-1.5 inline-block h-2 w-2 rounded-full align-middle ${hasBreakpoint ? (breakpoint ? 'bg-red-400' : 'bg-zinc-500') : 'bg-transparent group-hover:bg-zinc-700'}`} />
                  {number}
                </td>
                <td className="whitespace-pre pl-3 pr-4 align-top text-zinc-200">
                  {isPaused && <span className="mr-2 text-amber-300">▶</span>}
                  <span data-code>{highlighted[index]}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Scrolls a line to the middle of the view; with `onlyIfHidden`, leaves a visible line where it is. */
function revealLine(box: HTMLElement, line: number, onlyIfHidden: boolean): void {
  const row = box.querySelector<HTMLElement>(`[data-line="${line}"]`);
  if (!row) return;
  if (onlyIfHidden) {
    const view = box.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    if (rect.top >= view.top && rect.bottom <= view.bottom) return;
  }
  row.scrollIntoView({ block: 'center' });
}

/** A DOM range over a match's columns in a highlighted line, which is split into token spans. */
function rangeFor(box: HTMLElement, match: FindMatch): Range | undefined {
  const cell = box.querySelector(`[data-line="${match.line}"] [data-code]`);
  if (!cell) return undefined;
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && match.start < offset + length) {
      range.setStart(node, match.start - offset);
      started = true;
    }
    if (started && match.end <= offset + length) {
      range.setEnd(node, match.end - offset);
      return range;
    }
    offset += length;
  }

  return undefined;
}
