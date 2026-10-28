/**
 * Telling a real pause from another debugger's bookkeeping.
 *
 * Several debuggers can attach to one dev server: each inspector page, and the MCP server. One
 * with a breakpoint in a file that has not loaded yet asks V8 to pause before every new
 * source-mapped script runs, places the breakpoint if the script holds the file, and resumes. V8
 * reports that pause as `instrumentation` only to the debuggers that asked; every other one sees
 * reason `other`, stopped at the script's first statement. Showing those would open a file per
 * module while a route compiles, hundreds of them, so a debugger that did not ask for a pause or a
 * step leaves them alone, and the one that asked resumes.
 */

export interface PauseLocation {
  scriptId: string;
  lineNumber: number;
  columnNumber?: number;
}

export interface RawPause {
  reason: string;
  hitBreakpoints?: string[];
  callFrames: Array<{ functionName: string; location: PauseLocation }>;
}

/** What `Debugger.scriptParsed` said about a script. */
export interface ScriptStart {
  sourceMapURL?: string;
  startLine?: number;
  startColumn?: number;
}

/** Lines a module may open with before its first statement without reading its source to be sure. */
const QUICK_PREAMBLE_LINES = 3;

/** Whitespace, comments, empty statements and directives such as "use strict": what may come before a first statement. */
const PREAMBLE = /^(?:\s+|;|\/\/[^\n]*|\/\*[\s\S]*?\*\/|(['"])[^'"\n]*\1)*$/;

/** Whether only whitespace, comments, `;` and directives come before a 0-based line and column of `source`. */
export function onlyPreambleBefore(source: string, line: number, column: number): boolean {
  let offset = 0;
  for (let index = 0; index < line; index += 1) {
    const newline = source.indexOf('\n', offset);
    if (newline < 0) return false;
    offset = newline + 1;
  }

  return PREAMBLE.test(source.slice(0, offset + column));
}

/**
 * Whether `pause` is another debugger's pause before a script runs: reason `other`, no breakpoint
 * hit, in a source-mapped script's top-level code, at its first statement. `requested` is whether
 * this debugger asked for a pause or a step since it last resumed, which makes any pause its own.
 * `readSource` is asked for the script's text only when the position alone cannot tell.
 */
export async function isForeignScriptStartPause(
  pause: RawPause,
  scriptInfo: (scriptId: string) => ScriptStart | undefined,
  requested: boolean,
  readSource: (scriptId: string) => Promise<string | undefined>
): Promise<boolean> {
  if (requested || pause.reason !== 'other' || pause.hitBreakpoints?.length) return false;
  const top = pause.callFrames[0];
  // A function name means the script is already running its code, not about to start.
  if (!top || top.functionName) return false;
  const script = scriptInfo(top.location.scriptId);
  if (script && !script.sourceMapURL) return false;

  const line = top.location.lineNumber - (script?.startLine ?? 0);
  const column = (top.location.columnNumber ?? 0) - (line === 0 ? (script?.startColumn ?? 0) : 0);
  if (line < 0 || column < 0) return false;
  if (line < QUICK_PREAMBLE_LINES && column <= 1) return true;

  const source = await readSource(top.location.scriptId).catch(() => undefined);

  return source !== undefined && onlyPreambleBefore(source, line, column);
}
