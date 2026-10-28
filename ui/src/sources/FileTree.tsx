import { useEffect, useMemo, useState } from 'react';

export interface TreeNode {
  name: string;
  path: string;
  children?: TreeNode[];
}

interface FileTreeProps {
  tree: TreeNode[];
  selected?: string;
  breakpointFiles: Set<string>;
  onSelect: (path: string) => void;
}

export function FileTree({ tree, selected, breakpointFiles, onSelect }: FileTreeProps): JSX.Element {
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const needle = filter.trim().toLowerCase();

  const visible = useMemo(() => (needle ? prune(tree, needle) : tree), [tree, needle]);

  useEffect(() => {
    if (!selected) return;
    setOpen((current) => {
      const next = new Set(current);
      let prefix = '';
      for (const segment of selected.split('/').slice(0, -1)) {
        prefix = prefix ? `${prefix}/${segment}` : segment;
        next.add(`/${prefix}`.replace('//', '/'));
      }

      return next;
    });
  }, [selected]);

  const toggle = (path: string): void =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);

      return next;
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Find file…"
        className="m-2 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
      />
      <div className="min-h-0 flex-1 overflow-auto pb-4">
        {visible.map((node) => (
          <Node key={node.path} node={node} depth={0} open={open} forceOpen={Boolean(needle)} selected={selected} breakpointFiles={breakpointFiles} onToggle={toggle} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

function Node({
  node,
  depth,
  open,
  forceOpen,
  selected,
  breakpointFiles,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  open: Set<string>;
  forceOpen: boolean;
  selected?: string;
  breakpointFiles: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}): JSX.Element {
  const isDir = Boolean(node.children);
  const expanded = forceOpen || open.has(node.path);
  const active = node.path === selected;

  return (
    <div>
      <button
        type="button"
        onClick={() => (isDir ? onToggle(node.path) : onSelect(node.path))}
        className={`flex w-full items-center gap-1 whitespace-nowrap px-2 py-0.5 text-left text-xs ${active ? 'bg-sky-500/15 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800/60'}`}
        style={{ paddingInlineStart: 8 + depth * 12 }}
        title={node.path}
      >
        <span className="w-3 shrink-0 text-zinc-500">{isDir ? (expanded ? '▾' : '▸') : ''}</span>
        <span className={`truncate ${isDir ? 'text-zinc-400' : ''}`}>{node.name}</span>
        {!isDir && breakpointFiles.has(node.path) && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-red-400" />}
      </button>
      {isDir && expanded && node.children?.map((child) => <Node key={child.path} node={child} depth={depth + 1} open={open} forceOpen={forceOpen} selected={selected} breakpointFiles={breakpointFiles} onToggle={onToggle} onSelect={onSelect} />)}
    </div>
  );
}

function prune(nodes: TreeNode[], needle: string): TreeNode[] {
  const out: TreeNode[] = [];
  for (const node of nodes) {
    if (node.children) {
      const children = prune(node.children, needle);
      if (children.length) out.push({ ...node, children });
    } else if (node.path.toLowerCase().includes(needle)) {
      out.push(node);
    }
  }

  return out;
}
