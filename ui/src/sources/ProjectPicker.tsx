import { useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from './projects';

interface ProjectPickerProps {
  projects: Project[];
  /** The project shown before the picker opened, offered as the way back. */
  current?: string;
  /** Whether the picker is on screen; the search box takes focus each time it is. */
  shown: boolean;
  onPick: (root: string) => void;
  onCancel?: () => void;
}

/** Shown in Sources when dev servers of more than one project report to this inspector. */
export function ProjectPicker({ projects, current, shown, onPick, onCancel }: ProjectPickerProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const needle = query.trim().toLowerCase();

  const visible = useMemo(
    () => projects.filter((project) => !needle || [project.name, project.root, ...project.agents.map((agent) => agent.app)].some((text) => text.toLowerCase().includes(needle))),
    [projects, needle]
  );

  useEffect(() => {
    const index = visible.findIndex((project) => project.root === current);
    setSelected(index >= 0 && !needle ? index : 0);
  }, [visible, current, needle]);

  // The Sources view is mounted while hidden, so autofocus alone would miss.
  useEffect(() => {
    if (shown) input.current?.focus();
  }, [shown]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') setSelected((index) => Math.min(visible.length - 1, index + 1));
    else if (event.key === 'ArrowUp') setSelected((index) => Math.max(0, index - 1));
    else if (event.key === 'Enter' && visible[selected]) onPick(visible[selected].root);
    else if (event.key === 'Escape' && onCancel) onCancel();
    else return;
    event.preventDefault();
  };

  return (
    <div className="flex h-full min-h-0 flex-col items-center overflow-auto px-4 py-12">
      <div className="grid h-14 w-14 place-items-center rounded-2xl border border-zinc-700 bg-zinc-900 shadow-lg">
        <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="url(#qd-picker)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <defs>
            <linearGradient id="qd-picker" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#22d3ee" />
              <stop offset="1" stopColor="#a78bfa" />
            </linearGradient>
          </defs>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
        </svg>
      </div>
      <h2 className="mt-5 text-2xl font-semibold text-zinc-100">Open a project</h2>
      <p className="mt-1 text-center text-sm text-zinc-400">
        {projects.length} projects are running. Pick one to see its sources and debug it.
      </p>

      <div className="mt-7 w-full max-w-xl rounded-xl border border-zinc-800 bg-zinc-900/70 p-3 shadow-2xl">
        <label className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-3 focus-within:border-sky-500">
          <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-zinc-500" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search projects…"
            aria-label="Search projects"
            className="w-full bg-transparent py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
          />
        </label>

        <ul ref={list} role="listbox" aria-label="Running projects" className="mt-2 max-h-[55vh] space-y-1 overflow-y-auto">
          {visible.length === 0 && <li className="px-3 py-4 text-center text-sm text-zinc-500">No project matches.</li>}
          {visible.map((project, index) => (
            <li key={project.root} data-index={index} role="option" aria-selected={index === selected}>
              <button
                type="button"
                onMouseMove={() => setSelected(index)}
                onClick={() => onPick(project.root)}
                className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left ${index === selected ? 'border-sky-500/60 bg-sky-500/10' : 'border-transparent hover:bg-zinc-800/60'}`}
              >
                <svg viewBox="0 0 24 24" className="h-7 w-7 shrink-0 text-sky-400" fill="currentColor" aria-hidden="true">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
                </svg>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-zinc-100">{project.name}</span>
                    {project.root === current && <span className="rounded-full bg-zinc-800 px-1.5 text-[10px] text-zinc-400">current</span>}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-zinc-500" title={project.root}>
                    {project.root}
                  </span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    {project.agents.map((agent) => (
                      <span key={agent.app} className="inline-flex items-center gap-1 rounded-full border border-zinc-700 px-1.5 text-[10px] text-zinc-300">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                        {agent.app}
                        {agent.devServerPort ? <span className="text-zinc-500">:{agent.devServerPort}</span> : null}
                      </span>
                    ))}
                  </span>
                </span>
                <span className="shrink-0 text-lg text-zinc-500" aria-hidden="true">
                  ›
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {onCancel && (
        <button type="button" onClick={onCancel} className="mt-4 text-xs text-zinc-400 hover:text-zinc-200">
          Back to the current project (Esc)
        </button>
      )}
    </div>
  );
}
