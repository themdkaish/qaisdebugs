import { useEffect, useMemo, useRef } from 'react';
import { type EditorTab, tabLabels } from './tabs';

interface EditorTabsProps {
  tabs: EditorTab[];
  active?: string;
  /** Files with a breakpoint, marked with a red dot. */
  breakpointFiles: Set<string>;
  /** The file the debugger is paused in, marked in amber. */
  pausedFile?: string;
  onSelect: (file: string) => void;
  onClose: (file: string) => void;
}

/** The open files, like an IDE's editor tabs: click to show, × or middle-click to close. */
export function EditorTabs({ tabs, active, breakpointFiles, pausedFile, onSelect, onClose }: EditorTabsProps): JSX.Element {
  const labels = useMemo(() => tabLabels(tabs.map((tab) => tab.file)), [tabs]);
  const strip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, tabs.length]);

  if (tabs.length === 0) return <div className="min-w-0 flex-1 px-1 text-zinc-500">No file open</div>;

  return (
    <div ref={strip} role="tablist" aria-label="Open files" className="flex min-w-0 flex-1 self-stretch overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
      {tabs.map((tab) => {
        const label = labels.get(tab.file);
        const isActive = tab.file === active;
        const marker = tab.file === pausedFile ? 'bg-amber-400' : breakpointFiles.has(tab.file) ? 'bg-red-400' : '';

        return (
          <div
            key={tab.file}
            data-active={isActive}
            role="tab"
            aria-selected={isActive}
            title={tab.file}
            onClick={() => onSelect(tab.file)}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              onClose(tab.file);
            }}
            className={`group flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-t-2 border-r-zinc-800 py-1 pl-3 pr-1.5 ${
              isActive ? 'border-t-sky-400 bg-zinc-950 text-zinc-100' : 'border-t-transparent text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
            }`}
          >
            {marker && <span className={`h-1.5 w-1.5 rounded-full ${marker}`} />}
            <span className="font-mono">{label?.name}</span>
            {label?.hint && <span className="max-w-[160px] truncate text-[11px] text-zinc-500">{label.hint}</span>}
            <button
              type="button"
              aria-label={`Close ${label?.name ?? tab.file}`}
              title="Close"
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.file);
              }}
              className={`grid h-4 w-4 place-items-center rounded text-[13px] leading-none text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100 ${isActive ? '' : 'invisible group-hover:visible'}`}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
