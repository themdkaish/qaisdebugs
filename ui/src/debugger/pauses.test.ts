import { describe, expect, it } from 'vitest';
import { isForeignScriptStartPause, onlyPreambleBefore, type RawPause, type ScriptStart } from './pauses';

const at = (lineNumber: number, columnNumber = 0, { reason = 'other', functionName = '', hitBreakpoints }: { reason?: string; functionName?: string; hitBreakpoints?: string[] } = {}): RawPause => ({
  reason,
  hitBreakpoints,
  callFrames: [
    { functionName, location: { scriptId: '7', lineNumber, columnNumber } },
    { functionName: '__webpack_require__', location: { scriptId: '3', lineNumber: 40, columnNumber: 2 } },
  ],
});
const script = (info: ScriptStart = {}) => () => ({ sourceMapURL: 'data:application/json;base64,e30=', startLine: 0, startColumn: 0, ...info });
const noSource = async (): Promise<undefined> => undefined;
const source = (text: string) => async (): Promise<string> => text;

describe('onlyPreambleBefore', () => {
  it('accepts what modules really start with before their first statement', () => {
    // Sentry's injected globals, a blank line, a lint comment, a directive.
    expect(onlyPreambleBefore(';globalThis.x = 1;', 0, 1)).toBe(true);
    expect(onlyPreambleBefore('\nObject.defineProperty(exports)', 1, 0)).toBe(true);
    expect(onlyPreambleBefore('// eslint-disable-next-line\n\nObject.defineProperty(exports)', 2, 0)).toBe(true);
    expect(onlyPreambleBefore('"use strict";\n/**\n * @license MIT\n */\nconst a = 1;', 4, 0)).toBe(true);
  });

  it('rejects a position after code has run', () => {
    expect(onlyPreambleBefore('const a = 1;\nconst b = 2;', 1, 0)).toBe(false);
    expect(onlyPreambleBefore('"use strict"; foo();', 0, 20)).toBe(false);
  });
});

describe('isForeignScriptStartPause', () => {
  it('recognises another debugger pausing before a script runs', async () => {
    expect(await isForeignScriptStartPause(at(0, 0), script(), false, noSource)).toBe(true);
    expect(await isForeignScriptStartPause(at(0, 1), script(), false, noSource)).toBe(true);
    expect(await isForeignScriptStartPause(at(2, 0), script(), false, noSource)).toBe(true);
  });

  it('reads the source when a module opens with a longer header', async () => {
    const header = '/**\n * @license\n * Copyright\n * MIT\n */\nexport const a = 1;';
    expect(await isForeignScriptStartPause(at(5, 0), script(), false, source(header))).toBe(true);
    expect(await isForeignScriptStartPause(at(5, 0), script(), false, source('a();\nb();\nc();\nd();\ne();\nf();'))).toBe(false);
    expect(await isForeignScriptStartPause(at(5, 0), script(), false, noSource)).toBe(false);
  });

  it('uses where the script starts', async () => {
    expect(await isForeignScriptStartPause(at(12, 4), script({ startLine: 12, startColumn: 4 }), false, noSource)).toBe(true);
    expect(await isForeignScriptStartPause(at(3, 0), script({ startLine: 12, startColumn: 4 }), false, noSource)).toBe(false);
  });

  it('treats an unknown script as starting at 0:0', async () => {
    expect(await isForeignScriptStartPause(at(0, 0), () => undefined, false, noSource)).toBe(true);
  });

  it('keeps a pause this debugger asked for, by pausing or stepping', async () => {
    expect(await isForeignScriptStartPause(at(0, 0), script(), true, noSource)).toBe(false);
  });

  it('keeps pauses in running code: inside a function, or after the first statement', async () => {
    expect(await isForeignScriptStartPause(at(0, 0, { functionName: 'FleetManagementPage' }), script(), false, noSource)).toBe(false);
    expect(await isForeignScriptStartPause(at(17, 0), script(), false, source('a();\n'.repeat(20)))).toBe(false);
  });

  it('keeps pauses in scripts without a source map, which V8 does not pause before', async () => {
    expect(await isForeignScriptStartPause(at(0, 0), script({ sourceMapURL: undefined }), false, noSource)).toBe(false);
  });

  it('keeps breakpoints, exceptions and its own instrumentation pauses', async () => {
    expect(await isForeignScriptStartPause(at(0, 0, { hitBreakpoints: ['1:0:0:x'] }), script(), false, noSource)).toBe(false);
    expect(await isForeignScriptStartPause(at(0, 0, { reason: 'exception' }), script(), false, noSource)).toBe(false);
    expect(await isForeignScriptStartPause(at(0, 0, { reason: 'instrumentation' }), script(), false, noSource)).toBe(false);
  });
});
