import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  buildTestCatalog,
  classifyScenarios,
  extractTestDeclarations
} from '../src/map-catalog.js';
import {
  buildFocusLayout,
  hydrateOverviewLayoutExperiments,
  spreadOverviewLayout
} from '../src/quality-map-layout.js';
import {
  selectSemanticLabelCandidates,
  semanticDomainQuota
} from '../src/quality-map-labels.js';
import {
  buildElkOverviewLayout,
  buildIslandOverviewLayout,
  serializeOverviewLayoutExperiments
} from '../src/map-overview-layouts.js';
import { getProjectTestMap, isLifelineProject } from '../src/project-test-map.js';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

test('test catalog parser extracts node:test declarations without executing the source', () => {
  const source = [
    'const fixture = `',
    "test('not a declaration', () => {});",
    '`;',
    "test('plain declaration', () => {});",
    'test.skip("skipped declaration", () => {});',
    'it(',
    '  `multiline declaration`,',
    '  () => {}',
    ');'
  ].join('\n');

  assert.deepEqual(extractTestDeclarations(source), [
    { call: 'test', modifier: null, title: 'plain declaration', line: 4 },
    { call: 'test', modifier: 'skip', title: 'skipped declaration', line: 5 },
    { call: 'it', modifier: null, title: 'multiline declaration', line: 6 }
  ]);
});

test('Lifeline test catalog contains every real test declaration with file and line evidence', async () => {
  const catalog = await buildTestCatalog({ root: ROOT, generatedAt: '2026-08-27T00:00:00.000Z' });

  assert.equal(catalog.configured, true);
  assert.ok(catalog.summary.fileCount >= 31);
  assert.ok(catalog.summary.testCount >= 178);
  assert.equal(catalog.tests.length, catalog.summary.testCount);
  assert.ok(catalog.tests.every((entry) => entry.file.startsWith('test/')));
  assert.ok(catalog.tests.every((entry) => Number.isInteger(entry.line) && entry.line > 0));
  assert.ok(catalog.tests.every((entry) => entry.status === 'UNOBSERVED'));
  assert.ok(catalog.tests.every((entry) => entry.scenarioIds.length >= 1));
});

test('shared board persistence test becomes a cross-scenario interchange station', async () => {
  const catalog = await buildTestCatalog({ root: ROOT, generatedAt: '2026-08-27T00:00:00.000Z' });
  const sharedBoard = catalog.tests.find((entry) => (
    entry.file === 'test/client-board.test.js'
    && /placement persists status and phase/i.test(entry.title)
  ));

  assert.ok(sharedBoard);
  assert.equal(sharedBoard.domainId, 'client-experience');
  assert.equal(sharedBoard.transfer, true);
  assert.ok(sharedBoard.scenarioIds.includes('client-board'));
  assert.ok(sharedBoard.scenarioIds.includes('state-flow'));
  assert.ok(sharedBoard.scenarioIds.includes('data-consistency'));
  assert.ok(sharedBoard.scenarioIds.includes('run-lifecycle'));
  assert.ok(sharedBoard.sourceModules.includes('src/service.js'));
});

test('scenario classification does not infer interchange lines from the file name alone', () => {
  assert.deepEqual(
    classifyScenarios('dependency-schedule.test.js', 'returns the current result'),
    ['dependency-order']
  );
});

test('semantic label quota increases continuously from overview to context and detail', () => {
  const overview = semanticDomainQuota({ cameraRatio: 1, domainCoverage: .08, visibleCount: 30 });
  const context = semanticDomainQuota({ cameraRatio: .25, domainCoverage: .42, visibleCount: 30 });
  const detail = semanticDomainQuota({ cameraRatio: .035, domainCoverage: .9, visibleCount: 30 });

  assert.ok(overview >= 3 && overview <= 6);
  assert.ok(context >= 10 && context <= 20);
  assert.ok(context > overview);
  assert.equal(detail, 30);
});

test('semantic labels keep selected tests first and represent every major scenario', () => {
  const tests = [
    labelFixture('a1', 'domain-a', ['state'], { transfer: true }),
    labelFixture('a2', 'domain-a', ['permission']),
    labelFixture('a3', 'domain-a', ['recovery']),
    labelFixture('a4', 'domain-a', ['state']),
    labelFixture('a5', 'domain-a', ['permission']),
    labelFixture('b1', 'domain-b', ['recovery'], { riskTags: ['恢复路径'] }),
    labelFixture('b2', 'domain-b', ['contract']),
    labelFixture('b3', 'domain-b', ['contract']),
    labelFixture('b4', 'domain-b', ['state']),
    labelFixture('b5', 'domain-b', ['permission'])
  ];
  const selected = selectSemanticLabelCandidates({
    tests,
    cameraRatio: 1,
    domainCoverageById: new Map([['domain-a', .12], ['domain-b', .12]]),
    selectedTestId: 'a5'
  });
  const represented = new Set(selected.flatMap((entry) => entry.test.scenarioIds));

  assert.equal(selected[0].test.id, 'a5');
  assert.ok(represented.has('state'));
  assert.ok(represented.has('permission'));
  assert.ok(represented.has('recovery'));
  assert.ok(represented.has('contract'));
});

