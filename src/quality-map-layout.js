const DIRECTIONS = Object.freeze(['west', 'north', 'east', 'south']);

const PREFERRED_DIRECTION = Object.freeze({
  'client-board': 'west',
  'client-interface': 'west',
  'state-flow': 'north',
  'evidence-review': 'north',
  'run-lifecycle': 'east',
  'agent-dispatch': 'east',
  'mcp-contract': 'east',
  'data-consistency': 'south',
  'project-storage': 'south',
  'subscription-data': 'south'
});

const DENSE_BRANCH_LIMITS = Object.freeze({
  west: 3,
  north: 1,
  east: 2,
  south: 1
});

const SPARSE_BRANCH_LIMITS = Object.freeze({
  west: 3,
  north: 2,
  east: 4,
  south: 2
});

export function hydrateOverviewLayoutExperiments(payload) {
  if (!payload || payload.version !== 1 || !payload.items) return new Map();
  return new Map(Object.entries(payload.items).map(([id, layout]) => [id, {
    id: layout.id ?? id,
    label: layout.label ?? id,
    engine: layout.engine ?? '',
    domainShape: layout.domainShape ?? 'rectangle',
    positions: new Map(Object.entries(layout.positions ?? {})),
    routes: new Map(Object.entries(layout.routes ?? {})),
    domainBounds: new Map(Object.entries(layout.domainBounds ?? {})),
    extent: layout.extent
  }]));
}

export function spreadOverviewLayout({ catalog, layout, factor = 1 }) {
  if (!catalog?.tests || !layout?.positions || !layout?.domainBounds) return layout;
  const spreadFactor = Math.min(1.5, Math.max(.85, Number(factor) || 1));
  const fields = catalog.domains
    .map((domain) => {
      const bounds = layout.domainBounds.get(domain.id);
      if (!bounds) return null;
      return {
        id: domain.id,
        baseCenter: boundsCenter(bounds),
        center: boundsCenter(bounds),
        halfWidth: ((bounds.maxX - bounds.minX) / 2) * spreadFactor,
        halfHeight: ((bounds.maxY - bounds.minY) / 2) * spreadFactor
      };
    })
    .filter(Boolean);

  separateFields(fields, 32);
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  const positions = new Map(layout.positions);
  for (const test of catalog.tests) {
    const point = layout.positions.get(test.id);
    const field = fieldsById.get(test.domainId);
    if (!point || !field) continue;
    positions.set(test.id, {
      x: field.center.x + (point.x - field.baseCenter.x) * spreadFactor,
      y: field.center.y + (point.y - field.baseCenter.y) * spreadFactor
    });
  }

  const domainBounds = new Map(fields.map((field) => [field.id, {
    minX: field.center.x - field.halfWidth,
    maxX: field.center.x + field.halfWidth,
    minY: field.center.y - field.halfHeight,
    maxY: field.center.y + field.halfHeight
  }]));
  const corners = [...domainBounds.values()].flatMap((bounds) => [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY }
  ]);

  return {
    ...layout,
    positions,
    domainBounds,
    extent: corners.length ? extentFor(corners, 120) : layout.extent,
    spreadFactor
  };
}

export function buildFocusLayout({
  catalog,
  overviewLayout,
  selectedTestId,
  visibleDomainIds = null
}) {
  const selected = catalog.tests.find((test) => test.id === selectedTestId);
  const center = overviewLayout.positions.get(selectedTestId);
  if (!selected || !center) return null;

  const allowedDomains = visibleDomainIds ? new Set(visibleDomainIds) : null;
  const scenarioIds = selected.scenarioIds
    .filter((scenarioId) => catalog.scenarios.some((scenario) => scenario.id === scenarioId))
    .slice(0, DIRECTIONS.length);
  const directions = assignDirections(scenarioIds);
  const branchLimits = scenarioIds.length >= 4 ? DENSE_BRANCH_LIMITS : SPARSE_BRANCH_LIMITS;
  const positions = new Map(overviewLayout.positions);
  const routes = new Map();
  const routePoints = new Map();
  const routeLabels = new Map();
  const testDirections = new Map([[selected.id, 'center']]);
  const visibleTestIds = new Set([selected.id]);
  const usedTestIds = new Set([selected.id]);

  for (const scenarioId of scenarioIds) {
    const direction = directions.get(scenarioId);
    const candidates = rankRelatedTests(catalog.tests, selected, scenarioId, allowedDomains)
      .filter((test) => !usedTestIds.has(test.id))
      .slice(0, branchLimits[direction]);
    const geometry = branchGeometry(center, direction, candidates.length);

    candidates.forEach((test, index) => {
      positions.set(test.id, geometry.stations[index]);
      testDirections.set(test.id, direction);
      visibleTestIds.add(test.id);
      usedTestIds.add(test.id);
    });
    routes.set(scenarioId, [selected.id, ...candidates.map((test) => test.id)]);
    routePoints.set(scenarioId, [center, ...geometry.path]);
    routeLabels.set(scenarioId, geometry.label);
  }

  const visiblePoints = [
    ...[...visibleTestIds].map((id) => positions.get(id)).filter(Boolean),
    ...[...routePoints.values()].flat()
  ];

  return {
    positions,
    routes,
    routePoints,
    routeLabels,
    domainBounds: new Map(),
    extent: extentFor(visiblePoints, 100),
    visibleTestIds,
    scenarioIds,
    directions,
    testDirections,
    selectedTestId
  };
}

