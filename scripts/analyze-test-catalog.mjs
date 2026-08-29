import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import { analyzeTestRepository } from '../src/catalog-analyzer.js';
import { enrichTestGovernance } from '../src/test-governance.js';
import { buildScenarioCatalog } from '../src/test-scenario-catalog.js';
import {
  buildOverviewLayoutExperiments,
  serializeOverviewLayoutExperiments
} from '../src/map-overview-layouts.js';

const options = parseArguments(process.argv.slice(2));
const root = resolve(options.root ?? process.cwd());
const outputPath = resolve(options.output ?? resolve(root, '.lifeline/test-catalog.json'));
const cachePath = resolve(options.cache ?? resolve(dirname(outputPath), '.test-catalog-cache.json'));
const analyzed = await analyzeTestRepository({
  root,
  projectName: options.projectName ?? basename(root),
  repositoryUrl: options.repositoryUrl ?? null,
  cachePath
});
const catalog = enrichTestGovernance(analyzed);
const openApiText = await readOptionalText(resolve(root, 'openapi.json'));
const domainSource = await readOptionalText(resolve(root, 'src/domain.js'));
const scenarioCatalog = buildScenarioCatalog({
  project: catalog.project,
  testCatalog: catalog,
  openApi: openApiText ? JSON.parse(openApiText) : null,
  sourceDocuments: domainSource ? [{ uri: 'src/domain.js', content: domainSource }] : [],
  generatedAt: catalog.generatedAt
});
const output = options.layouts === false
  ? { ...catalog, scenarioCatalog }
  : {
      ...catalog,
      scenarioCatalog,
      layoutExperiments: serializeOverviewLayoutExperiments(await buildOverviewLayoutExperiments(catalog))
    };

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(`Analyzed ${catalog.summary.testCount} tests from ${catalog.summary.fileCount} files (${catalog.source.cache.hitCount} cached) → ${outputPath}`);

function parseArguments(values) {
  const result = { layouts: true };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--no-layouts') {
      result.layouts = false;
      continue;
    }
    const key = {
      '--root': 'root',
      '--output': 'output',
      '--cache': 'cache',
      '--project-name': 'projectName',
      '--repository-url': 'repositoryUrl'
    }[value];
    if (!key || !values[index + 1]) throw new Error(`Unknown or incomplete argument: ${value}`);
    result[key] = values[index + 1];
    index += 1;
  }
  return result;
}

async function readOptionalText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
