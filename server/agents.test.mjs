import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isAlive, pruneAgents } from './agents.mjs';

/** The pid of a process that has already exited. */
function exitedPid() {
  return spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid;
}

describe('isAlive', () => {
  it('is true for a running process and false once it has exited', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(exitedPid())).toBe(false);
  });

  it('is false for anything that is not a pid', () => {
    expect(isAlive(undefined)).toBe(false);
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-1)).toBe(false);
    expect(isAlive('123')).toBe(false);
  });
});

describe('pruneAgents', () => {
  it('forgets the dev servers whose process has exited and keeps the running ones', () => {
    const agents = new Map([
      ['gov-portal', { app: 'gov-portal', pid: exitedPid() }],
      ['rental-portal', { app: 'rental-portal', pid: process.pid }],
      ['practice-project', { app: 'practice-project', pid: exitedPid() }],
    ]);

    const removed = pruneAgents(agents);

    expect(removed).toEqual(['gov-portal', 'practice-project']);
    expect([...agents.keys()]).toEqual(['rental-portal']);
  });

  it('removes nothing while every server is running', () => {
    const agents = new Map([['web', { app: 'web', pid: 42 }]]);

    expect(pruneAgents(agents, () => true)).toEqual([]);
    expect(agents.size).toBe(1);
  });
});