test('focus layout expands one selected test into deterministic semantic branches', async () => {
  const catalog = await buildTestCatalog({ root: ROOT, generatedAt: '2026-08-27T00:00:00.000Z' });
  const selected = catalog.tests.find((entry) => (
    entry.file === 'test/client-board.test.js'
    && /placement persists status and phase/i.test(entry.title)
  ));
  const overviewLayout = {
    positions: new Map(catalog.tests.map((entry, index) => [entry.id, {
      x: (index % 24) * 80,
      y: Math.floor(index / 24) * 80
    }]))
  };

  const first = buildFocusLayout({
    catalog,
    overviewLayout,
    selectedTestId: selected.id,
    visibleDomainIds: catalog.domains.map((domain) => domain.id)
  });
  const second = buildFocusLayout({
    catalog,
    overviewLayout,
    selectedTestId: selected.id,
    visibleDomainIds: catalog.domains.map((domain) => domain.id)
  });

  assert.equal(first.visibleTestIds.has(selected.id), true);
  assert.ok(first.visibleTestIds.size > 4 && first.visibleTestIds.size <= 8);
  assert.equal(first.directions.get('client-board'), 'west');
  assert.equal(first.directions.get('state-flow'), 'north');
  assert.equal(first.directions.get('run-lifecycle'), 'east');
  assert.equal(first.directions.get('data-consistency'), 'south');
  assert.deepEqual(first.positions.get(selected.id), overviewLayout.positions.get(selected.id));
  assert.deepEqual([...first.positions], [...second.positions]);
  assert.deepEqual([...first.routes], [...second.routes]);

  const relatedIds = [...first.routes.values()]
    .flat()
    .filter((id) => id !== selected.id);
  assert.equal(new Set(relatedIds).size, relatedIds.length);
  assert.ok([...first.routePoints.values()].every((points) => points.length >= 3));
});

