/**
 * QaisDebugs — personal command names.
 *
 * The package always installs the `qaisdebugs` command. Anyone can add a name of their own next to
 * it, either while installing:
 *
 *   npm install -g ./qaisdebugs-0.1.0.tgz --malaydebugs
 *   npm install -g ./qaisdebugs-0.1.0.tgz --qaisdebugs-name=malay-tools
 *   QAISDEBUGS_NAME=malaydebugs npm install -g ./qaisdebugs-0.1.0.tgz
 *
 * or later with `qaisdebugs alias malaydebugs`. The extra name is a link to the `qaisdebugs`
 * command in the same folder (a small .cmd/.ps1 pair on Windows), so it follows every reinstall
 * and update. The CLI notices which name started it and uses that name in its messages and in the
 * inspector.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths.mjs';

export const PRIMARY = 'qaisdebugs';
const NAME = /^[a-z][a-z0-9-]{1,39}$/;
const isWindows = process.platform === 'win32';

/** Whether a name can be a command: lowercase letters, digits and dashes, 2 to 40 characters. */
export function isValidName(name) {
  return typeof name === 'string' && NAME.test(name) && name !== PRIMARY;
}

/**
 * The names requested while installing: `QAISDEBUGS_NAME`, or the npm command line, which npm hands
 * install scripts as environment variables:
 * `--qaisdebugs-name=<name>` arrives as `npm_config_qaisdebugs_name`, and a bare flag ending in
 * "debugs" (`--malaydebugs`) as `npm_config_malaydebugs=true`.
 */
export function namesFromNpmEnv(env) {
  const names = new Set();
  // QAISDEBUGS_NAME=<name> npm install -g … keeps working once npm stops passing unknown flags on.
  for (const explicit of [env.QAISDEBUGS_NAME, env.npm_config_qaisdebugs_name]) {
    if (!explicit || explicit === 'true') continue;
    for (const part of String(explicit).split(',')) if (part.trim()) names.add(part.trim().toLowerCase());
  }

  for (const [key, value] of Object.entries(env)) {
    const match = /^npm_config_([a-z0-9_]+debugs)$/i.exec(key);
    if (!match || value !== 'true') continue;
    names.add(match[1].toLowerCase().replace(/_/g, '-'));
  }
  names.delete(PRIMARY);

  return [...names];
}

/** The folder npm puts global commands in, for a given global prefix. */
export function binDirForPrefix(prefix) {
  return isWindows ? prefix : path.join(prefix, 'bin');
}

/**
 * The global command folder. Worked out from where the command was started (the folder holding the
 * `qaisdebugs` link), then from where the package is installed (`<prefix>/lib/node_modules/…`),
 * and only then asked of npm: npm masks path segments that look like tokens in its output.
 */
export function globalBinDir(scriptPath, packageRoot) {
  const primaryIn = (dir) => existsSync(path.join(dir, isWindows ? `${PRIMARY}.cmd` : PRIMARY));

  if (scriptPath) {
    const started = path.dirname(path.resolve(scriptPath));
    if (primaryIn(started)) return started;
  }

  if (packageRoot) {
    const prefix = isWindows ? path.resolve(packageRoot, '..', '..') : path.resolve(packageRoot, '..', '..', '..');
    const candidate = binDirForPrefix(prefix);
    if (primaryIn(candidate)) return candidate;
  }

  const prefix = execFileSync(isWindows ? 'npm.cmd' : 'npm', ['prefix', '-g'], { encoding: 'utf8', shell: isWindows }).trim();

  return binDirForPrefix(prefix);
}

/** The name a command was started as, from the path of the script: `malaydebugs`, `qaisdebugs`… */
export function invokedName(scriptPath) {
  const base = String(scriptPath ?? '').split(/[\\/]/).pop().replace(/\.(m?js|cmd|ps1)$/i, '');

  return isValidName(base) ? base : PRIMARY;
}

function registryFile() {
  return path.join(dataDir(), 'aliases.json');
}

/** The extra names created on this machine, as recorded when they were made. */
export function listAliases() {
  try {
    return JSON.parse(readFileSync(registryFile(), 'utf8')).filter((entry) => existsSync(entry.path));
  } catch {
    return [];
  }
}

function saveAliases(entries) {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(registryFile(), `${JSON.stringify(entries, null, 2)}\n`);
}

function shimPaths(binDir, name) {
  return isWindows ? [path.join(binDir, `${name}.cmd`), path.join(binDir, `${name}.ps1`)] : [path.join(binDir, name)];
}

/** Whether a file at `file` is one of ours: a link to the qaisdebugs command, or our Windows shim. */
function isOurs(file) {
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) return path.basename(readlinkSync(file)) === PRIMARY;

    return readFileSync(file, 'utf8').includes('qaisdebugs alias shim');
  } catch {
    return false;
  }
}

/**
 * Creates `name` as a second command next to `qaisdebugs` in `binDir`. Refuses to replace a command
 * that is not one of ours, so a typo can never overwrite `node` or `git`.
 */
export function createAlias(name, binDir) {
  if (!isValidName(name)) throw new Error(`"${name}" is not a valid command name: use 2-40 lowercase letters, digits or dashes, starting with a letter`);

  const primary = isWindows ? path.join(binDir, `${PRIMARY}.cmd`) : path.join(binDir, PRIMARY);
  if (!existsSync(primary)) throw new Error(`the ${PRIMARY} command is not in ${binDir}; install qaisdebugs globally first`);

  for (const file of shimPaths(binDir, name)) {
    if (existsSync(file) || isDanglingLink(file)) {
      if (!isOurs(file)) throw new Error(`${file} already exists and is not a qaisdebugs name; pick another name`);
      unlinkSync(file);
    }
  }

  if (isWindows) {
    const [cmd, ps1] = shimPaths(binDir, name);
    writeFileSync(cmd, `@ECHO off\r\nREM qaisdebugs alias shim\r\nSET QAISDEBUGS_BRAND=${name}\r\n"%~dp0${PRIMARY}.cmd" %*\r\n`);
    writeFileSync(ps1, `# qaisdebugs alias shim\n$env:QAISDEBUGS_BRAND = "${name}"\n& "$PSScriptRoot\\${PRIMARY}.ps1" @args\nexit $LASTEXITCODE\n`);
  } else {
    // Relative, so the link keeps working if the whole prefix moves.
    symlinkSync(PRIMARY, path.join(binDir, name));
  }

  const entries = listAliases().filter((entry) => entry.name !== name);
  entries.push({ name, path: shimPaths(binDir, name)[0] });
  saveAliases(entries);

  return shimPaths(binDir, name)[0];
}

/** Removes a name made by `createAlias`. Anything else at that path is left alone. */
export function removeAlias(name, binDir) {
  let removed = false;
  for (const file of shimPaths(binDir, name)) {
    if ((existsSync(file) || isDanglingLink(file)) && isOurs(file)) {
      unlinkSync(file);
      removed = true;
    }
  }
  saveAliases(listAliases().filter((entry) => entry.name !== name));

  return removed;
}

function isDanglingLink(file) {
  try {
    return lstatSync(file).isSymbolicLink() && !existsSync(file);
  } catch {
    return false;
  }
}
