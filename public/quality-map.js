import Graph from 'graphology';
import Sigma from 'sigma';
import {
  buildFocusLayout,
  hydrateOverviewLayoutExperiments,
  spreadOverviewLayout
} from '../src/quality-map-layout.js';
import { selectSemanticLabelCandidates } from '../src/quality-map-labels.js';
import { clearProjectAccessToken, projectAccessHeaders } from './project-access.js';

const DEFAULT_NODE_SPREAD = 1.2;
const initialParams = new URLSearchParams(window.location.search);

const state = {
  projects: [],
  selectedProjectId: initialParams.get('project'),
  catalog: null,
  graph: null,
  renderer: null,
  layout: null,
  overviewLayout: null,
  layoutExperiments: new Map(),
  layoutMode: initialParams.get('layout') === 'elk' ? 'elk' : 'islands',
  nodeSpread: parseNodeSpread(initialParams.get('spread')),
  nodeStyle: initialParams.get('nodes') === 'rings' ? 'rings' : 'solid',
  focusLayout: null,
  focusVisibleTestIds: new Set(),
  viewMode: 'overview',
  selectedDomainIds: new Set(),
  selectedQualityCategoryId: null,
  focusedScenarioId: null,
  selectedTestId: null,
  selectedGapId: null,
  hoveredTestId: null,
  hoveredGapId: null,
  requestController: null,
  resizeObserver: null,
  redrawFrame: null,
  spreadFrame: null,
  semanticLabelMeasureCache: new Map(),
  toastTimer: null,
  minimapTransform: null,
  filtersOpen: false,
  inspectorOpen: false
};

const elements = {
  projectSelect: document.querySelector('#projectSelect'),
  projectProgressNavLink: document.querySelector('#projectProgressNavLink'),
  testMapNavLink: document.querySelector('#testMapNavLink'),
  canvasNavLink: document.querySelector('#canvasNavLink'),
  sidebar: document.querySelector('#testMapSidebar'),
  closeFilters: document.querySelector('#closeFilters'),
  openFilters: document.querySelector('#openFilters'),
  backdrop: document.querySelector('#mapBackdrop'),
  search: document.querySelector('#testSearch'),
  searchResults: document.querySelector('#testSearchResults'),
  catalogStamp: document.querySelector('#catalogStamp'),
  catalogSummary: document.querySelector('#catalogSummary'),
  qualityCategoryFilters: document.querySelector('#qualityCategoryFilters'),
  showAllQualityCategories: document.querySelector('#showAllQualityCategories'),
  scenarioGapSummary: document.querySelector('#scenarioGapSummary'),
  domainFilters: document.querySelector('#domainFilters'),
  toggleDomains: document.querySelector('#toggleDomains'),
  routeFilters: document.querySelector('#routeFilters'),
  showAllRoutes: document.querySelector('#showAllRoutes'),
  layoutSwitcher: document.querySelector('#layoutSwitcher'),
  nodeSpread: document.querySelector('#nodeSpread'),
  nodeSpreadValue: document.querySelector('#nodeSpreadValue'),
  nodeStyleSwitcher: document.querySelector('#nodeStyleSwitcher'),
  toolbarTitle: document.querySelector('#mapToolbarTitle'),
  visibleTestCount: document.querySelector('#visibleTestCount'),
  surface: document.querySelector('#testMapSurface'),
  graph: document.querySelector('#testGraph'),
  routeLayer: document.querySelector('#testRouteLayer'),
  mapState: document.querySelector('#mapState'),
  mapStateTitle: document.querySelector('#mapStateTitle'),
  mapStateDetail: document.querySelector('#mapStateDetail'),
  retry: document.querySelector('#retryTestMap'),
  mapKey: document.querySelector('#mapKey'),
  minimapButton: document.querySelector('#testMinimapButton'),
  minimap: document.querySelector('#testMinimap'),
  mapStatus: document.querySelector('#mapStatus'),
  mapEngine: document.querySelector('#mapEngine'),
  inspector: document.querySelector('#testInspector'),
  inspectorEmpty: document.querySelector('#inspectorEmpty'),
  inspectorContent: document.querySelector('#inspectorContent'),
  zoomIn: document.querySelector('#zoomIn'),
  zoomOut: document.querySelector('#zoomOut'),
  resetView: document.querySelector('#resetView'),
  toast: document.querySelector('#testMapToast')
};

elements.projectSelect.addEventListener('change', async () => {
  state.selectedProjectId = elements.projectSelect.value;
  updateUrl({ replace: false });
  updateProjectLinks();
  await loadTestMap();
});

elements.search.addEventListener('input', renderSearchResults);
elements.search.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    const first = elements.searchResults.querySelector('[data-search-test]');
    if (first) {
      event.preventDefault();
      focusTest(first.dataset.searchTest);
    }
  }
  if (event.key === 'Escape') hideSearchResults();
});

elements.searchResults.addEventListener('click', (event) => {
  const result = event.target.closest('[data-search-test]');
  if (result) focusTest(result.dataset.searchTest);
});

elements.qualityCategoryFilters.addEventListener('click', (event) => {
  const filter = event.target.closest('[data-quality-category-id]');
  if (!filter) return;
  state.selectedQualityCategoryId = state.selectedQualityCategoryId === filter.dataset.qualityCategoryId
    ? null
    : filter.dataset.qualityCategoryId;
  keepSelectionVisible();
  applyFilters();
});

elements.showAllQualityCategories.addEventListener('click', () => {
  state.selectedQualityCategoryId = null;
  applyFilters();
});

elements.domainFilters.addEventListener('click', (event) => {
  const filter = event.target.closest('[data-domain-id]');
  if (!filter) return;
  const domainId = filter.dataset.domainId;
  if (state.selectedDomainIds.has(domainId)) state.selectedDomainIds.delete(domainId);
  else state.selectedDomainIds.add(domainId);
  if (state.viewMode === 'focus') {
    const selected = testById(state.selectedTestId);
    if (!selected || !state.selectedDomainIds.has(selected.domainId)) return clearSelection();
    activateFocusLayout(selected.id);
  }
  applyFilters();
});

elements.toggleDomains.addEventListener('click', () => {
  const domains = state.catalog?.domains.filter((entry) => entry.testCount > 0) ?? [];
  if (state.selectedDomainIds.size === domains.length) state.selectedDomainIds.clear();
  else state.selectedDomainIds = new Set(domains.map((entry) => entry.id));
  if (state.viewMode === 'focus') {
    const selected = testById(state.selectedTestId);
    if (!selected || !state.selectedDomainIds.has(selected.domainId)) return clearSelection();
    activateFocusLayout(selected.id);
  }
  applyFilters();
});

elements.routeFilters.addEventListener('click', (event) => {
  const filter = event.target.closest('[data-scenario-id]');
  if (!filter) return;
  state.focusedScenarioId = state.focusedScenarioId === filter.dataset.scenarioId
    ? null
    : filter.dataset.scenarioId;
  applyFilters();
});

elements.showAllRoutes.addEventListener('click', () => {
  state.focusedScenarioId = null;
  applyFilters();
});

elements.zoomIn.addEventListener('click', () => state.renderer?.getCamera().animatedZoom({ duration: 260 }));
elements.zoomOut.addEventListener('click', () => state.renderer?.getCamera().animatedUnzoom({ duration: 260 }));
elements.resetView.addEventListener('click', showOverview);
elements.retry.addEventListener('click', loadTestMap);
elements.openFilters.addEventListener('click', () => setFiltersOpen(true));
elements.closeFilters.addEventListener('click', () => setFiltersOpen(false));
elements.backdrop.addEventListener('click', closeMobilePanels);
elements.minimapButton.addEventListener('click', focusNearestFromMinimap);
elements.layoutSwitcher.addEventListener('click', (event) => {
  const button = event.target.closest('[data-layout-mode]');
  if (button) switchOverviewLayout(button.dataset.layoutMode);
});
elements.nodeSpread.addEventListener('input', () => {
  state.nodeSpread = parseNodeSpread(elements.nodeSpread.value);
  renderDisplayControls();
  scheduleSpreadUpdate();
});
elements.nodeSpread.addEventListener('change', () => {
  flushSpreadUpdate();
  updateUrl({ replace: true });
});
elements.nodeStyleSwitcher.addEventListener('click', (event) => {
  const button = event.target.closest('[data-node-style]');
  if (button) setNodeStyle(button.dataset.nodeStyle);
});

elements.inspector.addEventListener('click', async (event) => {
  const gapAction = event.target.closest('[data-gap-action]');
  if (gapAction) return handleGapAction(gapAction.dataset.gapAction);
  const related = event.target.closest('[data-related-test]');
  if (related) return focusTest(related.dataset.relatedTest);
  if (event.target.closest('[data-close-inspector]')) return clearSelection();
  const copy = event.target.closest('[data-copy-location]');
  if (!copy) return;
  try {
    await navigator.clipboard.writeText(copy.dataset.copyLocation);
    showToast('已复制测试位置');
  } catch {
    showToast('无法复制，请手动选择位置', true);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === '/' && !isTypingTarget(event.target)) {
    event.preventDefault();
    elements.search.focus();
  }
  if (event.key === 'Escape') {
    hideSearchResults();
    closeMobilePanels();
  }
});

window.addEventListener('popstate', async () => {
  const params = new URLSearchParams(window.location.search);
  const projectId = params.get('project');
  const layoutMode = params.get('layout') === 'elk' ? 'elk' : 'islands';
  const nodeSpread = parseNodeSpread(params.get('spread'));
  const nodeStyle = params.get('nodes') === 'rings' ? 'rings' : 'solid';
  if (projectId && projectId !== state.selectedProjectId) {
    state.selectedProjectId = projectId;
    state.layoutMode = layoutMode;
    state.nodeSpread = nodeSpread;
    state.nodeStyle = nodeStyle;
    renderProjectOptions();
    updateProjectLinks();
    await loadTestMap();
    return;
  }
  if (layoutMode !== state.layoutMode) switchOverviewLayout(layoutMode, { updateHistory: false });
  if (nodeSpread !== state.nodeSpread) {
    state.nodeSpread = nodeSpread;
    renderDisplayControls();
    applySpreadLayout();
  }
  if (nodeStyle !== state.nodeStyle) setNodeStyle(nodeStyle, { updateHistory: false });
});

await loadProjects();

async function loadProjects() {
  setMapState('loading', '正在整理测试线路', '');
  try {
    const response = await api('/api/projects');
    state.projects = response.items ?? [];
    if (state.projects.length === 0) {
      setMapState('empty', '还没有项目', '请先在 Lifeline 中建立项目。');
      return;
    }
    if (!state.projects.some((project) => project.id === state.selectedProjectId)) {
      state.selectedProjectId = state.projects[0].id;
      updateUrl({ replace: true });
    }
    renderProjectOptions();
    updateProjectLinks();
    await loadTestMap();
  } catch (error) {
    showLoadError(error);
  }
}

