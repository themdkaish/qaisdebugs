import type { AgentEvent } from '../events';

/**
 * The projects with a running dev server. One inspector serves every dev server started through
 * qaisdebugs, so when two projects run at once the Sources view asks which one to show.
 */
export interface Project {
  /** The repository root, or the app folder when the app is not inside a repository. */
  root: string;
  name: string;
  /** The dev servers running from this project. */
  agents: AgentEvent[];
}

export const agentRoot = (agent: AgentEvent): string => agent.repoRoot || agent.cwd;

/** One entry per project root, with the apps running from it, sorted by name. */
export function runningProjects(agents: AgentEvent[]): Project[] {
  const byRoot = new Map<string, Project>();
  for (const agent of agents) {
    const root = agentRoot(agent);
    if (!root) continue;
    const project = byRoot.get(root) ?? { root, name: root.split('/').filter(Boolean).at(-1) ?? root, agents: [] };
    project.agents.push(agent);
    byRoot.set(root, project);
  }

  return [...byRoot.values()].sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
}

/** The project a file belongs to: the deepest root that contains it. */
export function projectOf(file: string, projects: Project[]): Project | undefined {
  return [...projects].sort((a, b) => b.root.length - a.root.length).find((project) => file.startsWith(`${project.root}/`));
}

/**
 * Which project to show without asking: the only one running, or the one picked last time if it
 * is still running. Undefined means ask (two or more are running) or show the inspector's own
 * project (none is running).
 */
export function automaticProject(projects: Project[], remembered: string | undefined): string | undefined {
  if (projects.length === 1) return projects[0].root;

  return projects.find((project) => project.root === remembered)?.root;
}
