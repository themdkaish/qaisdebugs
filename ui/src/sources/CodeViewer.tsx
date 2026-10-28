import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PropertyDescriptor, RemoteObject } from '../debugger/remoteObject';
import { type HoverTarget, HoverValue } from './HoverValue';
import { highlightLine } from './highlight';

interface CodeViewerProps {
  file?: string;
  content?: string;
  loading?: boolean;
  error?: string;
  /** 1-based line to scroll to and highlight softly. */
  focusLine?: number;
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

/** `a.b` or `a?.b` to the left of a token, so hovering `locale` in `params.locale` evaluates the whole chain. */
const CHAIN_BEFORE = /((?:[A-Za-z_$][\w$]*\??\.)+)$/;

export function CodeViewer({ file, content, loading, error, focusLine, pausedLine, breakpointLines, canBreak, onToggleBreakpoint, hover }: CodeViewerProps): JSX.Element {
  const lines = useMemo(() => (content ?? '').split('\n'), [content]);
  const highlighted = useMemo(() => lines.map((line) => highlightLine(line)), [lines]);
  const container = useRef<HTMLDivElement>(null);
  const targetLine = pausedLine ?? focusLine;
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

  useEffect(() => {
    if (!targetLine || !container.current) return;
    const row = container.current.querySelector<HTMLElement>(`[data-line="${targetLine}"]`);
    row?.scrollIntoView({ block: 'center' });
  }, [targetLine, file, content]);

  if (!file) {
    return <p className="p-6 text-center text-xs text-zinc-500">Pick a file on the left, or open one from a request's Initiator tab.</p>;
  }
  if (error) return <p className="p-6 text-xs text-amber-300">{error}</p>;
  if (loading || content === undefined) return <p className="p-6 text-xs text-zinc-500">Loading…</p>;

  return (
    <div ref={container} className="h-full overflow-auto font-mono text-[12px] leading-5" onMouseOver={onMouseOver} onMouseLeave={() => clearHover()}>
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
                  {highlighted[index]}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
