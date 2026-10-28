import { useState } from 'react';

interface JsonViewProps {
  value: unknown;
  name?: string;
  depth?: number;
  /** Nodes shallower than this start expanded. */
  expandDepth?: number;
}

/** A small collapsible tree for JSON-like values. */
export function JsonView({ value, name, depth = 0, expandDepth = 2 }: JsonViewProps): JSX.Element {
  const [open, setOpen] = useState(depth < expandDepth);
  const isArray = Array.isArray(value);
  const isObject = value !== null && typeof value === 'object';

  if (!isObject) {
    return (
      <div className="font-mono text-xs leading-5" style={{ paddingInlineStart: depth * 12 }}>
        {name !== undefined && <span className="text-sky-300">{name}: </span>}
        <Primitive value={value} />
      </div>
    );
  }

  const entries = isArray ? (value as unknown[]).map((item, index) => [String(index), item] as const) : Object.entries(value as Record<string, unknown>);
  const summary = isArray ? `Array(${entries.length})` : `{${entries.length} ${entries.length === 1 ? 'key' : 'keys'}}`;

  return (
    <div className="font-mono text-xs leading-5">
      <button
        type="button"
        className="flex w-full items-center gap-1 rounded text-left hover:bg-zinc-800/60"
        style={{ paddingInlineStart: depth * 12 }}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="w-3 text-zinc-500">{open ? '▾' : '▸'}</span>
        {name !== undefined && <span className="text-sky-300">{name}: </span>}
        <span className="text-zinc-400">{summary}</span>
      </button>
      {open &&
        entries.map(([key, item]) => <JsonView key={key} name={key} value={item} depth={depth + 1} expandDepth={expandDepth} />)}
    </div>
  );
}

function Primitive({ value }: { value: unknown }): JSX.Element {
  if (value === null) return <span className="text-zinc-500">null</span>;
  if (typeof value === 'string') return <span className="whitespace-pre-wrap break-all text-emerald-300">&quot;{value}&quot;</span>;
  if (typeof value === 'number') return <span className="text-amber-300">{String(value)}</span>;
  if (typeof value === 'boolean') return <span className="text-violet-300">{String(value)}</span>;

  return <span className="text-zinc-400">{String(value)}</span>;
}
