/**
 * QaisDebugs — the projects the inspector can show sources from.
 *
 * One collector serves every dev server started through qaisdebugs, so two projects can report to
 * it at once. Each agent announces its repository root (or its app folder when it has none); those
 * roots, plus the folder the collector itself was started for, are the only places source files
 * are read from.
 */
import path from 'node:path';

/** The root an agent's files live under. */
export const agentRoot = (agent) => agent.repoRoot || agent.cwd;

/** Every project root, the collector's own first, without duplicates. */
export function projectRoots(collectorRoot, agents) {
  return [...new Set([collectorRoot, ...agents.map(agentRoot).filter(Boolean)])];
}

/** The root that contains `file`, deepest first, or undefined. Both sides must already be real paths. */
export function rootContaining(file, roots) {
  return [...roots].sort((a, b) => b.length - a.length).find((root) => file.startsWith(root + path.sep));
}