async function loadTestMap() {
  if (!state.selectedProjectId) return;
  state.requestController?.abort();
  state.requestController = new AbortController();
  destroyMap();
  resetCatalogUi();
  setMapState('loading', '正在整理测试线路', '');

  try {
    const catalog = await api(
      `/api/projects/${encodeURIComponent(state.selectedProjectId)}/test-map`,
      { signal: state.requestController.signal }
    );
    state.catalog = catalog;
    const project = state.projects.find((entry) => entry.id === state.selectedProjectId);
    document.title = `${project?.name ?? '项目'}测试地图 · Lifeline`;
    if (!catalog.configured) {
      setMapState('empty', '此项目尚未接入测试目录', '');
      return;
    }
    if (!catalog.tests?.length) {
      setMapState('empty', '没有发现自动化测试', '');
      return;
    }

    state.selectedDomainIds = new Set(catalog.domains.filter((entry) => entry.testCount > 0).map((entry) => entry.id));
    if (!catalog.qualityCategories?.some((entry) => entry.id === state.selectedQualityCategoryId)) {
      state.selectedQualityCategoryId = null;
    }
    state.layoutExperiments = hydrateOverviewLayoutExperiments(catalog.layoutExperiments);
    if (state.layoutExperiments.size === 0) {
      const fallback = { id: 'islands', label: '轨道星域', engine: 'Deterministic orbit fallback', domainShape: 'circle', ...layoutCatalog(catalog) };
      state.layoutExperiments.set('islands', fallback);
    }
    const defaultMode = catalog.layoutExperiments?.defaultMode ?? 'islands';
    if (!state.layoutExperiments.has(state.layoutMode)) state.layoutMode = defaultMode;
    const baseLayout = state.layoutExperiments.get(state.layoutMode) ?? state.layoutExperiments.values().next().value;
    state.overviewLayout = spreadOverviewLayout({ catalog, layout: baseLayout, factor: state.nodeSpread });
    state.layout = state.overviewLayout;
    elements.surface.dataset.layoutMode = state.layoutMode;
    renderDisplayControls();
    renderCatalogChrome();
    renderLayoutSwitcher();
    createSigmaMap();
    elements.mapState.hidden = true;
    elements.mapKey.hidden = false;
    elements.minimapButton.hidden = false;
    applyFilters();

    const example = catalog.tests.find((test) => (
      test.file === 'test/client-board.test.js'
      && /placement persists status and phase/i.test(test.title)
    )) ?? catalog.tests.find((test) => test.transfer) ?? catalog.tests[0];
    requestAnimationFrame(() => focusTest(example.id, {
      animate: false,
      revealInspector: !window.matchMedia('(max-width: 980px)').matches,
      moveCamera: false
    }));
  } catch (error) {
    if (error.name === 'AbortError') return;
    showLoadError(error);
  }
}

function createSigmaMap() {
  const graph = new Graph();
  for (const test of state.catalog.tests) {
    const position = state.layout.positions.get(test.id);
    graph.addNode(test.id, {
      x: position.x,
      y: position.y,
      size: test.transfer ? 7.2 : 5.4,
      color: nodeFillColor(test),
      label: test.title,
      zIndex: test.transfer ? 2 : 1
    });
  }
  for (const gap of state.catalog.scenarioGaps ?? []) {
    const position = gapGraphPosition(gap, state.layout);
    graph.addNode(gapNodeId(gap.id), {
      x: position.x,
      y: position.y,
      size: 6.2,
      color: '#314450',
      label: '',
      kind: 'scenario-gap',
      gapId: gap.id,
      zIndex: 3
    });
  }

  const renderer = new Sigma(graph, elements.graph, {
    allowInvalidContainer: false,
    defaultNodeColor: '#173447',
    enableEdgeEvents: false,
    hideEdgesOnMove: true,
    itemSizesReference: 'screen',
    labelColor: { color: '#bdc9d1' },
    labelDensity: .36,
    labelFont: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    labelGridCellSize: 176,
    labelRenderedSizeThreshold: 7,
    labelSize: 11,
    labelWeight: '560',
    maxCameraRatio: 4.5,
    minCameraRatio: .035,
    nodeReducer,
    renderEdgeLabels: false,
    stagePadding: 72,
    // Keep Sigma's core aligned with the fixed-pixel Canvas station rings at every zoom level.
    zoomToSizeRatioFunction: () => 1,
    zIndex: true
  });

  state.graph = graph;
  state.renderer = renderer;
  renderer.on('clickNode', ({ node }) => {
    const gap = gapByNodeId(node);
    if (gap) selectScenarioGap(gap.id);
    else focusTest(node);
  });
  renderer.on('enterNode', ({ node }) => {
    const gap = gapByNodeId(node);
    state.hoveredTestId = gap ? null : node;
    state.hoveredGapId = gap?.id ?? null;
    renderer.refresh();
    scheduleMapRedraw();
    const test = testById(node);
    if (gap) elements.mapStatus.textContent = `${gap.title} · ${coverageStateLabel(gap.coverageState)}`;
    else if (test) elements.mapStatus.textContent = `${test.title} · ${test.file}:${test.line}`;
  });
  renderer.on('leaveNode', () => {
    state.hoveredTestId = null;
    state.hoveredGapId = null;
    renderer.refresh();
    scheduleMapRedraw();
    renderMapStatus();
  });
  renderer.on('clickStage', () => {
    if (window.matchMedia('(max-width: 980px)').matches) setInspectorOpen(false);
  });
  renderer.on('afterRender', scheduleMapRedraw);
  renderer.on('resize', scheduleMapRedraw);
  renderer.getCamera().on('updated', () => {
    scheduleMapRedraw();
  });

  state.resizeObserver = new ResizeObserver(() => {
    renderer.resize();
    scheduleMapRedraw();
  });
  state.resizeObserver.observe(elements.surface);
  renderMapEngine();
}

function nodeReducer(node, data) {
  if (data.kind === 'scenario-gap') {
    const gap = scenarioGapById(data.gapId);
    const categoryVisible = !state.selectedQualityCategoryId || gap?.categoryIds?.includes(state.selectedQualityCategoryId);
    const selected = gap?.id === state.selectedGapId;
    const hovered = gap?.id === state.hoveredGapId;
    return {
      ...data,
      hidden: !gap || !categoryVisible || state.viewMode === 'focus',
      color: selected ? '#e9bd65' : hovered ? '#cf9c58' : '#314450',
      label: '',
      size: selected ? 9 : hovered ? 7.8 : 6.2,
      zIndex: selected ? 7 : hovered ? 6 : 3
    };
  }
  const test = testById(node);
  if (!test) return data;
  const domainVisible = state.selectedDomainIds.has(test.domainId);
  const categoryVisible = !state.selectedQualityCategoryId
    || test.qualityCategoryIds?.includes(state.selectedQualityCategoryId);
  const visibleInMode = state.viewMode !== 'focus' || state.focusVisibleTestIds.has(node);
  const onFocusedRoute = !state.focusedScenarioId || test.scenarioIds.includes(state.focusedScenarioId);
  const selected = node === state.selectedTestId;
  const hovered = node === state.hoveredTestId;
  return {
    ...data,
    hidden: !domainVisible || !categoryVisible || !visibleInMode,
    color: nodeFillColor(test, { selected, hovered, onFocusedRoute }),
    label: '',
    size: selected ? 9.4 : hovered ? 8.2 : state.viewMode === 'focus' ? 6.6 : test.transfer ? 7.2 : 5.4,
    zIndex: selected ? 5 : hovered ? 4 : test.transfer ? 2 : 1
  };
}

