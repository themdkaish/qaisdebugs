import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ensureCollector, findRepoRoot, withoutAgentPreload } from './collector.js';

describe('findRepoRoot', () => {
  it('walks up to a workspace file, a workspaces package.json or a .git folder', () => {
    const pnpm = mkdtempSync(path.join(tmpdir(), 'qaisdebugs-pnpm-'));
    writeFileSync(path.join(pnpm, 'pnpm-workspace.yaml'), 'packages: []\n');
    mkdirSync(path.join(pnpm, 'apps', 'web'), { recursive: true });
    expect(findRepoRoot(path.join(pnpm, 'apps', 'web'))).toBe(pnpm);

    const yarn = mkdtempSync(path.join(tmpdir(), 'qaisdebugs-yarn-'));
    writeFileSync(path.join(yarn, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    mkdirSync(path.join(yarn, 'packages', 'site'), { recursive: true });
    expect(findRepoRoot(path.join(yarn, 'packages', 'site'))).toBe(yarn);

    const git = mkdtempSync(path.join(tmpdir(), 'qaisdebugs-git-'));
    mkdirSync(path.join(git, '.git'));
    mkdirSync(path.join(git, 'src', 'app'), { recursive: true });
    expect(findRepoRoot(path.join(git, 'src', 'app'))).toBe(git);
  });

  it('stops at the nearest .git even inside a bigger workspace', () => {
    const outer = mkdtempSync(path.join(tmpdir(), 'qaisdebugs-outer-'));
    writeFileSync(path.join(outer, 'turbo.json'), '{}');
    const inner = path.join(outer, 'vendor', 'other-repo');
    mkdirSync(path.join(inner, '.git'), { recursive: true });

    expect(findRepoRoot(path.join(inner, 'src'))).toBe(inner);
  });
});

describe('withoutAgentPreload', () => {
  it('removes only our --import flag and keeps the rest', () => {
    expect(withoutAgentPreload('--max-old-space-size=4096 --import /x/qaisdebugs/dist/agent/index.js')).toBe('--max-old-space-size=4096');
    expect(withoutAgentPreload('--import="/x y/dist/agent/index.js" --inspect')).toBe('--inspect');
    expect(withoutAgentPreload(undefined)).toBe('');
  });
});

describe('ensureCollector', () => {
  it('reports a healthy collector without starting anything', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));

    await expect(ensureCollector({ collectorUrl: 'http://127.0.0.1:4983', fetchImpl, log: () => undefined })).resolves.toBe('running');
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:4983/health', expect.anything());
  });

  it('never starts a collector for a non-loopback address', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('down');
    });

    await expect(ensureCollector({ collectorUrl: 'http://devbox.local:4983', fetchImpl, log: () => undefined })).resolves.toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails cleanly when the project has no collector to start', async () => {
    const log = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error('down');
    });

    await expect(
      ensureCollector({ collectorUrl: 'http://127.0.0.1:4983', fetchImpl, log, projectRoot: mkdtempSync(path.join(tmpdir(), 'qaisdebugs-empty-')) })
    ).resolves.toBe('failed');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('npx qaisdebugs'));
  });
});
