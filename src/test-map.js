import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const LIFELINE_REPOSITORIES = new Set([
  'https://github.com/qzhqzh/Lifeline',
  'git@github.com:qzhqzh/Lifeline.git'
]);

export async function getProjectTestMap(project, root) {
  const submittedPath = join(root, 'data/test-catalogs', catalogFileName(project.id));
  const submitted = await readOptionalCatalog(submittedPath);
  const catalog = submitted ?? (isLifelineProject(project)
    ? JSON.parse(await readFile(join(root, 'public/data/lifeline-test-map.json'), 'utf8'))
    : null);
  if (!catalog) return emptyCatalog(project);
  return {
    ...catalog,
    project: {
      id: project.id,
      name: project.name,
      repositoryUrl: project.repositoryUrl ?? catalog.project.repositoryUrl
    }
  };
}

export function catalogFileName(projectId) {
  return `${String(projectId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

export function isLifelineProject(project) {
  if (!project || typeof project !== 'object') return false;
  if (LIFELINE_REPOSITORIES.has(String(project.repositoryUrl ?? '').replace(/\.git$/, ''))) return true;
  return project.name === 'Lifeline' && /Lifeline(?:\.git)?$/i.test(String(project.repositoryUrl ?? ''));
}

async function readOptionalCatalog(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function emptyCatalog(project) {
  return {
    version: 2,
    configured: false,
    project: {
      id: project.id,
      name: project.name,
      repositoryUrl: project.repositoryUrl ?? null
    },
    summary: { testCount: 0, fileCount: 0, domainCount: 0, scenarioCount: 0, transferCount: 0, observedCount: 0 },
    domains: [],
    scenarios: [],
    tests: []
  };
}