export function rankRelatedTests(tests, selected, scenarioId, allowedDomains = null) {
  const allowed = allowedDomains ? new Set(allowedDomains) : null;
  const selectedModules = new Set(selected.sourceModules ?? []);
  const selectedScenarios = new Set(selected.scenarioIds ?? []);
  const selectedRisks = new Set(selected.riskTags ?? []);

  return tests
    .filter((candidate) => candidate.id !== selected.id)
    .filter((candidate) => candidate.scenarioIds.includes(scenarioId))
    .filter((candidate) => !allowed || allowed.has(candidate.domainId))
    .map((candidate) => ({
      candidate,
      score: relatedScore(candidate, selected, selectedModules, selectedScenarios, selectedRisks)
    }))
    .sort((left, right) => right.score - left.score
      || left.candidate.file.localeCompare(right.candidate.file)
      || left.candidate.line - right.candidate.line
      || left.candidate.id.localeCompare(right.candidate.id))
    .map(({ candidate }) => candidate);
}

function relatedScore(candidate, selected, selectedModules, selectedScenarios, selectedRisks) {
  const sharedModules = (candidate.sourceModules ?? []).filter((item) => selectedModules.has(item)).length;
  const sharedScenarios = candidate.scenarioIds.filter((item) => selectedScenarios.has(item)).length;
  const sharedRisks = (candidate.riskTags ?? []).filter((item) => selectedRisks.has(item)).length;
  const sameFile = candidate.file === selected.file;
  const lineAffinity = sameFile ? Math.max(0, 20 - Math.floor(Math.abs(candidate.line - selected.line) / 5)) : 0;
  return (sameFile ? 80 : 0)
    + lineAffinity
    + (candidate.domainId === selected.domainId ? 22 : 0)
    + sharedModules * 18
    + sharedScenarios * 9
    + sharedRisks * 3
    + (candidate.transfer ? 2 : 0);
}

function assignDirections(scenarioIds) {
  const available = new Set(DIRECTIONS);
  const result = new Map();

  for (const scenarioId of scenarioIds) {
    const preferred = PREFERRED_DIRECTION[scenarioId];
    if (preferred && available.has(preferred)) {
      result.set(scenarioId, preferred);
      available.delete(preferred);
    }
  }

  for (const scenarioId of scenarioIds) {
    if (result.has(scenarioId)) continue;
    const direction = available.values().next().value;
    if (!direction) break;
    result.set(scenarioId, direction);
    available.delete(direction);
  }
  return result;
}

function branchGeometry(center, direction, count) {
  const stationCount = Math.max(1, count);
  const factories = {
    west: () => {
      const stations = Array.from({ length: stationCount }, (_, index) => ({
        x: center.x - 320,
        y: center.y + index * 132
      }));
      return {
        stations,
        path: [{ x: center.x - 180, y: center.y }, ...stations],
        label: { x: center.x - 198, y: center.y - 48, align: 'right' }
      };
    },
    north: () => {
      const stations = Array.from({ length: stationCount }, (_, index) => ({
        x: center.x + index * 56,
        y: center.y + 224 + index * 132
      }));
      return {
        stations,
        path: [{ x: center.x, y: center.y + 126 }, ...stations],
        label: { x: center.x + 24, y: center.y + 142, align: 'left' }
      };
    },
    east: () => {
      const stations = Array.from({ length: stationCount }, (_, index) => index === 0
        ? { x: center.x + 300, y: center.y + 42 }
        : { x: center.x + 438, y: center.y - 122 - (index - 1) * 132 });
      return {
        stations,
        path: [{ x: center.x + 176, y: center.y }, ...stations],
        label: { x: center.x + 222, y: center.y + 88, align: 'left' }
      };
    },
    south: () => {
      const stations = Array.from({ length: stationCount }, (_, index) => ({
        x: center.x + index * 138,
        y: center.y - 236 - index * 128
      }));
      return {
        stations,
        path: [{ x: center.x, y: center.y - 132 }, ...stations],
        label: { x: center.x + 30, y: center.y - 150, align: 'left' }
      };
    }
  };
  return factories[direction]();
}

function extentFor(points, padding) {
  return {
    minX: Math.min(...points.map((point) => point.x)) - padding,
    maxX: Math.max(...points.map((point) => point.x)) + padding,
    minY: Math.min(...points.map((point) => point.y)) - padding,
    maxY: Math.max(...points.map((point) => point.y)) + padding
  };
}

function boundsCenter(bounds) {
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2
  };
}

function separateFields(fields, gap) {
  for (let iteration = 0; iteration < 64; iteration += 1) {
    let moved = false;
    for (let leftIndex = 0; leftIndex < fields.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < fields.length; rightIndex += 1) {
        const left = fields[leftIndex];
        const right = fields[rightIndex];
        const dx = right.center.x - left.center.x;
        const dy = right.center.y - left.center.y;
        const overlapX = left.halfWidth + right.halfWidth + gap - Math.abs(dx);
        const overlapY = left.halfHeight + right.halfHeight + gap - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;
        moved = true;
        if (overlapX <= overlapY) {
          const direction = dx === 0 ? (left.id.localeCompare(right.id) <= 0 ? 1 : -1) : Math.sign(dx);
          const shift = overlapX / 2 + .01;
          left.center.x -= direction * shift;
          right.center.x += direction * shift;
        } else {
          const direction = dy === 0 ? (left.id.localeCompare(right.id) <= 0 ? 1 : -1) : Math.sign(dy);
          const shift = overlapY / 2 + .01;
          left.center.y -= direction * shift;
          right.center.y += direction * shift;
        }
      }
    }
    if (!moved) break;
  }
}
