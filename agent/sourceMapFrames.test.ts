import { describe, expect, it } from 'vitest';
import { mapGeneratedFrame } from './sourceMapFrames.js';

/** Original line 4 column 5 of the single source sits on generated line 2 column 3. */
const MAP = { version: 3, sources: ['/tmp/fake project/app/page.tsx'], names: [], mappings: ';AAGE,CAAC,CAAC', sourcesContent: ['l1\nl2\nl3\n  boom();\n'] };

describe('mapGeneratedFrame', () => {
  it("maps an eval'd webpack module through Node's source-map cache", () => {
    process.setSourceMapsEnabled(true);
    const b64 = Buffer.from(JSON.stringify(MAP)).toString('base64');
    const url = `webpack-internal:///(rsc)/./app/page-${process.pid}.tsx`;
    (0, eval)(`function f() { return 1; }\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${b64}\n//# sourceURL=${url}`);

    expect(mapGeneratedFrame(url, 2, 3)).toEqual({ file: 'file:///tmp/fake%20project/app/page.tsx', line: 4, column: 5 });
    expect(mapGeneratedFrame(url, 1, 1)).toBeUndefined();
  });

  it('returns undefined for scripts without a map', () => {
    expect(mapGeneratedFrame('webpack-internal:///(rsc)/./nowhere.tsx', 1, 1)).toBeUndefined();
    expect(mapGeneratedFrame('/no/such/file.js', 1, 1)).toBeUndefined();
  });
});
