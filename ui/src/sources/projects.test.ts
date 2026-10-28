import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../events';
import { automaticProject, projectOf, runningProjects } from './projects';

const agent = (app: string, repoRoot: string | undefined, cwd = `${repoRoot ?? '/x'}/apps/${app}`): AgentEvent =>
  ({ kind: 'agent', app, repoRoot, cwd, pid: 1, version: '0.3.0', at: 0 }) as AgentEvent;

describe('runningProjects', () => {
  it('groups the apps of one repository into one project, sorted by name', () => {
    const projects = runningProjects([agent('rental', '/work/tajeer'), agent('gov', '/work/tajeer'), agent('site', '/work/world-clock')]);
    expect(projects.map((project) => [project.name, project.agents.map((entry) => entry.app)])).toEqual([
      ['tajeer', ['rental', 'gov']],
      ['world-clock', ['site']],
    ]);
  });

  it('uses the app folder for an app outside a repository', () => {
    expect(runningProjects([agent('clock', undefined, '/work/clock')])[0]).toMatchObject({ root: '/work/clock', name: 'clock' });
  });
});

describe('projectOf', () => {
  const projects = runningProjects([agent('web', '/work/shop'), agent('ui', '/work/shop/packages/ui'), agent('crm', '/work/crm')]);

  it('finds the deepest project that holds the file', () => {
    expect(projectOf('/work/shop/packages/ui/Button.tsx', projects)?.root).toBe('/work/shop/packages/ui');
    expect(projectOf('/work/crm/app/page.tsx', projects)?.root).toBe('/work/crm');
  });

  it('does not match a sibling folder with a longer name', () => {
    expect(projectOf('/work/shop-old/page.tsx', projects)).toBeUndefined();
  });
});

describe('automaticProject', () => {
  const two = runningProjects([agent('web', '/work/shop'), agent('crm', '/work/crm')]);

  it('picks the only running project', () => {
    expect(automaticProject(runningProjects([agent('web', '/work/shop')]), undefined)).toBe('/work/shop');
  });

  it('keeps the project picked last time while it runs', () => {
    expect(automaticProject(two, '/work/crm')).toBe('/work/crm');
  });

  it('asks when several run and none was picked, or the picked one stopped', () => {
    expect(automaticProject(two, undefined)).toBeUndefined();
    expect(automaticProject(two, '/work/gone')).toBeUndefined();
  });
});