function layoutCatalog(catalog) {
  const positions = new Map();
  const domainOrder = new Map(catalog.domains.map((entry, index) => [entry.id, index]));
  const scenarioOrder = new Map(catalog.scenarios.map((entry, index) => [entry.id, index]));
  const groups = new Map();

  for (const test of catalog.tests) {
    const key = `${test.domainId}:${test.scenarioIds[0]}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(test);
  }

  for (const tests of groups.values()) {
    tests.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
    const domainIndex = domainOrder.get(tests[0].domainId) ?? 0;
    const scenarioIndex = scenarioOrder.get(tests[0].scenarioIds[0]) ?? 0;
    const segmentWidth = 410;
    const gap = tests.length > 1 ? Math.min(54, segmentWidth / (tests.length - 1)) : 0;
    const usedWidth = gap * Math.max(0, tests.length - 1);
    const startX = domainIndex * 530 + (segmentWidth - usedWidth) / 2;
    const routeY = scenarioIndex * 154 + (domainIndex % 2 === 0 ? 0 : 22);
    tests.forEach((test, index) => positions.set(test.id, {
      x: startX + index * gap,
      y: routeY + fileOffset(test.file)
    }));
  }

  const routes = new Map(catalog.scenarios.map((scenario) => [
    scenario.id,
    catalog.tests
      .filter((test) => test.scenarioIds.includes(scenario.id))
      .sort((left, right) => {
        const leftPosition = positions.get(left.id);
        const rightPosition = positions.get(right.id);
        return leftPosition.x - rightPosition.x || leftPosition.y - rightPosition.y;
      })
      .map((test) => test.id)
  ]));

  const domainBounds = new Map();
  for (const domain of catalog.domains) {
    const domainTests = catalog.tests.filter((test) => test.domainId === domain.id);
    const points = domainTests.map((test) => positions.get(test.id)).filter(Boolean);
    if (!points.length) continue;
    domainBounds.set(domain.id, {
      minX: Math.min(...points.map((point) => point.x)) - 80,
      maxX: Math.max(...points.map((point) => point.x)) + 80,
      minY: Math.min(...points.map((point) => point.y)) - 82,
      maxY: Math.max(...points.map((point) => point.y)) + 82
    });
  }

  const allPoints = [...positions.values()];
  const extent = {
    minX: Math.min(...allPoints.map((point) => point.x)) - 120,
    maxX: Math.max(...allPoints.map((point) => point.x)) + 120,
    minY: Math.min(...allPoints.map((point) => point.y)) - 120,
    maxY: Math.max(...allPoints.map((point) => point.y)) + 120
  };
  return { positions, routes, domainBounds, extent };
}

function scheduleMapRedraw() {
  if (state.redrawFrame) return;
  state.redrawFrame = requestAnimationFrame(() => {
    state.redrawFrame = null;
    drawRouteLayer();
    drawMinimap();
  });
}

function drawRouteLayer() {
  if (!state.renderer || !state.catalog || !state.layout) return;
  const { context, width, height } = prepareCanvas(elements.routeLayer);
  context.clearRect(0, 0, width, height);
  drawDomainFields(
    context,
    width,
    height,
    state.viewMode === 'focus' ? state.overviewLayout : state.layout,
    state.viewMode === 'focus'
  );
  if (state.viewMode === 'focus') drawOverviewRouteGhosts(context);

  for (const scenario of state.catalog.scenarios) {
    const points = routeGraphPoints(state.layout, scenario.id)
      .map((point) => state.renderer.graphToViewport(point));
    if (points.length < 2) continue;
    const focused = !state.focusedScenarioId || state.focusedScenarioId === scenario.id;
    context.save();
    context.globalAlpha = focused ? (state.viewMode === 'focus' ? .94 : .82) : .09;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = state.focusedScenarioId === scenario.id ? 5.6 : state.viewMode === 'focus' ? 4.2 : 3.2;
    context.strokeStyle = scenario.color;
    traceMetroPath(context, points);
    context.stroke();
    context.restore();
    if (state.viewMode === 'focus' && focused) drawRouteLabel(context, scenario);
  }

  for (const test of state.catalog.tests) {
    if (!isTestVisible(test)) continue;
    const raw = state.layout.positions.get(test.id);
    if (!raw) continue;
    const point = state.renderer.graphToViewport(raw);
    if (point.x < -20 || point.x > width + 20 || point.y < -20 || point.y > height + 20) continue;
    drawStation(context, point, test);
  }
  drawScenarioGapNodes(context, width, height);
  drawSemanticLabels(context, width, height);
}

function drawScenarioGapNodes(context, width, height) {
  if (state.viewMode === 'focus') return;
  const cameraRatio = state.renderer.getCamera().ratio;
  const showLabels = cameraRatio <= .7;
  const occupancy = createSemanticLabelOccupancy(semanticLabelReservedAreas(width, height), 28);
  const candidates = [];
  for (const gap of state.catalog.scenarioGaps ?? []) {
    if (state.selectedQualityCategoryId && !gap.categoryIds?.includes(state.selectedQualityCategoryId)) continue;
    const display = state.renderer.getNodeDisplayData(gapNodeId(gap.id));
    if (!display || display.hidden || display.x < -30 || display.x > width + 30 || display.y < -30 || display.y > height + 30) continue;
    const selected = gap.id === state.selectedGapId;
    const hovered = gap.id === state.hoveredGapId;
    context.save();
    context.setLineDash(gap.coverageState === 'partial' ? [3, 3] : [5, 4]);
    context.lineWidth = selected ? 2.2 : hovered ? 1.8 : 1.35;
    context.strokeStyle = gapColor(gap, selected || hovered ? .95 : .68);
    context.fillStyle = selected ? 'rgba(241, 183, 59, .16)' : 'rgba(11, 24, 32, .75)';
    context.beginPath();
    context.arc(display.x, display.y, selected ? 10 : 8, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.restore();
    if (showLabels || selected || hovered) candidates.push({ gap, point: display, selected, hovered });
  }
  candidates
    .sort((left, right) => Number(right.selected) - Number(left.selected)
      || Number(right.hovered) - Number(left.hovered)
      || gapPriority(left.gap) - gapPriority(right.gap)
      || left.gap.id.localeCompare(right.gap.id))
    .slice(0, cameraRatio <= .18 ? 30 : cameraRatio <= .4 ? 18 : 8)
    .forEach(({ gap, point, selected, hovered }) => {
      const bubble = measureGapBubble(context, gap, { selected, hovered, compact: width < 620 });
      const placement = placeSemanticBubble(point, bubble, occupancy, width, height, {
        required: selected || hovered,
        seed: semanticLabelHash(gap)
      });
      if (!placement) return;
      occupancy.add(placement);
      drawGapBubble(context, placement, bubble, gap, { selected, hovered });
    });
}

function gapGraphPosition(gap, layout) {
  const matched = (gap.matchedTestIds ?? []).map((id) => layout.positions.get(id)).filter(Boolean);
  if (matched.length > 0) {
    const center = averagePoint(matched);
    const angle = stableAngle(gap.id);
    return { x: center.x + Math.cos(angle) * 34, y: center.y + Math.sin(angle) * 34 };
  }
  const category = (gap.categoryIds ?? []).map(qualityCategoryById).find(Boolean);
  const categoryTests = (category?.testIds ?? []).map(testById).filter(Boolean);
  const domainCounts = new Map();
  for (const test of categoryTests) domainCounts.set(test.domainId, (domainCounts.get(test.domainId) ?? 0) + 1);
  const domainId = [...domainCounts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
  const bounds = domainId ? layout.domainBounds.get(domainId) : null;
  const center = bounds ? domainCenter(bounds) : {
    x: (layout.extent.minX + layout.extent.maxX) / 2,
    y: (layout.extent.minY + layout.extent.maxY) / 2
  };
  const siblings = (state.catalog.scenarioGaps ?? []).filter((entry) => (
    (entry.categoryIds?.[0] ?? '') === (gap.categoryIds?.[0] ?? '')
  ));
  const index = Math.max(0, siblings.findIndex((entry) => entry.id === gap.id));
  const angle = stableAngle(gap.id) + index * .41;
  const baseRadius = bounds
    ? Math.max(54, Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * .38)
    : 90;
  const radius = baseRadius + (index % 3) * 24;
  return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
}

function measureGapBubble(context, gap, { selected, hovered, compact }) {
  const emphasized = selected || hovered;
  const maxWidth = emphasized ? compact ? 180 : 250 : compact ? 150 : 205;
  const fontSize = emphasized ? 11.5 : 10.25;
  const horizontalPadding = emphasized ? 10 : 8;
  const verticalPadding = emphasized ? 8 : 6;
  context.save();
  context.font = `${emphasized ? 650 : 590} ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
  const lines = wrapCanvasText(context, gap.title, maxWidth - horizontalPadding * 2);
  const width = Math.min(maxWidth, Math.ceil(Math.max(...lines.map((line) => context.measureText(line).width), 30)) + horizontalPadding * 2);
  context.restore();
  return {
    width,
    height: verticalPadding * 2 + lines.length * Math.ceil(fontSize * 1.35) + 13,
    lines,
    lineHeight: Math.ceil(fontSize * 1.35),
    fontSize,
    horizontalPadding,
    verticalPadding,
    emphasized
  };
}

function drawGapBubble(context, placement, bubble, gap, { selected, hovered }) {
  const accent = gapColor(gap, 1);
  const anchor = closestRectPoint(placement.point, placement);
  context.save();
  context.setLineDash([4, 3]);
  context.beginPath();
  context.moveTo(placement.point.x, placement.point.y);
  context.lineTo(anchor.x, anchor.y);
  context.strokeStyle = gapColor(gap, selected || hovered ? .82 : .48);
  context.lineWidth = selected || hovered ? 1.3 : 1;
  context.stroke();
  context.setLineDash([]);
  context.shadowColor = 'rgba(0, 0, 0, .4)';
  context.shadowBlur = 12;
  context.shadowOffsetY = 3;
  context.fillStyle = selected ? 'rgba(35, 28, 16, .97)' : 'rgba(8, 18, 25, .94)';
  context.strokeStyle = gapColor(gap, selected || hovered ? .86 : .5);
  roundedRect(context, placement.x, placement.y, placement.width, placement.height, 6);
  context.fill();
  context.shadowColor = 'transparent';
  context.stroke();
  context.fillStyle = '#e8eef1';
  context.font = `${bubble.emphasized ? 650 : 590} ${bubble.fontSize}px ui-sans-serif, system-ui, sans-serif`;
  context.textBaseline = 'top';
  let top = placement.y + bubble.verticalPadding;
  for (const line of bubble.lines) {
    context.fillText(line, placement.x + bubble.horizontalPadding, top);
    top += bubble.lineHeight;
  }
  context.fillStyle = accent;
  context.font = '650 9px ui-sans-serif, system-ui, sans-serif';
  context.fillText(coverageStateLabel(gap.coverageState), placement.x + bubble.horizontalPadding, top + 1);
  context.restore();
}

function gapColor(gap, alpha = 1) {
  const color = ({ missing: '#f07878', partial: '#e9b94d', unobserved: '#7f96a3' })[gap.coverageState] ?? '#7f96a3';
  return alpha === 1 ? color : hexAlpha(color, alpha);
}

function gapPriority(gap) {
  return ({ missing: 0, partial: 1, unobserved: 2 })[gap.coverageState] ?? 3;
}

function averagePoint(points) {
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length
  };
}

function stableAngle(value) {
  let hash = 0;
  for (const character of String(value)) hash = (hash * 33 + character.charCodeAt(0)) >>> 0;
  return (hash % 360) / 180 * Math.PI;
}

function routeGraphPoints(layout, scenarioId) {
  const routed = layout.routePoints?.get(scenarioId);
  if (routed && !state.selectedQualityCategoryId) return routed;
  const entries = (layout.routes.get(scenarioId) ?? [])
    .map((id) => ({ test: testById(id), point: layout.positions.get(id) }))
    .filter(({ test, point }) => test && point && isTestVisible(test));
  if (layout.domainShape !== 'circle') return entries.map(({ point }) => point);
  return orbitalRoutePoints(layout, entries);
}

function orbitalRoutePoints(layout, entries) {
  const points = [];
  for (let index = 0; index < entries.length; index += 1) {
    const current = entries[index];
    const previous = entries[index - 1];
    if (previous && previous.test.domainId !== current.test.domainId) {
      const previousBounds = layout.domainBounds.get(previous.test.domainId);
      const currentBounds = layout.domainBounds.get(current.test.domainId);
      if (previousBounds && currentBounds) {
        points.push(circlePort(previousBounds, domainCenter(currentBounds)));
        points.push(circlePort(currentBounds, domainCenter(previousBounds)));
      }
    }
    points.push(current.point);
  }
  return points;
}

function circlePort(bounds, target) {
  const center = domainCenter(bounds);
  const radius = Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 2;
  const dx = target.x - center.x;
  const dy = target.y - center.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  return {
    x: center.x + (dx / distance) * radius,
    y: center.y + (dy / distance) * radius
  };
}

function domainCenter(bounds) {
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2
  };
}

function isTestVisible(test) {
  return state.selectedDomainIds.has(test.domainId)
    && (!state.selectedQualityCategoryId || test.qualityCategoryIds?.includes(state.selectedQualityCategoryId))
    && (state.viewMode !== 'focus' || state.focusVisibleTestIds.has(test.id));
}

function drawDomainFields(context, width, height, layout, quiet = false) {
  if (!layout) return;
  for (const domain of state.catalog.domains) {
    const bounds = layout.domainBounds.get(domain.id);
    if (!bounds) continue;
    const topLeft = state.renderer.graphToViewport({ x: bounds.minX, y: bounds.maxY });
    const bottomRight = state.renderer.graphToViewport({ x: bounds.maxX, y: bounds.minY });
    const left = Math.min(topLeft.x, bottomRight.x);
    const top = Math.min(topLeft.y, bottomRight.y);
    const boxWidth = Math.abs(bottomRight.x - topLeft.x);
    const boxHeight = Math.abs(bottomRight.y - topLeft.y);
    if (left > width || top > height || left + boxWidth < 0 || top + boxHeight < 0) continue;
    const active = state.selectedDomainIds.has(domain.id);
    context.save();
    if (layout.domainShape === 'circle') {
      const centerX = left + boxWidth / 2;
      const centerY = top + boxHeight / 2;
      const radius = Math.min(boxWidth, boxHeight) / 2;
      const fieldColor = active ? domain.color : '#667682';
      const gradient = context.createRadialGradient(
        centerX - radius * .18,
        centerY - radius * .2,
        Math.max(1, radius * .04),
        centerX,
        centerY,
        Math.max(1, radius)
      );
      gradient.addColorStop(0, hexAlpha(fieldColor, quiet ? .018 : .07));
      gradient.addColorStop(.68, hexAlpha(fieldColor, quiet ? .009 : .027));
      gradient.addColorStop(1, hexAlpha(fieldColor, quiet ? .003 : .008));
      context.beginPath();
      context.arc(centerX, centerY, radius, 0, Math.PI * 2);
      context.fillStyle = gradient;
      context.fill();
      context.strokeStyle = hexAlpha(fieldColor, quiet ? .07 : active ? .24 : .08);
      context.lineWidth = active ? 1.2 : 1;
      context.stroke();
      if (!quiet && active && radius > 48) {
        context.strokeStyle = hexAlpha(fieldColor, .055);
        context.lineWidth = 1;
        for (const scale of [.34, .56, .78]) {
          context.beginPath();
          context.arc(centerX, centerY, radius * scale, 0, Math.PI * 2);
          context.stroke();
        }
      }
    } else {
      context.fillStyle = active ? hexAlpha(domain.color, quiet ? .01 : .018) : 'rgba(43, 57, 67, .012)';
      context.strokeStyle = active ? hexAlpha(domain.color, quiet ? .055 : .11) : 'rgba(58, 73, 84, .05)';
      context.lineWidth = 1;
      roundedRect(context, left, top, boxWidth, boxHeight, 12);
      context.fill();
      context.stroke();
    }
    if (boxWidth > 120 && boxHeight > 70) {
      context.fillStyle = active ? hexAlpha(domain.color, quiet ? .24 : .55) : 'rgba(117, 132, 143, .28)';
      context.font = '600 10px ui-sans-serif, system-ui, sans-serif';
      if (layout.domainShape === 'circle') {
        context.textAlign = 'center';
        context.fillText(`${domain.label} · ${domain.testCount}`, left + boxWidth / 2, top + 20);
      } else {
        context.fillText(`${domain.label} · ${domain.testCount}`, left + 10, top + 17);
      }
    }
    context.restore();
  }
}

