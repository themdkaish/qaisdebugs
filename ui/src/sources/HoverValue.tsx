import { useEffect, useState } from 'react';
import { type PropertyDescriptor, type RemoteObject, describe, isExpandable } from '../debugger/remoteObject';
import { ObjectTree } from './ObjectTree';

/**
 * The value of the expression under the cursor, evaluated in the paused frame, like Chrome's
 * Sources panel shows on hover. Side-effect-free evaluation only, so hovering `fetch(...)` or a
 * getter that would mutate state shows nothing rather than running it.
 */

export interface HoverTarget {
  expression: string;
  /** Viewport coordinates of the hovered token's box. */
  left: number;
  top: number;
  bottom: number;
}

interface HoverValueProps {
  target: HoverTarget;
  evaluate: (expression: string, options?: { sideEffectFree?: boolean }) => Promise<RemoteObject>;
  getProperties: (objectId: string) => Promise<PropertyDescriptor[]>;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

export function HoverValue({ target, evaluate, getProperties, onMouseEnter, onMouseLeave }: HoverValueProps): JSX.Element | null {
  const [state, setState] = useState<{ expression: string; value?: RemoteObject; error?: string } | undefined>();

  useEffect(() => {
    let cancelled = false;
    setState(undefined);
    evaluate(target.expression, { sideEffectFree: true })
      .then((value) => {
        if (!cancelled) setState({ expression: target.expression, value });
      })
      .catch((reason: Error) => {
        if (!cancelled) setState({ expression: target.expression, error: reason.message });
      });

    return () => {
      cancelled = true;
    };
  }, [target.expression, evaluate]);

  // An identifier that is not in scope (a property name, an import that webpack renamed) gets no tooltip.
  if (state?.error && /is not defined|Cannot read|side-effect/i.test(state.error)) return null;

  const width = 360;
  const left = Math.max(8, Math.min(target.left, window.innerWidth - width - 8));
  const belowSpace = window.innerHeight - target.bottom;
  const style = belowSpace > 220 ? { left, top: target.bottom + 4 } : { left, bottom: window.innerHeight - target.top + 4 };

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{ ...style, width, maxHeight: 320 }}
      className="fixed z-50 overflow-auto rounded border border-zinc-700 bg-zinc-900 text-xs shadow-xl shadow-black/60"
    >
      <div className="flex items-baseline gap-2 border-b border-zinc-800 px-2 py-1 font-mono">
        <span className="text-sky-300">{target.expression}</span>
        {!state && <span className="text-zinc-500">…</span>}
        {state?.error && <span className="text-amber-300">{state.error}</span>}
        {state?.value && !isExpandable(state.value) && <span className="min-w-0 break-all text-zinc-200">{describe(state.value)}</span>}
        {state?.value && isExpandable(state.value) && <span className="truncate text-zinc-400">{describe(state.value)}</span>}
      </div>
      {state?.value && isExpandable(state.value) && state.value.objectId && (
        <div className="py-1">
          <ObjectTree label={describe(state.value)} objectId={state.value.objectId} getProperties={getProperties} depth={0} defaultOpen />
        </div>
      )}
    </div>
  );
}