test('expanded layout experiments place every test in stable non-overlapping domain regions', async () => {
  const catalog = await buildTestCatalog({ root: ROOT, generatedAt: '2026-08-27T00:00:00.000Z' });
  const [firstIslands, firstElk] = await Promise.all([
    buildIslandOverviewLayout(catalog),
    buildElkOverviewLayout(catalog)
  ]);
  const [secondIslands, secondElk] = await Promise.all([
    buildIslandOverviewLayout(catalog),
    buildElkOverviewLayout(catalog)
  ]);

  for (const layout of [firstIslands, firstElk]) {
    assert.equal(layout.positions.size, catalog.tests.length);
    assert.equal(layout.domainBounds.size, catalog.domains.length);
    assert.equal(layout.routes.size, catalog.scenarios.length);
    assert.ok([...layout.positions.values()].every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
    assert.equal(overlappingBounds([...layout.domainBounds.values()]).length, 0);
    assert.ok(layout.extent.maxX - layout.extent.minX > 1_400);
    assert.ok(layout.extent.maxY - layout.extent.minY > 900);
  }

  assert.deepEqual([...firstIslands.positions], [...secondIslands.positions]);
  assert.deepEqual([...firstElk.positions], [...secondElk.positions]);
  assert.equal(firstIslands.domainShape, 'circle');
  assert.equal(firstIslands.label, '轨道星域');

  for (const domain of catalog.domains) {
    const points = catalog.tests
      .filter((entry) => entry.domainId === domain.id)
      .map((entry) => firstIslands.positions.get(entry.id));
    assert.ok(minimumPointDistance(points) >= 50, `${domain.id} contains compressed island stations`);
    const bounds = firstIslands.domainBounds.get(domain.id);
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    const center = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
    assert.ok(Math.abs(width - height) < 1e-6, `${domain.id} is not a circular field`);
    assert.ok(points.every((point) => Math.hypot(point.x - center.x, point.y - center.y) <= width / 2 - 50));
    if (points.length >= 20) {
      const radii = new Set(points.map((point) => Math.round(Math.hypot(point.x - center.x, point.y - center.y))));
      const quadrants = new Set(points.map((point) => `${point.x >= center.x ? 1 : 0}:${point.y >= center.y ? 1 : 0}`));
      assert.ok(radii.size >= 2, `${domain.id} does not use multiple orbital rings`);
      assert.ok(quadrants.size >= 3, `${domain.id} does not distribute stations around the field`);
    }
  }

  const hydrated = hydrateOverviewLayoutExperiments(serializeOverviewLayoutExperiments(new Map([
    ['islands', firstIslands],
    ['elk', firstElk]
  ])));
  assert.deepEqual([...hydrated.get('islands').positions], [...firstIslands.positions]);
  assert.equal(hydrated.get('islands').domainShape, 'circle');
  assert.deepEqual([...hydrated.get('elk').domainBounds], [...firstElk.domainBounds]);
});

test('display spread expands stations inside each domain without mutating the base layout', async () => {
  const catalog = await buildTestCatalog({ root: ROOT, generatedAt: '2026-08-27T00:00:00.000Z' });
  const layouts = await Promise.all([
    buildIslandOverviewLayout(catalog),
    buildElkOverviewLayout(catalog)
  ]);

  for (const baseLayout of layouts) {
    const basePositions = [...baseLayout.positions].map(([id, point]) => [id, { ...point }]);
    const expanded = spreadOverviewLayout({ catalog, layout: baseLayout, factor: 1.5 });
    assert.equal(expanded.spreadFactor, 1.5);
    assert.equal(overlappingBounds([...expanded.domainBounds.values()]).length, 0);
    assert.deepEqual([...baseLayout.positions], basePositions);
    assert.deepEqual([...expanded.routes], [...baseLayout.routes]);
    assert.ok(Number.isFinite(expanded.extent.minX) && Number.isFinite(expanded.extent.maxY));
    for (const domain of catalog.domains.filter((entry) => entry.testCount > 1)) {
      const ids = catalog.tests.filter((entry) => entry.domainId === domain.id).map((entry) => entry.id);
      const before = minimumPointDistance(ids.map((id) => baseLayout.positions.get(id)));
      const after = minimumPointDistance(ids.map((id) => expanded.positions.get(id)));
      assert.ok(after >= before * 1.499, `${domain.id} did not expand within its field`);
    }
  }
});

test('baseline Lifeline domains preserve the audited real-test grouping', async () => {
  const catalog = await buildTestCatalog({ root: ROOT, generatedAt: '2026-08-27T00:00:00.000Z' });
  const counts = Object.fromEntries(catalog.domains.map((entry) => [entry.id, entry.testCount]));

  assert.equal(counts.scheduling, 60);
  assert.equal(counts['agent-execution'], 32);
  assert.equal(counts['client-experience'], 30);
  assert.equal(counts.subscriptions, 21);
  assert.equal(counts['storage-projects'], 15);
  assert.equal(counts['collaborative-canvas'], 11);
  assert.ok(counts['mcp-integration'] >= 17);
});

test('project test map serves the packaged Lifeline catalog and leaves unsubmitted projects empty', async () => {
  const project = {
    id: 'project-lifeline',
    name: 'Lifeline',
    repositoryUrl: 'https://github.com/qzhqzh/Lifeline'
  };
  assert.equal(isLifelineProject(project), true);

  const configured = await getProjectTestMap(project, ROOT);
  assert.equal(configured.configured, true);
  assert.equal(configured.project.id, project.id);
  assert.ok(configured.tests.length >= 173);
  assert.equal(configured.qualityCategories.length, 8);
  assert.ok(configured.qualityCategories.every((entry) => entry.testCount > 0));
  if (process.env.LIFELINE_EVIDENCE_CAPTURE !== '1') {
    assert.equal(configured.summary.observedCount, configured.summary.testCount);
    assert.equal(configured.runtimeEvidence.testReport.failed, 0);
    assert.equal(
      configured.runtimeEvidence.declarationCount,
      configured.runtimeEvidence.runnerEntryCount
    );
  }
  assert.ok(configured.scenarioCatalog.summary.missing > 0);
  assert.ok(configured.scenarioCatalog.scenarios.every((entry) => entry.sourceEvidence.length > 0));
  assert.equal('model' in configured, false);
  assert.equal('confidence' in configured, false);

  const unsupported = await getProjectTestMap({
    id: 'project-other',
    name: 'Other',
    repositoryUrl: 'https://example.com/other'
  }, ROOT);
  assert.equal(unsupported.configured, false);
  assert.deepEqual(unsupported.tests, []);
});

test('test map ships as a local Sigma surface with project-preserving navigation', async () => {
  const [html, css, source, clientHtml, canvasHtml, server, openapi] = await Promise.all([
    readFile(new URL('../public/test-map.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/test-map.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/quality-map.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/client.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/canvas.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.js', import.meta.url), 'utf8'),
    readFile(new URL('../openapi.json', import.meta.url), 'utf8')
  ]);

  assert.match(html, /lifeline-test-map-sigma-v1/);
  assert.match(html, /src="\/quality-map\.bundle\.js"/);
  assert.match(html, /id="testMinimap"/);
  assert.match(html, /id="testInspector"/);
  assert.match(html, /id="layoutSwitcher"/);
  assert.match(html, /id="nodeSpread"/);
  assert.match(html, /id="nodeStyleSwitcher"/);
  assert.match(html, /id="qualityCategoryFilters"/);
  assert.match(html, /id="showAllQualityCategories"/);
  assert.match(html, /id="scenarioGapSummary"/);
  assert.match(html, /data-node-style="rings"/);
  assert.match(html, /data-layout-mode="islands"/);
  assert.match(html, /data-layout-mode="elk"/);
  assert.match(html, /轨道星域/);
  assert.doesNotMatch(html, /cdn\.jsdelivr|unpkg|esm\.sh/);
  assert.match(css, /\.test-route-layer/);
  assert.match(css, /\.map-layout-switch/);
  assert.match(css, /\.map-display-settings/);
  assert.match(css, /data-node-style="rings"/);
  assert.match(css, /\.quality-category-filter/);
  assert.match(css, /\.scenario-gap-summary/);
  assert.match(css, /\.gap-key/);
  assert.match(source, /import Sigma from 'sigma'/);
  assert.match(source, /import Graph from 'graphology'/);
  assert.match(source, /buildFocusLayout/);
  assert.match(source, /hydrateOverviewLayoutExperiments/);
  assert.match(source, /spreadOverviewLayout/);
  assert.match(source, /function applySpreadLayout/);
  assert.match(source, /function setNodeStyle/);
  assert.match(source, /switchOverviewLayout/);
  assert.match(source, /orbitalRoutePoints/);
  assert.match(source, /nodeFillColor/);
  assert.match(source, /selectedQualityCategoryId/);
  assert.match(source, /qualityCategoryIds/);
  assert.match(source, /runtimeEvidence/);
  assert.match(source, /scenarioGaps/);
  assert.match(source, /gapWorkflowActions/);
  assert.match(source, /test-governance:review/);
  assert.match(source, /CREATE_DRAFT/);
  assert.match(source, /projectAccessHeaders/);
  assert.match(source, /function renderQualityCategoryFilters/);
  assert.match(source, /zoomToSizeRatioFunction: \(\) => 1/);
  assert.match(source, /drawSemanticLabels/);
  assert.match(source, /semanticLabelPaintMs/);
  assert.doesNotMatch(source, /mapLabel\(/);
  assert.match(source, /function focusTest\(testId, \{ animate = true, revealInspector = true, moveCamera = false \} = \{\}\)/);
  assert.match(source, /if \(nearest\) focusTest\(nearest\.id, \{ moveCamera: true \}\)/);
  assert.doesNotMatch(source, /state\.selectedTestId = testId;\s*activateFocusLayout\(testId\)/);
  assert.match(clientHtml, /id="testMapNavLink"/);
  assert.match(canvasHtml, /id="testMapNavLink"/);
  assert.match(server, /\/test-map\$/);
  assert.match(server, /\/test-scenario-proposals/);
  assert.match(server, /\/draft\$/);
  assert.match(server, /\/runs/);
  assert.match(server, /\/verify/);
  assert.match(openapi, /\/api\/projects\/\{projectId\}\/test-map/);
  assert.match(openapi, /\/api\/projects\/\{projectId\}\/test-scenario-proposals/);
});

function labelFixture(id, domainId, scenarioIds, overrides = {}) {
  return {
    id,
    domainId,
    scenarioIds,
    title: `complete test title ${id}`,
    file: `test/${id}.test.js`,
    line: 1,
    status: 'UNOBSERVED',
    transfer: false,
    riskTags: ['行为回归'],
    ...overrides
  };
}

function overlappingBounds(bounds) {
  const overlaps = [];
  for (let left = 0; left < bounds.length; left += 1) {
    for (let right = left + 1; right < bounds.length; right += 1) {
      const a = bounds[left];
      const b = bounds[right];
      if (a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY) {
        overlaps.push([left, right]);
      }
    }
  }
  return overlaps;
}

function minimumPointDistance(points) {
  let minimum = Infinity;
  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      const dx = points[left].x - points[right].x;
      const dy = points[left].y - points[right].y;
      minimum = Math.min(minimum, Math.hypot(dx, dy));
    }
  }
  return minimum;
}
