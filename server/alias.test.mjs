import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAlias, globalBinDir, invokedName, isValidName, listAliases, namesFromNpmEnv, removeAlias } from './alias.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A fake global prefix holding a `qaisdebugs` command, and a private data folder. */
function sandbox() {
  const prefix = mkdtempSync(path.join(tmpdir(), 'qd-prefix-'));
  const binDir = path.join(prefix, 'bin');
  mkdirSync(binDir);
  writeFileSync(path.join(binDir, 'qaisdebugs'), '#!/usr/bin/env node\n', { mode: 0o755 });

  return { prefix, binDir };
}

beforeEach(() => {
  process.env.QAISDEBUGS_HOME = mkdtempSync(path.join(tmpdir(), 'qd-home-'));
});

describe('namesFromNpmEnv', () => {
  it('reads a bare flag ending in "debugs", as npm passes --malaydebugs', () => {
    expect(namesFromNpmEnv({ npm_config_malaydebugs: 'true' })).toEqual(['malaydebugs']);
  });

  it('turns --malay-debugs (npm_config_malay_debugs) back into a dashed name', () => {
    expect(namesFromNpmEnv({ npm_config_malay_debugs: 'true' })).toEqual(['malay-debugs']);
  });

  it('reads any name from --qaisdebugs-name, including a comma list', () => {
    expect(namesFromNpmEnv({ npm_config_qaisdebugs_name: 'malay,Raju-Tools' })).toEqual(['malay', 'raju-tools']);
  });

  it('reads QAISDEBUGS_NAME, which does not depend on npm passing unknown flags on', () => {
    expect(namesFromNpmEnv({ QAISDEBUGS_NAME: 'malaydebugs' })).toEqual(['malaydebugs']);
  });

  it('ignores the primary name, flags set to anything but true, and unrelated npm config', () => {
    expect(namesFromNpmEnv({ npm_config_qaisdebugs: 'true', npm_config_malaydebugs: 'false', npm_config_global: 'true', npm_config_prefix: '/x' })).toEqual([]);
  });
});

describe('invokedName', () => {
  it('is the personal name when started through its link', () => {
    expect(invokedName('/opt/homebrew/bin/malaydebugs')).toBe('malaydebugs');
    expect(invokedName('C:\\npm\\malaydebugs.cmd')).toBe('malaydebugs');
  });

  it('is qaisdebugs for the real script or anything unexpected', () => {
    expect(invokedName('/usr/lib/node_modules/qaisdebugs/bin/qaisdebugs.mjs')).toBe('qaisdebugs');
    expect(invokedName(undefined)).toBe('qaisdebugs');
    expect(invokedName('/tmp/Weird Name!')).toBe('qaisdebugs');
  });
});

describe('isValidName', () => {
  it('accepts short lowercase command names and rejects the rest', () => {
    expect(isValidName('malaydebugs')).toBe(true);
    expect(isValidName('malay-debugs2')).toBe(true);
    expect(isValidName('qaisdebugs')).toBe(false);
    expect(isValidName('Malay')).toBe(false);
    expect(isValidName('../evil')).toBe(false);
    expect(isValidName('a')).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('createAlias / removeAlias', () => {
  it('creates a relative link to qaisdebugs, records it, and removes it again', () => {
    const { binDir } = sandbox();

    const file = createAlias('malaydebugs', binDir);

    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(readlinkSync(file)).toBe('qaisdebugs');
    expect(listAliases().map((entry) => entry.name)).toEqual(['malaydebugs']);

    expect(removeAlias('malaydebugs', binDir)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(listAliases()).toEqual([]);
  });

  it('can be created twice (a reinstall) without an error', () => {
    const { binDir } = sandbox();

    createAlias('malaydebugs', binDir);

    expect(() => createAlias('malaydebugs', binDir)).not.toThrow();
  });

  it('never replaces a command that is not a qaisdebugs name', () => {
    const { binDir } = sandbox();
    writeFileSync(path.join(binDir, 'gitdebugs'), '#!/bin/sh\necho mine\n');

    expect(() => createAlias('gitdebugs', binDir)).toThrow(/already exists/);
    expect(removeAlias('gitdebugs', binDir)).toBe(false);
    expect(existsSync(path.join(binDir, 'gitdebugs'))).toBe(true);
  });

  it('refuses invalid names and a folder without qaisdebugs', () => {
    const { binDir } = sandbox();
    const empty = mkdtempSync(path.join(tmpdir(), 'qd-empty-'));

    expect(() => createAlias('../evil', binDir)).toThrow(/not a valid command name/);
    expect(() => createAlias('malaydebugs', empty)).toThrow(/not in/);
  });
});

describe.skipIf(process.platform === 'win32')('globalBinDir', () => {
  it('is the folder the command was started from, when qaisdebugs is in it', () => {
    const { binDir } = sandbox();

    expect(globalBinDir(path.join(binDir, 'malaydebugs'))).toBe(binDir);
  });

  it('is found from the installed package location otherwise', () => {
    const { prefix, binDir } = sandbox();
    const packageRoot = path.join(prefix, 'lib', 'node_modules', 'qaisdebugs');
    mkdirSync(packageRoot, { recursive: true });

    expect(globalBinDir(path.join(packageRoot, 'bin', 'qaisdebugs.mjs'), packageRoot)).toBe(binDir);
  });
});

describe.skipIf(process.platform === 'win32')('postinstall', () => {
  const run = (env) =>
    spawnSync(process.execPath, [path.join(root, 'scripts', 'postinstall.mjs')], {
      env: { PATH: process.env.PATH, QAISDEBUGS_HOME: process.env.QAISDEBUGS_HOME, ...env },
      encoding: 'utf8',
    });

  it('creates the name given on the global install command line', () => {
    const { prefix, binDir } = sandbox();

    const result = run({ npm_config_global: 'true', npm_config_prefix: prefix, npm_config_malaydebugs: 'true' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('created the command "malaydebugs"');
    expect(readlinkSync(path.join(binDir, 'malaydebugs'))).toBe('qaisdebugs');
  });

  it('does nothing for a local install, and never fails the install', () => {
    const { prefix, binDir } = sandbox();
    writeFileSync(path.join(binDir, 'takendebugs'), 'not ours');

    const local = run({ npm_config_prefix: prefix, npm_config_malaydebugs: 'true' });
    const clash = run({ npm_config_global: 'true', npm_config_prefix: prefix, npm_config_takendebugs: 'true' });

    expect(local.status).toBe(0);
    expect(existsSync(path.join(binDir, 'malaydebugs'))).toBe(false);
    expect(clash.status).toBe(0);
    expect(clash.stderr).toContain('could not create "takendebugs"');
  });
});
