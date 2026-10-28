/**
 * QaisDebugs — the dev servers the collector knows about.
 *
 * Every agent announces itself once when its dev server starts, and never says goodbye: a dev
 * server stopped with Ctrl+C, a closed terminal or a crash simply goes away. The collector outlives
 * them all, so it checks the announced pids and forgets a server once its process is gone. The
 * agents run on this machine (they talk to the collector over loopback), so their pids are local.
 */

/** Whether a process with this pid is running. EPERM means it exists but belongs to someone else. */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Removes the agents whose process has exited from `agents` (a Map of app name → announcement)
 * and returns the names of the apps removed.
 */
export function pruneAgents(agents, alive = isAlive) {
  const removed = [];
  for (const [app, agent] of agents) {
    if (alive(agent.pid)) continue;
    agents.delete(app);
    removed.push(app);
  }

  return removed;
}
