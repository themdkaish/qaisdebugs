import os from 'node:os';
import path from 'node:path';

/** Where qaisdebugs keeps pid files, logs, persisted events and the debug Chrome profile: `$QAISDEBUGS_HOME`, else `~/.qaisdebugs`. */
export function dataDir() {
  return process.env.QAISDEBUGS_HOME ? path.resolve(process.env.QAISDEBUGS_HOME) : path.join(os.homedir(), '.qaisdebugs');
}