function drawOverviewRouteGhosts(context) {
  if (!state.overviewLayout) return;
  for (const scenario of state.catalog.scenarios) {
    const points = routeGraphPoints(state.overviewLayout, scenario.id)
      .map((point) => state.renderer.graphToViewport(point));
    if (points.length < 2) continue;
    context.save();
    context.globalAlpha = .045;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = 1.2;
    context.strokeStyle = scenario.color;
    traceMetroPath(context, points);
    context.stroke();
    context.restore();
  }
}

function drawRouteLabel(context, scenario) {
  const raw = state.layout.routeLabels?.get(scenario.id);
  if (!raw) return;
  const point = state.renderer.graphToViewport(raw);
  context.save();
  context.font = '600 11px ui-sans-serif, system-ui, sans-serif';
  const paddingX = 9;
  const width = Math.ceil(context.measureText(scenario.label).width) + paddingX * 2;
  const height = 25;
  const left = raw.align === 'right' ? point.x - width : point.x;
  const top = point.y - height / 2;
  context.fillStyle = hexAlpha(scenario.color, .12);
  context.strokeStyle = hexAlpha(scenario.color, .58);
  context.lineWidth = 1;
  roundedRect(context, left, top, width, height, 5);
  context.fill();
  context.stroke();
  context.fillStyle = hexAlpha(scenario.color, .92);
  context.textBaseline = 'middle';
  context.fillText(scenario.label, left + paddingX, top + height / 2 + .5);
  context.restore();
}

function drawSemanticLabels(context, viewportWidth, viewportHeight) {
  const startedAt = performance.now();
  const compact = viewportWidth < 620;
  const cameraRatio = state.renderer.getCamera().ratio;
  const domainCoverageById = visibleDomainCoverage(viewportWidth, viewportHeight);
  const visibleEntries = [];
  for (const test of state.catalog.tests) {
    if (!isTestVisible(test)) continue;
    const raw = state.layout.positions.get(test.id);
    if (!raw) continue;
    const point = state.renderer.graphToViewport(raw);
    if (point.x < -32 || point.x > viewportWidth + 32 || point.y < -32 || point.y > viewportHeight + 32) continue;
    visibleEntries.push({ ...test, point });
  }
  const candidates = orderSemanticLabelCandidatesForPlacement(selectSemanticLabelCandidates({
    tests: visibleEntries,
    cameraRatio,
    domainCoverageById,
    selectedTestId: state.selectedTestId,
    hoveredTestId: state.hoveredTestId,
    focusedScenarioId: state.focusedScenarioId,
    compact
  }));
  const candidateCountsByDomain = new Map();
  for (const { test } of candidates) {
    candidateCountsByDomain.set(test.domainId, (candidateCountsByDomain.get(test.domainId) ?? 0) + 1);
  }
  const occupancy = createSemanticLabelOccupancy(semanticLabelReservedAreas(viewportWidth, viewportHeight));
  const drawnByDomain = new Map();
  let drawnCount = 0;
  for (const { test } of candidates) {
    const selected = test.id === state.selectedTestId;
    const hovered = test.id === state.hoveredTestId;
    const bubble = measureSemanticBubble(context, test, { compact, cameraRatio, selected, hovered });
    const placement = placeSemanticBubble(test.point, bubble, occupancy, viewportWidth, viewportHeight, {
      required: selected || hovered,
      seed: semanticLabelHash(test)
    });
    if (!placement) continue;
    drawSemanticBubble(context, placement, bubble, test, { selected, hovered });
    occupancy.add(placement);
    drawnByDomain.set(test.domainId, (drawnByDomain.get(test.domainId) ?? 0) + 1);
    drawnCount += 1;
  }
  elements.surface.dataset.cameraRatio = cameraRatio.toFixed(4);
  elements.surface.dataset.semanticVisibleTestCount = String(visibleEntries.length);
  elements.surface.dataset.semanticLabelCount = String(drawnCount);
  elements.surface.dataset.semanticLabelCandidateCount = String(candidates.length);
  elements.surface.dataset.semanticLabelCandidateDomainCounts = JSON.stringify(Object.fromEntries(candidateCountsByDomain));
  elements.surface.dataset.semanticLabelDomainCounts = JSON.stringify(Object.fromEntries(drawnByDomain));
  elements.surface.dataset.semanticLabelPaintMs = (performance.now() - startedAt).toFixed(2);
}

function orderSemanticLabelCandidatesForPlacement(candidates) {
  const pinned = candidates.filter((entry) => entry.reason === 'selected' || entry.reason === 'hovered');
  const pinnedIds = new Set(pinned.map((entry) => entry.test.id));
  const groups = new Map();
  for (const entry of candidates) {
    if (pinnedIds.has(entry.test.id)) continue;
    if (!groups.has(entry.test.domainId)) groups.set(entry.test.domainId, []);
    groups.get(entry.test.domainId).push(entry);
  }
  const orderedGroups = [...groups]
    .sort((left, right) => left[1].length - right[1].length || left[0].localeCompare(right[0]));
  const ordered = [...pinned];
  let round = 0;
  while (orderedGroups.some(([, entries]) => entries[round])) {
    for (const [, entries] of orderedGroups) {
      if (entries[round]) ordered.push(entries[round]);
    }
    round += 1;
  }
  return ordered;
}

function visibleDomainCoverage(viewportWidth, viewportHeight) {
  const coverage = new Map();
  const viewportArea = Math.max(1, viewportWidth * viewportHeight);
  for (const domain of state.catalog.domains) {
    const bounds = state.layout.domainBounds.get(domain.id);
    if (!bounds) continue;
    const first = state.renderer.graphToViewport({ x: bounds.minX, y: bounds.maxY });
    const second = state.renderer.graphToViewport({ x: bounds.maxX, y: bounds.minY });
    const left = Math.max(0, Math.min(first.x, second.x));
    const right = Math.min(viewportWidth, Math.max(first.x, second.x));
    const top = Math.max(0, Math.min(first.y, second.y));
    const bottom = Math.min(viewportHeight, Math.max(first.y, second.y));
    coverage.set(domain.id, Math.max(0, right - left) * Math.max(0, bottom - top) / viewportArea);
  }
  return coverage;
}

