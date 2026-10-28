import { install } from './install.js';

/**
 * QaisDebugs agent — preload entry.
 *
 *   npx qaisdebugs dev            (runs the project's dev script with this preloaded)
 *   NODE_OPTIONS="--enable-source-maps --import qaisdebugs/agent" next dev
 *
 * Nothing here may ever break the dev server.
 */
try {
  install();
} catch (error) {
  process.stderr.write(`[${process.env.QAISDEBUGS_BRAND || 'qaisdebugs'}] agent failed to install: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
}
