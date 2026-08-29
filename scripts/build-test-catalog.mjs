import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTestCatalog } from '../src/map-catalog.js';
import { enrichTestGovernance } from '../src/test-governance.js';
import { buildScenarioCatalog } from '../src/test-scenario-catalog.js';
import {
  buildOverviewLayoutExperiments,
  serializeOverviewLayoutExperiments
} from '../src/map-overview-layouts.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputPath = resolve(ROOT, 'public/data/lifeline-test-map.json');
const staticCatalog = await buildTestCatalog({ root: ROOT });
const catalog = enrichTestGovernance(staticCatalog);
const scenarioCatalog = buildScenarioCatalog({
  project: catalog.project,
  testCatalog: catalog,
  openApi: JSON.parse(await readFile(resolve(ROOT, 'openapi.json'), 'utf8')),
  sourceDocuments: [{
    uri: 'src/domain.js',
    content: await readFile(resolve(ROOT, 'src/domain.js'), 'utf8')
  }],
  generatedAt: catalog.generatedAt
});
const layoutExperiments = await buildOverviewLayoutExperiments(catalog);
const output = {
  ...catalog,
  scenarioCatalog,
  layoutExperiments: serializeOverviewLayoutExperiments(layoutExperiments)
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

console.log(`Built ${catalog.summary.testCount} tests with ${layoutExperiments.size} layouts from ${catalog.summary.fileCount} files → ${outputPath}`);
