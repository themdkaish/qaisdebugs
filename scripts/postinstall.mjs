/**
 * Runs after `npm install -g`. Creates the personal command names asked for on the install
 * command line (`--malaydebugs`, `--qaisdebugs-name=<name>`). It never fails the install: a name
 * that cannot be created is reported, and `qaisdebugs alias <name>` can create it later.
 */
import { binDirForPrefix, createAlias, namesFromNpmEnv } from '../server/alias.mjs';

const env = process.env;

if (env.npm_config_global === 'true' && env.npm_config_prefix) {
  const names = namesFromNpmEnv(env);
  const binDir = binDirForPrefix(env.npm_config_prefix);

  for (const name of names) {
    try {
      createAlias(name, binDir);
      console.log(`[qaisdebugs] created the command "${name}" (same tool as qaisdebugs); try: ${name} dev`);
    } catch (error) {
      console.warn(`[qaisdebugs] could not create "${name}": ${error.message}. Run later: qaisdebugs alias ${name}`);
    }
  }
}