function measureSemanticBubble(context, test, { compact, cameraRatio, selected, hovered }) {
  const emphasized = selected || hovered;
  const cacheKey = `${test.id}:${compact ? 'compact' : 'wide'}:${cameraRatio <= .16 ? 'detail' : 'standard'}:${emphasized ? 'emphasized' : 'plain'}`;
  const cached = state.semanticLabelMeasureCache.get(cacheKey);
  if (cached) return cached;
  const maxWidth = emphasized
    ? compact ? 160 : 250
    : compact ? 140 : cameraRatio <= .16 ? 235 : 190;
  const fontSize = emphasized ? (compact ? 11.5 : 12.5) : compact ? 10 : 10.75;
  const lineHeight = Math.ceil(fontSize * 1.35);
  const horizontalPadding = emphasized ? 10 : 8;
  const verticalPadding = emphasized ? 8 : 6;
  context.save();
  context.font = `${emphasized ? 650 : 590} ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
  const lines = wrapCanvasText(context, test.title, maxWidth - horizontalPadding * 2);
  const titleWidth = Math.max(...lines.map((line) => context.measureText(line).width), 24);
  let location = null;
  let locationWidth = 0;
  if (emphasized) {
    location = compact ? `${test.file.split('/').at(-1)}:${test.line}` : `${test.file}:${test.line}`;
    context.font = '560 9.5px ui-monospace, SFMono-Regular, Consolas, monospace';
    locationWidth = context.measureText(location).width;
  }
  context.restore();
  const locationHeight = location ? 14 : 0;
  const bubble = {
    width: Math.min(maxWidth, Math.ceil(Math.max(titleWidth, locationWidth)) + horizontalPadding * 2),
    height: verticalPadding * 2 + lines.length * lineHeight + locationHeight,
    lines,
    lineHeight,
    fontSize,
    horizontalPadding,
    verticalPadding,
    location,
    emphasized
  };
  state.semanticLabelMeasureCache.set(cacheKey, bubble);
  return bubble;
}

function wrapCanvasText(context, value, maxWidth) {
  const tokens = String(value ?? '').replace(/\s+/g, ' ').trim().match(/[\p{Script=Han}]|[^\s\p{Script=Han}]+|\s+/gu) ?? [''];
  const lines = [];
  let line = '';
  const commit = () => {
    if (line.trim()) lines.push(line.trim());
    line = '';
  };
  for (const token of tokens) {
    const candidate = `${line}${token}`;
    if (context.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }
    commit();
    if (context.measureText(token.trim()).width <= maxWidth) {
      line = token.trimStart();
      continue;
    }
    for (const character of token.trim()) {
      if (context.measureText(`${line}${character}`).width > maxWidth) commit();
      line += character;
    }
  }
  commit();
  return lines.length > 0 ? lines : [''];
}

function placeSemanticBubble(point, bubble, occupancy, viewportWidth, viewportHeight, { required, seed }) {
  const gap = 16;
  const distance = required ? gap + 3 : gap;
  const offsets = [];
  for (const radius of [distance, distance + 30, distance + 66, distance + 104, distance + 146]) {
    const directions = [
      { x: radius, y: -bubble.height / 2 },
      { x: -bubble.width - radius, y: -bubble.height / 2 },
      { x: -bubble.width / 2, y: -bubble.height - radius },
      { x: -bubble.width / 2, y: radius },
      { x: radius, y: -bubble.height - radius },
      { x: -bubble.width - radius, y: radius },
      { x: radius, y: radius },
      { x: -bubble.width - radius, y: -bubble.height - radius }
    ];
    if (!required) rotateValues(directions, seed % directions.length);
    offsets.push(...directions);
  }
  const margin = 10;
  let fallback = null;
  let fallbackOverlap = Infinity;
  for (const offset of offsets) {
    const candidate = { x: point.x + offset.x, y: point.y + offset.y, width: bubble.width, height: bubble.height, point };
    if (candidate.x < margin || candidate.y < margin
      || candidate.x + candidate.width > viewportWidth - margin
      || candidate.y + candidate.height > viewportHeight - margin) continue;
    const overlap = occupancy.overlapArea(candidate, 2);
    if (overlap === 0) return candidate;
    if (overlap < fallbackOverlap) {
      fallback = candidate;
      fallbackOverlap = overlap;
    }
  }
  return required ? fallback : null;
}

function createSemanticLabelOccupancy(initialRects, cellSize = 24) {
  const rectangles = [];
  const cells = new Map();
  const keysFor = (rect, padding = 0) => {
    const keys = [];
    const minimumX = Math.floor((rect.x - padding) / cellSize);
    const maximumX = Math.floor((rect.x + rect.width + padding) / cellSize);
    const minimumY = Math.floor((rect.y - padding) / cellSize);
    const maximumY = Math.floor((rect.y + rect.height + padding) / cellSize);
    for (let y = minimumY; y <= maximumY; y += 1) {
      for (let x = minimumX; x <= maximumX; x += 1) keys.push(`${x}:${y}`);
    }
    return keys;
  };
  const add = (rect) => {
    const index = rectangles.push(rect) - 1;
    for (const key of keysFor(rect)) {
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(index);
    }
  };
  const overlapArea = (rect, padding = 0) => {
    const candidateIndexes = new Set(keysFor(rect, padding).flatMap((key) => cells.get(key) ?? []));
    let overlap = 0;
    for (const index of candidateIndexes) overlap += intersectionArea(rect, rectangles[index], padding);
    return overlap;
  };
  initialRects.forEach(add);
  return { add, overlapArea };
}

function drawSemanticBubble(context, placement, bubble, test, { selected, hovered }) {
  const scenario = scenarioById(test.scenarioIds[0]);
  const accent = scenario?.color ?? domainById(test.domainId)?.color ?? '#7eb4c9';
  const anchor = closestRectPoint(placement.point, placement);
  context.save();
  context.beginPath();
  context.moveTo(placement.point.x, placement.point.y);
  context.lineTo(anchor.x, anchor.y);
  context.strokeStyle = hexAlpha(accent, selected || hovered ? .78 : .44);
  context.lineWidth = selected || hovered ? 1.35 : 1;
  context.stroke();
  context.shadowColor = 'rgba(0, 0, 0, .38)';
  context.shadowBlur = 12;
  context.shadowOffsetY = 3;
  context.fillStyle = selected ? 'rgba(8, 27, 31, .97)' : hovered ? 'rgba(8, 23, 31, .97)' : 'rgba(5, 15, 23, .91)';
  context.strokeStyle = hexAlpha(accent, selected || hovered ? .82 : .38);
  context.lineWidth = selected || hovered ? 1.2 : 1;
  roundedRect(context, placement.x, placement.y, placement.width, placement.height, selected || hovered ? 7 : 5);
  context.fill();
  context.shadowColor = 'transparent';
  context.stroke();
  context.fillStyle = hexAlpha(accent, .92);
  roundedRect(context, placement.x + 8, placement.y, Math.min(42, placement.width - 16), 1.5, .75);
  context.fill();
  context.textBaseline = 'top';
  context.font = `${bubble.emphasized ? 650 : 590} ${bubble.fontSize}px ui-sans-serif, system-ui, sans-serif`;
  context.fillStyle = bubble.emphasized ? '#f1f8fb' : '#d5e2e8';
  let top = placement.y + bubble.verticalPadding;
  for (const line of bubble.lines) {
    context.fillText(line, placement.x + bubble.horizontalPadding, top);
    top += bubble.lineHeight;
  }
  if (bubble.location) {
    context.font = '560 9.5px ui-monospace, SFMono-Regular, Consolas, monospace';
    context.fillStyle = '#68dbad';
    context.fillText(bubble.location, placement.x + bubble.horizontalPadding, top + 1);
  }
  context.restore();
}

function semanticLabelReservedAreas(viewportWidth, viewportHeight) {
  const surfaceRect = elements.surface.getBoundingClientRect();
  const reserved = [];
  for (const element of [elements.mapKey, elements.minimapButton]) {
    if (!element || element.hidden) continue;
    const rect = element.getBoundingClientRect();
    reserved.push({
      x: rect.left - surfaceRect.left,
      y: rect.top - surfaceRect.top,
      width: rect.width,
      height: rect.height
    });
  }
  reserved.push({ x: 0, y: Math.max(0, viewportHeight - 34), width: viewportWidth, height: 34 });
  return reserved;
}

function closestRectPoint(point, rect) {
  return {
    x: Math.max(rect.x, Math.min(point.x, rect.x + rect.width)),
    y: Math.max(rect.y, Math.min(point.y, rect.y + rect.height))
  };
}

function intersectionArea(left, right, padding = 0) {
  const width = Math.max(0, Math.min(left.x + left.width + padding, right.x + right.width + padding)
    - Math.max(left.x - padding, right.x - padding));
  const height = Math.max(0, Math.min(left.y + left.height + padding, right.y + right.height + padding)
    - Math.max(left.y - padding, right.y - padding));
  return width * height;
}

function rotateValues(values, offset) {
  values.push(...values.splice(0, offset));
}

function semanticLabelHash(test) {
  const value = `${test.file}:${test.line}:${test.title}`;
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 33 + value.charCodeAt(index)) >>> 0;
  return hash;
}

function drawStation(context, point, test) {
  const routeColors = test.scenarioIds
    .map((id) => scenarioById(id)?.color)
    .filter(Boolean);
  const selected = test.id === state.selectedTestId;
  const hovered = test.id === state.hoveredTestId;
  const onFocusedRoute = !state.focusedScenarioId || test.scenarioIds.includes(state.focusedScenarioId);
  const radius = selected ? 10.5 : hovered ? 9 : state.viewMode === 'focus' ? 7.2 : test.transfer ? 8 : 6.4;
  const fillColor = nodeFillColor(test, { selected, hovered, onFocusedRoute });
  context.save();
  context.globalAlpha = onFocusedRoute ? 1 : .24;
  if (selected) {
    context.beginPath();
    context.arc(point.x, point.y, radius + 7, 0, Math.PI * 2);
    context.fillStyle = 'rgba(57, 211, 154, .13)';
    context.fill();
  }
  if (state.nodeStyle === 'rings') {
    drawConcentricStation(context, point, {
      radius,
      routeColors,
      fillColor,
      selected,
      hovered,
      transfer: test.transfer
    });
    context.restore();
    return;
  }
  context.beginPath();
  context.arc(point.x, point.y, radius + 1.25, 0, Math.PI * 2);
  context.fillStyle = 'rgba(3, 11, 17, .94)';
  context.fill();
  context.lineWidth = test.transfer ? 2.8 : 2.1;
  context.fillStyle = fillColor;
  if (routeColors.length > 1) {
    routeColors.forEach((color, index) => {
      context.beginPath();
      context.arc(
        point.x,
        point.y,
        radius,
        (Math.PI * 2 * index) / routeColors.length - Math.PI / 2,
        (Math.PI * 2 * (index + 1)) / routeColors.length - Math.PI / 2
      );
      context.strokeStyle = color;
      context.stroke();
    });
    context.beginPath();
    context.arc(point.x, point.y, radius - 2.1, 0, Math.PI * 2);
    context.fill();
  } else {
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = routeColors[0] ?? '#83949f';
    context.stroke();
  }
  if (!selected && onFocusedRoute) {
    context.beginPath();
    context.arc(
      point.x - radius * .27,
      point.y - radius * .3,
      Math.max(1, radius * .15),
      0,
      Math.PI * 2
    );
    context.fillStyle = 'rgba(244, 252, 255, .42)';
    context.fill();
  }
  if (hovered && !selected) {
    context.beginPath();
    context.arc(point.x, point.y, radius + 2.1, 0, Math.PI * 2);
    context.strokeStyle = 'rgba(232, 247, 252, .72)';
    context.lineWidth = 1.15;
    context.stroke();
  }
  context.restore();
}

function drawConcentricStation(context, point, {
  radius,
  routeColors,
  fillColor,
  selected,
  hovered,
  transfer
}) {
  const innerRadius = radius + .55;
  const outerRadius = radius + 3.45;
  context.beginPath();
  context.arc(point.x, point.y, outerRadius + 1.35, 0, Math.PI * 2);
  context.fillStyle = 'rgba(3, 11, 17, .96)';
  context.fill();
  const colors = routeColors.length ? routeColors : ['#83949f'];
  colors.forEach((color, index) => {
    context.beginPath();
    context.arc(
      point.x,
      point.y,
      outerRadius,
      (Math.PI * 2 * index) / colors.length - Math.PI / 2,
      (Math.PI * 2 * (index + 1)) / colors.length - Math.PI / 2
    );
    context.strokeStyle = color;
    context.lineWidth = transfer ? 2.6 : 2.15;
    context.stroke();
  });
  context.beginPath();
  context.arc(point.x, point.y, innerRadius, 0, Math.PI * 2);
  context.strokeStyle = fillColor;
  context.lineWidth = selected ? 2.1 : 1.55;
  context.stroke();
  if (hovered && !selected) {
    context.beginPath();
    context.arc(point.x, point.y, outerRadius + 2.25, 0, Math.PI * 2);
    context.strokeStyle = 'rgba(232, 247, 252, .78)';
    context.lineWidth = 1.1;
    context.stroke();
  }
}

function drawMinimap() {
  if (!state.renderer || !state.catalog || !state.layout || elements.minimapButton.hidden) return;
  const { context, width, height } = prepareCanvas(elements.minimap);
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#07121b';
  context.fillRect(0, 0, width, height);
  const minimapLayout = state.viewMode === 'focus' ? state.overviewLayout : state.layout;
  const extent = minimapLayout.extent;
  const padding = 8;
  const scale = Math.min(
    (width - padding * 2) / Math.max(1, extent.maxX - extent.minX),
    (height - padding * 2) / Math.max(1, extent.maxY - extent.minY)
  );
  const offsetX = (width - (extent.maxX - extent.minX) * scale) / 2;
  const offsetY = (height - (extent.maxY - extent.minY) * scale) / 2;
  const project = (point) => ({
    x: offsetX + (point.x - extent.minX) * scale,
    y: height - (offsetY + (point.y - extent.minY) * scale)
  });
  state.minimapTransform = { extent, scale, offsetX, offsetY, width, height, layout: minimapLayout };

  for (const scenario of state.catalog.scenarios) {
    const points = routeGraphPoints(minimapLayout, scenario.id).map(project);
    if (points.length < 2) continue;
    context.save();
    context.globalAlpha = !state.focusedScenarioId || state.focusedScenarioId === scenario.id ? .75 : .08;
    context.lineWidth = state.focusedScenarioId === scenario.id ? 1.8 : .9;
    context.strokeStyle = scenario.color;
    traceMetroPath(context, points);
    context.stroke();
    context.restore();
  }

  const topLeft = state.renderer.viewportToGraph({ x: 0, y: 0 });
  const bottomRight = state.renderer.viewportToGraph({ x: elements.graph.clientWidth, y: elements.graph.clientHeight });
  const a = project(topLeft);
  const b = project(bottomRight);
  context.strokeStyle = 'rgba(239, 247, 251, .74)';
  context.lineWidth = 1;
  context.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
}

function renderCatalogChrome() {
  const { summary } = state.catalog;
  const resultSummary = state.catalog.runtimeEvidence?.testReport;
  const generated = new Date(state.catalog.generatedAt);
  elements.catalogStamp.textContent = Number.isNaN(generated.getTime())
    ? ''
    : `目录生成 ${formatDateTime(generated)}`;
  elements.catalogSummary.innerHTML = `
    <div><dt>测试</dt><dd>${formatNumber(summary.testCount)}</dd></div>
    <div><dt>文件</dt><dd>${formatNumber(summary.fileCount)}</dd></div>
    <div><dt>换乘</dt><dd>${formatNumber(summary.transferCount)}</dd></div>
    <div><dt>结果</dt><dd>${summary.observedCount > 0
      ? `${formatNumber(summary.observedCount)}<small>${resultSummary?.failed > 0 ? ` · ${formatNumber(resultSummary.failed)} 失败` : ' · 已采集'}</small>`
      : '<small>未采集</small>'}</dd></div>
  `;
  renderQualityCategoryFilters();
  renderDomainFilters();
  renderRouteFilters();
}

function renderQualityCategoryFilters() {
  const categories = state.catalog.qualityCategories ?? [];
  elements.qualityCategoryFilters.innerHTML = categories.map((category) => `
    <button class="quality-category-filter${state.selectedQualityCategoryId === category.id ? ' active' : ''}" type="button" data-quality-category-id="${escapeHtml(category.id)}" aria-pressed="${state.selectedQualityCategoryId === category.id}">
      <span class="quality-name" title="${escapeHtml(category.label)}">${escapeHtml(category.label)}</span>
      <span class="quality-state state-${escapeHtml(category.coverageState)}" title="${escapeHtml(categoryEvidenceTitle(category))}">${escapeHtml(coverageStateLabel(category.coverageState))} · ${escapeHtml(gateStatusLabel(category.qualityGate?.status))}</span>
      <span class="filter-count">${formatNumber(category.testCount)}</span>
    </button>
  `).join('');
  elements.showAllQualityCategories.classList.toggle('active', !state.selectedQualityCategoryId);
  const gaps = state.catalog.scenarioGaps ?? [];
  const missing = gaps.filter((entry) => entry.coverageState === 'missing').length;
  const partial = gaps.filter((entry) => entry.coverageState === 'partial').length;
  elements.scenarioGapSummary.textContent = gaps.length
    ? `${formatNumber(missing)} 个缺测场景 · ${formatNumber(partial)} 个部分覆盖`
    : '';
}

function renderDomainFilters() {
  elements.domainFilters.innerHTML = state.catalog.domains
    .filter((domain) => domain.testCount > 0)
    .map((domain) => `
      <button class="domain-filter${state.selectedDomainIds.has(domain.id) ? ' active' : ''}" type="button" data-domain-id="${escapeHtml(domain.id)}" style="--domain-color:${escapeHtml(domain.color)}" aria-pressed="${state.selectedDomainIds.has(domain.id)}">
        <span class="domain-check" aria-hidden="true"></span>
        <span>${escapeHtml(domain.label)}</span>
        <span class="filter-count">${formatNumber(domain.testCount)}</span>
      </button>
    `).join('');
  const allSelected = state.selectedDomainIds.size === state.catalog.domains.filter((entry) => entry.testCount > 0).length;
  elements.toggleDomains.textContent = allSelected ? '清空' : '全选';
}

function renderRouteFilters() {
  elements.routeFilters.innerHTML = state.catalog.scenarios.map((scenario) => `
    <button class="route-filter${state.focusedScenarioId === scenario.id ? ' active' : ''}${state.focusedScenarioId && state.focusedScenarioId !== scenario.id ? ' is-muted' : ''}" type="button" data-scenario-id="${escapeHtml(scenario.id)}" style="--route-color:${escapeHtml(scenario.color)}" aria-pressed="${state.focusedScenarioId === scenario.id}">
      <span class="route-line" aria-hidden="true"></span>
      <span>${escapeHtml(scenario.label)}</span>
      <span class="filter-count">${formatNumber(scenario.testCount)}</span>
    </button>
  `).join('');
  elements.showAllRoutes.classList.toggle('active', !state.focusedScenarioId);
}

function renderSearchResults() {
  const query = normalizeSearch(elements.search.value);
  if (!query || !state.catalog) return hideSearchResults();
  const results = state.catalog.tests
    .map((test) => ({ test, score: searchScore(test, query) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.test.title.localeCompare(right.test.title))
    .slice(0, 9);
  elements.searchResults.innerHTML = results.length > 0
    ? results.map(({ test }) => `
      <button class="test-search-result" type="button" role="option" data-search-test="${escapeHtml(test.id)}">
        <strong>${highlightMatch(test.title, elements.search.value)}</strong>
        <span>${escapeHtml(test.file)}:${test.line}</span>
      </button>
    `).join('')
    : '<div class="test-search-result"><strong>没有匹配测试</strong></div>';
  elements.searchResults.hidden = false;
}

function hideSearchResults() {
  elements.searchResults.hidden = true;
}

function focusTest(testId, { animate = true, revealInspector = true, moveCamera = false } = {}) {
  const test = testById(testId);
  if (!test || !state.renderer) return;
  if (state.viewMode === 'focus') showOverview({ animate: false });
  state.selectedDomainIds.add(test.domainId);
  if (state.focusedScenarioId && !test.scenarioIds.includes(state.focusedScenarioId)) {
    state.focusedScenarioId = null;
  }
  state.selectedTestId = testId;
  state.selectedGapId = null;
  applyFilters();
  renderInspector(test);
  hideSearchResults();
  if (revealInspector) setInspectorOpen(true);
  setFiltersOpen(false);
  const displayData = moveCamera ? state.renderer.getNodeDisplayData(testId) : null;
  if (displayData) {
    const ratio = window.matchMedia('(max-width: 720px)').matches ? .17 : .24;
    if (animate) state.renderer.getCamera().animate({ x: displayData.x, y: displayData.y, ratio }, { duration: 520 });
    else state.renderer.getCamera().setState({ x: displayData.x, y: displayData.y, ratio });
  }
}

function activateFocusLayout(testId) {
  if (!state.catalog || !state.overviewLayout) return;
  const focusLayout = buildFocusLayout({
    catalog: state.catalog,
    overviewLayout: state.overviewLayout,
    selectedTestId: testId,
    visibleDomainIds: state.selectedDomainIds
  });
  if (!focusLayout) return;
  state.viewMode = 'focus';
  state.focusLayout = focusLayout;
  state.focusVisibleTestIds = new Set(focusLayout.visibleTestIds);
  activateLayout(focusLayout);
  elements.surface.dataset.viewMode = 'focus';
}

function showOverview({ animate = true } = {}) {
  if (!state.overviewLayout) return resetCamera();
  state.viewMode = 'overview';
  state.focusLayout = null;
  state.focusVisibleTestIds = new Set();
  activateLayout(state.overviewLayout);
  elements.surface.dataset.viewMode = 'overview';
  applyFilters();
  if (animate) resetCamera();
}

function switchOverviewLayout(layoutMode, { updateHistory = true } = {}) {
  const baseLayout = state.layoutExperiments.get(layoutMode);
  if (!baseLayout || layoutMode === state.layoutMode) return;
  const nextLayout = spreadOverviewLayout({ catalog: state.catalog, layout: baseLayout, factor: state.nodeSpread });
  state.layoutMode = layoutMode;
  state.overviewLayout = nextLayout;
  state.viewMode = 'overview';
  state.focusLayout = null;
  state.focusVisibleTestIds = new Set();
  elements.surface.dataset.viewMode = 'overview';
  elements.surface.dataset.layoutMode = layoutMode;
  activateLayout(nextLayout);
  renderLayoutSwitcher();
  renderMapEngine();
  applyFilters();
  resetCamera();
  if (updateHistory) updateUrl({ replace: true });
}

function scheduleSpreadUpdate() {
  if (state.spreadFrame) return;
  state.spreadFrame = requestAnimationFrame(() => {
    state.spreadFrame = null;
    applySpreadLayout();
  });
}

function flushSpreadUpdate() {
  if (!state.spreadFrame) return applySpreadLayout();
  cancelAnimationFrame(state.spreadFrame);
  state.spreadFrame = null;
  applySpreadLayout();
}

function applySpreadLayout() {
  const baseLayout = state.layoutExperiments.get(state.layoutMode);
  if (!state.catalog || !baseLayout) return;
  state.overviewLayout = spreadOverviewLayout({
    catalog: state.catalog,
    layout: baseLayout,
    factor: state.nodeSpread
  });
  if (state.viewMode === 'focus' && state.selectedTestId) activateFocusLayout(state.selectedTestId);
  else activateLayout(state.overviewLayout);
  renderMapEngine();
  applyFilters();
}

function setNodeStyle(nodeStyle, { updateHistory = true } = {}) {
  const nextStyle = nodeStyle === 'rings' ? 'rings' : 'solid';
  if (nextStyle === state.nodeStyle) return;
  state.nodeStyle = nextStyle;
  renderDisplayControls();
  state.renderer?.refresh();
  scheduleMapRedraw();
  if (updateHistory) updateUrl({ replace: true });
}

function activateLayout(layout) {
  state.layout = layout;
  if (!state.graph) return;
  state.graph.updateEachNodeAttributes((node, attributes) => {
    const gap = gapByNodeId(node);
    const point = gap ? gapGraphPosition(gap, layout) : layout.positions.get(node);
    return point ? { ...attributes, x: point.x, y: point.y } : attributes;
  }, { attributes: ['x', 'y'] });
  state.renderer?.refresh();
  scheduleMapRedraw();
}

function renderInspector(test) {
  const domain = domainById(test.domainId);
  const scenarios = test.scenarioIds.map(scenarioById).filter(Boolean);
  const qualityCategories = (test.qualityCategoryIds ?? []).map(qualityCategoryById).filter(Boolean);
  const runtimeEvidence = test.runtimeEvidence;
  const related = relatedTests(test).slice(0, 5);
  const location = `${test.file}:${test.line}`;
  elements.inspectorEmpty.hidden = true;
  elements.inspectorContent.hidden = false;
  elements.inspectorContent.innerHTML = `
    <header class="inspector-head">
      <div class="inspector-head-row">
        <span class="test-status">${escapeHtml(test.statusLabel)}</span>
        <button class="map-icon-button" type="button" data-close-inspector aria-label="关闭测试详情">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </div>
      <h2>${escapeHtml(test.title)}</h2>
      <div class="inspector-location">
        <span>${escapeHtml(location)}</span>
        <button class="copy-location" type="button" data-copy-location="${escapeHtml(location)}" aria-label="复制测试位置">
          <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="8" y="8" width="10" height="10" rx="2"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/></svg>
        </button>
      </div>
    </header>
    <section class="inspector-section">
      <h3>覆盖位置</h3>
      <div class="inspector-tags">
        <span class="inspector-tag"><i style="--tag-color:${escapeHtml(domain?.color ?? '#80919d')}"></i>${escapeHtml(domain?.label ?? test.domainId)}</span>
        ${scenarios.map((scenario) => `<span class="inspector-tag"><i style="--tag-color:${escapeHtml(scenario.color)}"></i>${escapeHtml(scenario.label)}</span>`).join('')}
      </div>
    </section>
    ${qualityCategories.length > 0 ? `
      <section class="inspector-section">
        <h3>覆盖分类</h3>
        <div class="inspector-tags">
          <span class="inspector-tag">${escapeHtml(testLevelLabel(test.testLevel))}</span>
          ${qualityCategories.map((category) => `<span class="inspector-tag">${escapeHtml(category.label)}</span>`).join('')}
        </div>
      </section>
    ` : ''}
    ${runtimeEvidence ? `
      <section class="inspector-section">
        <h3>运行证据</h3>
        <div class="inspector-evidence">
          <strong>${escapeHtml(test.statusLabel)}${Number.isFinite(runtimeEvidence.durationMs) ? ` · ${escapeHtml(formatDurationMs(runtimeEvidence.durationMs))}` : ''}</strong>
          <span>${escapeHtml(formatDateTime(new Date(runtimeEvidence.observedAt)))}</span>
        </div>
      </section>
    ` : ''}
    <section class="inspector-section">
      <h3>风险关注</h3>
      <div class="inspector-tags">${test.riskTags.map((tag) => `<span class="inspector-tag">${escapeHtml(tag)}</span>`).join('')}</div>
    </section>
    ${test.sourceModules.length > 0 ? `
      <section class="inspector-section">
        <h3>关联实现</h3>
        <div class="source-module-list">${test.sourceModules.map((module) => `<span class="source-module">${escapeHtml(module)}</span>`).join('')}</div>
      </section>
    ` : ''}
    ${related.length > 0 ? `
      <section class="inspector-section">
        <h3>相邻站点</h3>
        <div class="related-test-list">${related.map((item) => `<button class="related-test" type="button" data-related-test="${escapeHtml(item.id)}">${escapeHtml(item.title)}</button>`).join('')}</div>
      </section>
    ` : ''}
  `;
}

function selectScenarioGap(gapId) {
  const gap = scenarioGapById(gapId);
  if (!gap || !state.renderer) return;
  state.selectedTestId = null;
  state.selectedGapId = gapId;
  state.renderer.refresh();
  scheduleMapRedraw();
  renderGapInspector(gap);
  setInspectorOpen(true);
  setFiltersOpen(false);
}

function renderGapInspector(gap) {
  const sourceEvidence = gap.sourceEvidence ?? [];
  const canWrite = !['DISMISSED', 'SUPPRESSED', 'VERIFIED', 'COVERED_EXISTING'].includes(gap.workflowState);
  const actions = gapWorkflowActions(gap);
  elements.inspectorEmpty.hidden = true;
  elements.inspectorContent.hidden = false;
  elements.inspectorContent.innerHTML = `
    <header class="inspector-head gap-inspector-head">
      <div class="inspector-head-row">
        <span class="test-status gap-status">${escapeHtml(coverageStateLabel(gap.coverageState))}</span>
        <button class="map-icon-button" type="button" data-close-inspector aria-label="关闭场景详情">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </div>
      <h2>${escapeHtml(gap.title)}</h2>
      <p class="gap-workflow-state">${escapeHtml(workflowStateLabel(gap.workflowState))}</p>
    </header>
    <section class="inspector-section">
      <h3>来源证据</h3>
      <div class="gap-source-list">
        ${sourceEvidence.map((source) => `<div><strong>${escapeHtml(source.symbol ?? source.pointer ?? source.type)}</strong><span>${escapeHtml(source.uri)}${source.line ? `:${escapeHtml(source.line)}` : ''}</span></div>`).join('')}
      </div>
    </section>
    ${gap.matchedTestIds?.length ? `
      <section class="inspector-section">
        <h3>已有匹配</h3>
        <div class="related-test-list">${gap.matchedTestIds.map((id) => {
          const test = testById(id);
          return test ? `<button class="related-test" type="button" data-related-test="${escapeHtml(id)}">${escapeHtml(test.title)}</button>` : '';
        }).join('')}</div>
      </section>` : ''}
    ${canWrite && actions.length ? `
      <section class="inspector-section gap-actions-section">
        <h3>下一步</h3>
        <div class="gap-action-list">${actions.map((action) => `<button type="button" data-gap-action="${escapeHtml(action.id)}" class="${action.kind === 'danger' ? 'danger' : ''}">${escapeHtml(action.label)}</button>`).join('')}</div>
      </section>` : ''}
  `;
}

async function handleGapAction(action) {
  const gap = scenarioGapById(state.selectedGapId);
  if (!gap) return;
  try {
    let proposal;
    if (action === 'CREATE_DRAFT') {
      const fileName = gap.id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(-28);
      proposal = await api(`/api/projects/${encodeURIComponent(state.selectedProjectId)}/test-scenario-proposals/${encodeURIComponent(gap.id)}/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          framework: 'NODE_TEST',
          suggestedPath: `test/scenario-${fileName}.test.js`,
          command: ['node', '--test', `test/scenario-${fileName}.test.js`],
          expectedFailure: expectedFailureText(gap)
        })
      });
    } else {
      proposal = await api(`/api/projects/${encodeURIComponent(state.selectedProjectId)}/test-scenario-proposals/${encodeURIComponent(gap.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, reason: gapActionReason(action) })
      });
    }
    updateScenarioGapFromProposal(proposal);
    showToast(gapActionSuccess(action));
    renderGapInspector(scenarioGapById(proposal.id));
    state.renderer?.refresh();
    scheduleMapRedraw();
  } catch (error) {
    showToast(error.message || '场景处理失败', true);
  }
}

function updateScenarioGapFromProposal(proposal) {
  const index = (state.catalog.scenarioGaps ?? []).findIndex((entry) => entry.id === proposal.id);
  if (index < 0) return;
  state.catalog.scenarioGaps[index] = {
    ...state.catalog.scenarioGaps[index],
    coverageState: proposal.coverageState,
    workflowState: proposal.status,
    sourceEvidence: proposal.sourceEvidence,
    matchedTestIds: proposal.matchedTestIds,
    testDraft: proposal.testDraft ?? null,
    implementationTaskId: proposal.implementationTaskId ?? null
  };
}

function clearSelection({ restoreOverview = true } = {}) {
  state.selectedTestId = null;
  state.selectedGapId = null;
  if (restoreOverview && state.viewMode === 'focus') showOverview();
  else {
    state.renderer?.refresh();
    scheduleMapRedraw();
  }
  elements.inspectorEmpty.hidden = false;
  elements.inspectorContent.hidden = true;
  elements.inspectorContent.innerHTML = '';
  setInspectorOpen(false);
  renderMapStatus();
}

function relatedTests(test) {
  const scenarios = new Set(test.scenarioIds);
  return state.catalog.tests
    .filter((candidate) => candidate.id !== test.id && state.selectedDomainIds.has(candidate.domainId))
    .map((candidate) => ({
      ...candidate,
      relatedScore: candidate.scenarioIds.filter((id) => scenarios.has(id)).length * 3
        + (candidate.domainId === test.domainId ? 1 : 0)
    }))
    .filter((candidate) => candidate.relatedScore > 0)
    .sort((left, right) => right.relatedScore - left.relatedScore || left.file.localeCompare(right.file) || left.line - right.line);
}

function keepSelectionVisible() {
  const selected = testById(state.selectedTestId);
  if (selected && !isTestVisible(selected)) clearSelection();
}

function applyFilters() {
  if (!state.catalog) return;
  renderQualityCategoryFilters();
  renderDomainFilters();
  renderRouteFilters();
  state.renderer?.refresh();
  scheduleMapRedraw();
  const visible = state.catalog.tests.filter(isTestVisible);
  const focused = state.focusedScenarioId
    ? visible.filter((test) => test.scenarioIds.includes(state.focusedScenarioId))
    : visible;
  const route = scenarioById(state.focusedScenarioId);
  const category = qualityCategoryById(state.selectedQualityCategoryId);
  elements.toolbarTitle.textContent = route?.label ?? category?.label ?? (state.viewMode === 'focus' ? '测试焦点' : '全部测试');
  elements.visibleTestCount.textContent = `${formatNumber(focused.length)} / ${formatNumber(state.catalog.summary.testCount)} 可见`;
  renderMapStatus();
}

function renderMapStatus() {
  if (!state.catalog) return;
  const domainCount = state.selectedDomainIds.size;
  const route = scenarioById(state.focusedScenarioId);
  const category = qualityCategoryById(state.selectedQualityCategoryId);
  if (state.viewMode === 'focus') {
    const routeCount = state.focusLayout?.scenarioIds.length ?? 0;
    const visibleCount = [...state.focusVisibleTestIds]
      .map(testById)
      .filter((test) => test && state.selectedDomainIds.has(test.domainId)).length;
    elements.mapStatus.textContent = route
      ? `${route.label} · ${formatNumber(visibleCount)} 个相关测试`
      : `焦点 · ${formatNumber(visibleCount)} 个相关测试 · ${formatNumber(routeCount)} 条线路`;
    return;
  }
  const layoutLabel = state.overviewLayout?.label ?? '测试地图';
  elements.mapStatus.textContent = route
    ? `${route.label} · ${formatNumber(route.testCount)} 个测试站点`
    : category
      ? `${category.label} · ${formatNumber(category.testCount)} 个测试`
      : `${layoutLabel} · ${domainCount} 个领域 · 拖拽浏览`;
}

function renderLayoutSwitcher() {
  for (const button of elements.layoutSwitcher.querySelectorAll('[data-layout-mode]')) {
    const available = state.layoutExperiments.has(button.dataset.layoutMode);
    const active = available && button.dataset.layoutMode === state.layoutMode;
    button.disabled = !available;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function renderDisplayControls() {
  const available = Boolean(state.catalog);
  elements.nodeSpread.disabled = !available;
  elements.nodeSpread.value = String(state.nodeSpread);
  elements.nodeSpreadValue.textContent = `${Math.round(state.nodeSpread * 100)}%`;
  for (const button of elements.nodeStyleSwitcher.querySelectorAll('[data-node-style]')) {
    const active = button.dataset.nodeStyle === state.nodeStyle;
    button.disabled = !available;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  elements.surface.dataset.nodeStyle = state.nodeStyle;
  elements.mapKey.dataset.nodeStyle = state.nodeStyle;
}

function renderMapEngine() {
  if (!state.catalog) return;
  const engine = state.overviewLayout?.engine ? ` · ${state.overviewLayout.engine}` : '';
  elements.mapEngine.textContent = `Sigma.js${engine} · ${formatNumber(state.catalog.summary.testCount)} 节点`;
}

function focusNearestFromMinimap(event) {
  if (!state.minimapTransform || !state.catalog) return;
  const rect = elements.minimap.getBoundingClientRect();
  const x = (event.clientX - rect.left) * (state.minimapTransform.width / rect.width);
  const y = (event.clientY - rect.top) * (state.minimapTransform.height / rect.height);
  const { extent, scale, offsetX, offsetY, height, layout } = state.minimapTransform;
  const graphPoint = {
    x: (x - offsetX) / scale + extent.minX,
    y: ((height - y) - offsetY) / scale + extent.minY
  };
  let nearest = null;
  let nearestDistance = Infinity;
  for (const test of state.catalog.tests) {
    if (!state.selectedDomainIds.has(test.domainId)) continue;
    const point = layout.positions.get(test.id);
    if (!point) continue;
    const distance = (point.x - graphPoint.x) ** 2 + (point.y - graphPoint.y) ** 2;
    if (distance < nearestDistance) {
      nearest = test;
      nearestDistance = distance;
    }
  }
  if (nearest) focusTest(nearest.id, { moveCamera: true });
}

function resetCamera() {
  state.renderer?.getCamera().animatedReset({ duration: 520 });
}

function renderProjectOptions() {
  elements.projectSelect.innerHTML = state.projects
    .map((project) => `<option value="${escapeHtml(project.id)}"${project.id === state.selectedProjectId ? ' selected' : ''}>${escapeHtml(project.name)}</option>`)
    .join('');
}

function updateProjectLinks() {
  for (const [element, path] of [
    [elements.projectProgressNavLink, '/client.html'],
    [elements.testMapNavLink, '/test-map.html'],
    [elements.canvasNavLink, '/canvas.html']
  ]) {
    const url = new URL(path, window.location.origin);
    if (state.selectedProjectId) url.searchParams.set('project', state.selectedProjectId);
    element.href = `${url.pathname}${url.search}`;
  }
}

function updateUrl({ replace }) {
  const url = new URL(window.location.href);
  if (state.selectedProjectId) url.searchParams.set('project', state.selectedProjectId);
  else url.searchParams.delete('project');
  if (state.layoutMode) url.searchParams.set('layout', state.layoutMode);
  url.searchParams.set('spread', String(state.nodeSpread));
  url.searchParams.set('nodes', state.nodeStyle);
  window.history[replace ? 'replaceState' : 'pushState']({}, '', url);
}

function setMapState(status, title, detail) {
  elements.mapState.hidden = false;
  elements.mapState.dataset.state = status;
  elements.mapStateTitle.textContent = title;
  elements.mapStateDetail.textContent = detail;
  elements.mapStateDetail.hidden = !detail;
  elements.retry.hidden = status !== 'error';
}

function showLoadError(error) {
  const copy = error.code === 'NOT_FOUND'
    ? ['找不到这个项目', '请切换到其他项目。']
    : ['测试地图载入失败', error.message || '请重新载入。'];
  setMapState('error', copy[0], copy[1]);
}

function resetCatalogUi() {
  elements.catalogStamp.textContent = '';
  elements.catalogSummary.innerHTML = '';
  elements.qualityCategoryFilters.innerHTML = '';
  elements.scenarioGapSummary.textContent = '';
  elements.domainFilters.innerHTML = '';
  elements.routeFilters.innerHTML = '';
  elements.mapKey.hidden = true;
  elements.minimapButton.hidden = true;
  elements.toolbarTitle.textContent = '全部测试';
  elements.visibleTestCount.textContent = '';
  renderLayoutSwitcher();
  renderDisplayControls();
  clearSelection();
}

function destroyMap() {
  if (state.redrawFrame) cancelAnimationFrame(state.redrawFrame);
  if (state.spreadFrame) cancelAnimationFrame(state.spreadFrame);
  state.redrawFrame = null;
  state.spreadFrame = null;
  state.resizeObserver?.disconnect();
  state.resizeObserver = null;
  state.renderer?.kill();
  state.renderer = null;
  state.graph = null;
  state.layout = null;
  state.overviewLayout = null;
  state.layoutExperiments = new Map();
  state.focusLayout = null;
  state.focusVisibleTestIds = new Set();
  state.viewMode = 'overview';
  state.minimapTransform = null;
  state.semanticLabelMeasureCache = new Map();
  state.catalog = null;
  elements.surface.dataset.viewMode = 'overview';
  const { context, width, height } = prepareCanvas(elements.routeLayer);
  context.clearRect(0, 0, width, height);
}

function parseNodeSpread(value) {
  if (value === null || value === '') return DEFAULT_NODE_SPREAD;
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_NODE_SPREAD;
  return Math.min(1.5, Math.max(.85, number));
}

function setFiltersOpen(open) {
  state.filtersOpen = open;
  elements.sidebar.classList.toggle('is-open', open);
  elements.openFilters.setAttribute('aria-expanded', String(open));
  syncBackdrop();
}

function setInspectorOpen(open) {
  state.inspectorOpen = open;
  elements.inspector.classList.toggle('has-selection', open && Boolean(state.selectedTestId || state.selectedGapId));
  syncBackdrop();
}

function closeMobilePanels() {
  setFiltersOpen(false);
  if (window.matchMedia('(max-width: 980px)').matches) setInspectorOpen(false);
}

function syncBackdrop() {
  const narrow = window.matchMedia('(max-width: 980px)').matches;
  elements.backdrop.hidden = !narrow || (!state.filtersOpen && !state.inspectorOpen);
}

function traceMetroPath(context, points) {
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    const midX = previous.x + (point.x - previous.x) * .52;
    context.bezierCurveTo(midX, previous.y, midX, point.y, point.x, point.y);
  }
}

function roundedRect(context, x, y, width, height, radius) {
  const safeRadius = Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.arcTo(x + width, y, x + width, y + height, safeRadius);
  context.arcTo(x + width, y + height, x, y + height, safeRadius);
  context.arcTo(x, y + height, x, y, safeRadius);
  context.arcTo(x, y, x + width, y, safeRadius);
  context.closePath();
}

function prepareCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const targetWidth = Math.round(width * ratio);
  const targetHeight = Math.round(height * ratio);
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width, height };
}

function testById(id) {
  return state.catalog?.tests.find((test) => test.id === id) ?? null;
}

function scenarioGapById(id) {
  return state.catalog?.scenarioGaps?.find((gap) => gap.id === id) ?? null;
}

function gapWorkflowActions(gap) {
  const capabilities = new Set(state.catalog?.access?.capabilities ?? []);
  const actions = ({
    PROPOSED: [{ id: 'START_REVIEW', label: '进入评审' }],
    REVIEW: [
      { id: 'ACCEPT', label: '接受场景' },
      { id: 'DISMISS', label: '不需要', kind: 'danger' },
      { id: 'SUPPRESS', label: '长期忽略', kind: 'danger' }
    ],
    ACCEPTED: [{ id: 'CREATE_DRAFT', label: '生成测试草案' }],
    DISMISSED: [{ id: 'REOPEN', label: '重新评审' }],
    SUPPRESSED: [{ id: 'REOPEN', label: '重新评审' }]
  })[gap.workflowState] ?? [];
  return actions.filter((action) => (
    action.id === 'CREATE_DRAFT'
      ? capabilities.has('project:write')
      : capabilities.has('test-governance:review')
  ));
}

function gapActionReason(action) {
  return ({
    START_REVIEW: '负责人开始复核来源与覆盖证据',
    ACCEPT: '来源与风险已经人工确认',
    DISMISS: '负责人确认当前场景不需要覆盖',
    SUPPRESS: '负责人确认长期忽略这一稳定场景',
    REOPEN: '新证据出现，重新进入评审'
  })[action] ?? '负责人更新场景状态';
}

function gapActionSuccess(action) {
  return ({
    START_REVIEW: '场景已进入评审',
    ACCEPT: '场景已接受',
    DISMISS: '场景已标记为不需要',
    SUPPRESS: '场景已长期忽略',
    REOPEN: '场景已重新进入评审',
    CREATE_DRAFT: '测试草案已生成'
  })[action] ?? '场景已更新';
}

function workflowStateLabel(value) {
  return ({
    PROPOSED: '待评审', REVIEW: '评审中', ACCEPTED: '已接受', TEST_DRAFT: '测试草案',
    RED_PROVEN: '已证明 RED', IMPLEMENTING: '开发中', GREEN: '已变绿', VERIFIED: '已验证',
    COVERED_EXISTING: '现有行为已覆盖', NEEDS_CORRECTION: '测试需要修正', DISMISSED: '不需要',
    SUPPRESSED: '长期忽略', OBSOLETE: '已过时'
  })[value] ?? value ?? '待评审';
}

function expectedFailureText(gap) {
  const expected = JSON.stringify(gap.expected ?? {});
  return expected && expected !== '{}' ? `expected ${expected}` : `expected scenario behavior: ${gap.title}`;
}

function gapNodeId(id) {
  return `scenario-gap:${id}`;
}

function gapByNodeId(nodeId) {
  return String(nodeId).startsWith('scenario-gap:')
    ? scenarioGapById(String(nodeId).slice('scenario-gap:'.length))
    : null;
}

function domainById(id) {
  return state.catalog?.domains.find((domain) => domain.id === id) ?? null;
}

function scenarioById(id) {
  return state.catalog?.scenarios.find((scenario) => scenario.id === id) ?? null;
}

function qualityCategoryById(id) {
  return state.catalog?.qualityCategories?.find((category) => category.id === id) ?? null;
}

function fileOffset(file) {
  let hash = 0;
  for (let index = 0; index < file.length; index += 1) hash = (hash * 31 + file.charCodeAt(index)) >>> 0;
  return (hash % 15) - 7;
}

function searchScore(test, query) {
  const title = normalizeSearch(test.title);
  const file = normalizeSearch(test.file);
  const domain = normalizeSearch(domainById(test.domainId)?.label);
  const scenarios = normalizeSearch(test.scenarioIds.map((id) => scenarioById(id)?.label).join(' '));
  const qualityCategories = normalizeSearch((test.qualityCategoryIds ?? []).map((id) => qualityCategoryById(id)?.label).join(' '));
  if (title === query) return 100;
  if (title.startsWith(query)) return 80;
  if (title.includes(query)) return 60;
  if (file.includes(query)) return 40;
  if (scenarios.includes(query)) return 25;
  if (qualityCategories.includes(query)) return 20;
  if (domain.includes(query)) return 15;
  return 0;
}

function normalizeSearch(value) {
  return String(value ?? '').trim().toLocaleLowerCase('zh-CN');
}

function highlightMatch(value, rawQuery) {
  const query = String(rawQuery ?? '').trim();
  if (!query) return escapeHtml(value);
  const index = value.toLocaleLowerCase('zh-CN').indexOf(query.toLocaleLowerCase('zh-CN'));
  if (index < 0) return escapeHtml(value);
  return `${escapeHtml(value.slice(0, index))}<mark>${escapeHtml(value.slice(index, index + query.length))}</mark>${escapeHtml(value.slice(index + query.length))}`;
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(value);
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
}

function coverageStateLabel(value) {
  return {
    covered: '已覆盖',
    partial: '部分',
    missing: '缺测',
    unobserved: '未运行',
    obsolete: '已失效'
  }[value] ?? value;
}

function gateStatusLabel(value) {
  return ({ PASS: '通过', WARN: '关注', FAIL: '阻断' })[value] ?? '未设门';
}

function categoryEvidenceTitle(category) {
  const evidenceAt = category.evidenceAt ? formatDateTime(new Date(category.evidenceAt)) : '无近期证据';
  const reasons = category.qualityGate?.reasons?.length
    ? category.qualityGate.reasons.join('，')
    : '门禁通过';
  return `${evidenceAt} · ${reasons}`;
}

function testLevelLabel(value) {
  return {
    unit: '单元测试',
    integration: '集成测试',
    contract: '契约测试',
    e2e: '端到端测试',
    performance: '性能测试'
  }[value] ?? '自动化测试';
}

function formatDurationMs(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration)) return '';
  return duration < 1000 ? `${duration.toFixed(duration < 10 ? 1 : 0)} ms` : `${(duration / 1000).toFixed(2)} s`;
}

function hexAlpha(hex, alpha) {
  const value = String(hex).replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(value)) return `rgba(128, 145, 157, ${alpha})`;
  const number = Number.parseInt(value, 16);
  return `rgba(${number >> 16}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`;
}

function nodeFillColor(test, { selected = false, hovered = false, onFocusedRoute = true } = {}) {
  if (selected) return '#e8fff7';
  const routeColor = scenarioById(test.scenarioIds[0])?.color
    ?? domainById(test.domainId)?.color
    ?? '#7eb4c9';
  if (!onFocusedRoute) return mixHex(routeColor, '#101922', .12);
  if (hovered) return mixHex(routeColor, '#d9f5fb', .58);
  return mixHex(routeColor, '#0a1720', test.transfer ? .48 : .36);
}

function mixHex(foreground, background, foregroundWeight) {
  const parse = (hex) => {
    const value = String(hex).replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(value)) return null;
    const number = Number.parseInt(value, 16);
    return [number >> 16, (number >> 8) & 255, number & 255];
  };
  const front = parse(foreground);
  const back = parse(background);
  if (!front || !back) return background;
  const weight = Math.max(0, Math.min(1, foregroundWeight));
  return `#${front.map((channel, index) => Math.round(channel * weight + back[index] * (1 - weight))
    .toString(16)
    .padStart(2, '0')).join('')}`;
}

function isTypingTarget(target) {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || target?.isContentEditable;
}

function showToast(message, error = false) {
  window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', error);
  elements.toast.classList.add('visible');
  state.toastTimer = window.setTimeout(() => elements.toast.classList.remove('visible'), 2400);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: projectAccessHeaders({ Accept: 'application/json', ...(options.headers ?? {}) }),
    cache: 'no-store'
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && ['PROJECT_ACCESS_INVALID', 'PROJECT_ACCESS_REQUIRED'].includes(body?.error?.code)) {
      clearProjectAccessToken();
    }
    const error = new Error(body?.error?.message ?? `请求失败（${response.status}）`);
    error.code = body?.error?.code;
    throw error;
  }
  return body;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
