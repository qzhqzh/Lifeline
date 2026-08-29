import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyTestEvidence, buildEvidenceScenarioCandidates } from './test-evidence.js';
import { enrichTestGovernance } from './test-governance.js';
import { matchScenarioCatalog } from './test-scenario-catalog.js';

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
  const submittedEvidence = await readOptionalCatalog(join(
    root,
    'data/test-evidence',
    catalogFileName(project.id)
  ));
  const packagedEvidence = !submittedEvidence && isLifelineProject(project)
    ? await readOptionalCatalog(join(root, 'public/data/lifeline-test-evidence.json'))
    : null;
  const evidenced = applyTestEvidence(catalog, submittedEvidence ?? packagedEvidence);
  const governed = enrichTestGovernance(evidenced);
  const scenarioCatalog = matchScenarioCatalog(governed.scenarioCatalog, governed);
  const evidenceScenarios = buildEvidenceScenarioCandidates(submittedEvidence ?? packagedEvidence, governed);
  const mergedScenarioCatalog = evidenceScenarios.length > 0
    ? matchScenarioCatalog({
        ...scenarioCatalog,
        scenarios: [
          ...scenarioCatalog.scenarios,
          ...evidenceScenarios.filter((candidate) => !scenarioCatalog.scenarios.some((entry) => entry.scenarioId === candidate.scenarioId))
        ]
      }, governed)
    : scenarioCatalog;
  return {
    ...governed,
    project: {
      id: project.id,
      name: project.name,
      repositoryUrl: project.repositoryUrl ?? governed.project.repositoryUrl
    },
    scenarioCatalog: mergedScenarioCatalog
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
    qualityCategories: [],
    qualitySummary: { covered: 0, partial: 0, missing: 0, unobserved: 0, obsolete: 0 },
    scenarioCatalog: {
      version: 'scenario-catalog/v1',
      summary: { scenarioCount: 0, covered: 0, partial: 0, missing: 0, unobserved: 0, obsolete: 0 },
      scenarios: []
    },
    domains: [],
    scenarios: [],
    tests: []
  };
}
