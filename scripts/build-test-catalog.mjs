import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTestCatalog } from '../src/test-map-catalog.js';
import {
  buildOverviewLayoutExperiments,
  serializeOverviewLayoutExperiments
} from '../src/test-map-overview-layouts.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputPath = resolve(ROOT, 'public/data/lifeline-test-map.json');
const catalog = await buildTestCatalog({ root: ROOT });
const layoutExperiments = await buildOverviewLayoutExperiments(catalog);
const output = {
  ...catalog,
  layoutExperiments: serializeOverviewLayoutExperiments(layoutExperiments)
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

console.log(`Built ${catalog.summary.testCount} tests with ${layoutExperiments.size} layouts from ${catalog.summary.fileCount} files → ${outputPath}`);
