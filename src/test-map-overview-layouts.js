import ELK from 'elkjs/lib/elk.bundled.js';

const NODE_SIZE = 28;
const ELK_LANE_CHUNK_SIZE = 8;
const DOMAIN_PREFIX = 'domain:';
const LAYOUT_PADDING = 120;
const ORBIT_INNER_RADIUS = 74;
const ORBIT_RING_GAP = 60;
const ORBIT_NODE_GAP = 54;
const ORBIT_EDGE_PADDING = 72;
const ORBIT_SECTOR_GAP = Math.PI / 28;
const TAU = Math.PI * 2;

export const TEST_MAP_LAYOUT_EXPERIMENTS = Object.freeze([
  Object.freeze({ id: 'islands', label: '轨道星域', engine: 'ELK Force + orbital sectors' }),
  Object.freeze({ id: 'elk', label: 'ELK 规整', engine: 'ELK Layered' })
]);

export async function buildOverviewLayoutExperiments(catalog) {
  const islands = await buildIslandOverviewLayout(catalog);
  const elk = await buildElkOverviewLayout(catalog);
  return new Map([
    [islands.id, islands],
    [elk.id, elk]
  ]);
}

export async function buildElkOverviewLayout(catalog, elk = new ELK()) {
  const domainWeights = buildDomainWeights(catalog);
  const graph = {
    id: 'test-map-elk-root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.padding': '[top=60,left=60,bottom=60,right=60]',
      'elk.spacing.componentComponent': '120',
      'elk.spacing.nodeNode': '100',
      'elk.layered.spacing.nodeNodeBetweenLayers': '140',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP'
    },
    children: catalog.domains
      .filter((domain) => domain.testCount > 0)
      .map((domain) => buildElkDomainGraph(catalog, domain)),
    edges: maximumSpanningDomainEdges(catalog, domainWeights)
  };

  const result = await elk.layout(graph);
  return layoutFromElkDomains(catalog, result, {
    id: 'elk',
    label: 'ELK 规整',
    engine: 'ELK Layered'
  });
}

export async function buildIslandOverviewLayout(catalog, elk = new ELK()) {
  const localDomains = catalog.domains
    .filter((domain) => domain.testCount > 0)
    .map((domain) => buildOrbitalDomain(catalog, domain));
  const domainWeights = buildDomainWeights(catalog);
  const graph = {
    id: 'test-map-island-root',
    layoutOptions: {
      'elk.algorithm': 'force',
      'elk.randomSeed': '7',
      'elk.padding': '[top=80,left=80,bottom=80,right=80]',
      'elk.spacing.nodeNode': '150',
      'elk.force.temperature': '0.001',
      'elk.force.repulsion': '2.5'
    },
    children: localDomains.map((domain) => ({
      id: domainNodeId(domain.id),
      width: domain.width,
      height: domain.height
    })),
    edges: connectedDomainEdges(catalog, domainWeights)
  };
  const result = await elk.layout(graph);
  const positionedDomains = new Map(result.children.map((domain) => [domain.id, domain]));
  const positions = new Map();
  const domainBounds = new Map();

  for (const local of localDomains) {
    const positioned = positionedDomains.get(domainNodeId(local.id));
    if (!positioned) continue;
    for (const [testId, point] of local.positions) {
      positions.set(testId, {
        x: positioned.x + point.x,
        y: -(positioned.y + point.y)
      });
    }
    domainBounds.set(local.id, {
      minX: positioned.x,
      maxX: positioned.x + local.width,
      minY: -(positioned.y + local.height),
      maxY: -positioned.y
    });
  }

  return finalizeLayout(catalog, {
    id: 'islands',
    label: '轨道星域',
    engine: 'ELK Force + orbital sectors',
    domainShape: 'circle',
    positions,
    domainBounds
  });
}

export function serializeOverviewLayoutExperiments(layouts) {
  return {
    version: 1,
    defaultMode: 'islands',
    items: Object.fromEntries([...layouts].map(([id, layout]) => [id, {
      id: layout.id,
      label: layout.label,
      engine: layout.engine,
      domainShape: layout.domainShape ?? 'rectangle',
      positions: Object.fromEntries(layout.positions),
      routes: Object.fromEntries(layout.routes),
      domainBounds: Object.fromEntries(layout.domainBounds),
      extent: layout.extent
    }]))
  };
}

function buildElkDomainGraph(catalog, domain) {
  const tests = catalog.tests.filter((test) => test.domainId === domain.id);
  const groups = groupBy(tests, (test) => test.scenarioIds[0]);
  const edges = [];

  for (const [scenarioId, entries] of groups) {
    entries.sort(compareTestSource);
    for (let index = 1; index < entries.length; index += 1) {
      if (index % ELK_LANE_CHUNK_SIZE === 0) continue;
      edges.push({
        id: `elk-lane:${domain.id}:${scenarioId}:${index}`,
        sources: [entries[index - 1].id],
        targets: [entries[index].id]
      });
    }
  }

  return {
    id: domainNodeId(domain.id),
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.separateConnectedComponents': 'true',
      'elk.aspectRatio': '1.5',
      'elk.padding': '[top=72,left=48,bottom=48,right=48]',
      'elk.spacing.componentComponent': '42',
      'elk.spacing.nodeNode': '30',
      'elk.layered.spacing.nodeNodeBetweenLayers': '38',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX'
    },
    children: tests.map((test) => ({ id: test.id, width: NODE_SIZE, height: NODE_SIZE })),
    edges
  };
}

function buildOrbitalDomain(catalog, domain) {
  const tests = catalog.tests.filter((test) => test.domainId === domain.id);
  const scenarioOrder = new Map(catalog.scenarios.map((scenario, index) => [scenario.id, index]));
  const groups = [...groupBy(tests, (test) => test.scenarioIds[0])]
    .map(([scenarioId, entries]) => ({
      scenarioId,
      entries: entries.sort((left, right) => Number(right.transfer) - Number(left.transfer) || compareTestSource(left, right))
    }))
    .sort((left, right) => (scenarioOrder.get(left.scenarioId) ?? 999) - (scenarioOrder.get(right.scenarioId) ?? 999));
  const usableAngle = TAU - groups.length * ORBIT_SECTOR_GAP;
  const positions = new Map();
  let cursorAngle = -Math.PI / 2;
  let outerNodeRadius = ORBIT_INNER_RADIUS;

  for (const group of groups) {
    const sectorSpan = usableAngle * (group.entries.length / tests.length);
    let remaining = group.entries.length;
    let entryIndex = 0;
    let ringIndex = 0;
    while (remaining > 0) {
      const radius = ORBIT_INNER_RADIUS + ringIndex * ORBIT_RING_GAP;
      const capacity = Math.max(1, Math.floor((radius * sectorSpan) / ORBIT_NODE_GAP));
      const ringCount = Math.min(capacity, remaining);
      for (let index = 0; index < ringCount; index += 1) {
        const angle = cursorAngle + sectorSpan * ((index + .5) / ringCount);
        const test = group.entries[entryIndex];
        positions.set(test.id, {
          x: radius * Math.cos(angle),
          y: radius * Math.sin(angle)
        });
        entryIndex += 1;
      }
      remaining -= ringCount;
      outerNodeRadius = Math.max(outerNodeRadius, radius);
      ringIndex += 1;
    }
    cursorAngle += sectorSpan + ORBIT_SECTOR_GAP;
  }

  const radius = Math.max(132, outerNodeRadius + ORBIT_EDGE_PADDING);
  for (const point of positions.values()) {
    point.x += radius;
    point.y += radius;
  }

  return {
    id: domain.id,
    positions,
    width: radius * 2,
    height: radius * 2
  };
}

function layoutFromElkDomains(catalog, result, meta) {
  const positions = new Map();
  const domainBounds = new Map();

  for (const domainNode of result.children ?? []) {
    const domainId = domainNode.id.slice(DOMAIN_PREFIX.length);
    for (const testNode of domainNode.children ?? []) {
      positions.set(testNode.id, {
        x: domainNode.x + testNode.x + testNode.width / 2,
        y: -(domainNode.y + testNode.y + testNode.height / 2)
      });
    }
    domainBounds.set(domainId, {
      minX: domainNode.x,
      maxX: domainNode.x + domainNode.width,
      minY: -(domainNode.y + domainNode.height),
      maxY: -domainNode.y
    });
  }

  return finalizeLayout(catalog, { ...meta, positions, domainBounds });
}

function finalizeLayout(catalog, layout) {
  const routes = new Map(catalog.scenarios.map((scenario) => [
    scenario.id,
    layout.domainShape === 'circle'
      ? orderOrbitalScenarioTests(catalog, scenario.id, layout.positions, layout.domainBounds)
      : orderScenarioTests(catalog, scenario.id, layout.positions, layout.domainBounds)
  ]));
  const bounds = [...layout.domainBounds.values()];
  const extent = bounds.length > 0 ? {
    minX: Math.min(...bounds.map((entry) => entry.minX)) - LAYOUT_PADDING,
    maxX: Math.max(...bounds.map((entry) => entry.maxX)) + LAYOUT_PADDING,
    minY: Math.min(...bounds.map((entry) => entry.minY)) - LAYOUT_PADDING,
    maxY: Math.max(...bounds.map((entry) => entry.maxY)) + LAYOUT_PADDING
  } : extentFor([...layout.positions.values()], LAYOUT_PADDING);
  return { ...layout, routes, extent };
}

function orderOrbitalScenarioTests(catalog, scenarioId, positions, domainBounds) {
  const byDomain = groupBy(
    catalog.tests.filter((test) => test.scenarioIds.includes(scenarioId) && positions.has(test.id)),
    (test) => test.domainId
  );
  const orderedDomains = nearestDomainPath([...byDomain.keys()], domainBounds);
  return orderedDomains.flatMap((domainId) => {
    const bounds = domainBounds.get(domainId);
    const center = {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2
    };
    return byDomain.get(domainId)
      .sort((left, right) => {
        const leftPoint = positions.get(left.id);
        const rightPoint = positions.get(right.id);
        const leftRadius = Math.hypot(leftPoint.x - center.x, leftPoint.y - center.y);
        const rightRadius = Math.hypot(rightPoint.x - center.x, rightPoint.y - center.y);
        const leftAngle = Math.atan2(leftPoint.y - center.y, leftPoint.x - center.x);
        const rightAngle = Math.atan2(rightPoint.y - center.y, rightPoint.x - center.x);
        return leftRadius - rightRadius || leftAngle - rightAngle || compareTestSource(left, right);
      })
      .map((test) => test.id);
  });
}

function orderScenarioTests(catalog, scenarioId, positions, domainBounds) {
  const byDomain = groupBy(
    catalog.tests.filter((test) => test.scenarioIds.includes(scenarioId) && positions.has(test.id)),
    (test) => test.domainId
  );
  const orderedDomains = nearestDomainPath([...byDomain.keys()], domainBounds);
  return orderedDomains.flatMap((domainId) => byDomain.get(domainId)
    .sort((left, right) => {
      const leftPoint = positions.get(left.id);
      const rightPoint = positions.get(right.id);
      return leftPoint.x - rightPoint.x || rightPoint.y - leftPoint.y || compareTestSource(left, right);
    })
    .map((test) => test.id));
}

function nearestDomainPath(domainIds, domainBounds) {
  if (domainIds.length < 2) return domainIds;
  const centers = new Map(domainIds.map((domainId) => {
    const bounds = domainBounds.get(domainId);
    return [domainId, {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2
    }];
  }));
  const remaining = new Set(domainIds);
  let current = [...remaining].sort((left, right) => (
    centers.get(left).x - centers.get(right).x
      || centers.get(right).y - centers.get(left).y
      || left.localeCompare(right)
  ))[0];
  const ordered = [current];
  remaining.delete(current);
  while (remaining.size > 0) {
    const currentPoint = centers.get(current);
    current = [...remaining].sort((left, right) => {
      const leftDistance = squaredDistance(currentPoint, centers.get(left));
      const rightDistance = squaredDistance(currentPoint, centers.get(right));
      return leftDistance - rightDistance || left.localeCompare(right);
    })[0];
    ordered.push(current);
    remaining.delete(current);
  }
  return ordered;
}

function buildDomainWeights(catalog) {
  const weights = new Map();
  for (const scenario of catalog.scenarios) {
    const domainIds = [...new Set(catalog.tests
      .filter((test) => test.scenarioIds.includes(scenario.id))
      .map((test) => test.domainId))];
    for (let left = 0; left < domainIds.length; left += 1) {
      for (let right = left + 1; right < domainIds.length; right += 1) {
        const key = domainPairKey(domainIds[left], domainIds[right]);
        weights.set(key, (weights.get(key) ?? 0) + 1);
      }
    }
  }
  return weights;
}

function maximumSpanningDomainEdges(catalog, weights) {
  const domainIds = catalog.domains.filter((domain) => domain.testCount > 0).map((domain) => domain.id);
  if (domainIds.length < 2) return [];
  const start = domainIds
    .map((domainId, index) => ({
      domainId,
      index,
      weight: domainIds.reduce((sum, candidate) => sum + (weights.get(domainPairKey(domainId, candidate)) ?? 0), 0)
    }))
    .sort((left, right) => right.weight - left.weight || left.index - right.index)[0].domainId;
  const selected = new Set([start]);
  const edges = [];

  while (selected.size < domainIds.length) {
    let best = null;
    for (const source of selected) {
      for (const target of domainIds) {
        if (selected.has(target)) continue;
        const weight = weights.get(domainPairKey(source, target)) ?? 0;
        if (!best || weight > best.weight || (weight === best.weight && `${source}:${target}` < `${best.source}:${best.target}`)) {
          best = { source, target, weight };
        }
      }
    }
    selected.add(best.target);
    edges.push({
      id: `elk-domain:${edges.length}`,
      sources: [domainNodeId(best.source)],
      targets: [domainNodeId(best.target)]
    });
  }
  return edges;
}

function connectedDomainEdges(catalog, weights) {
  const domainIds = catalog.domains.filter((domain) => domain.testCount > 0).map((domain) => domain.id);
  return [...weights]
    .map(([key, weight]) => ({ key, weight, domainIds: key.split('|') }))
    .filter((entry) => entry.domainIds.every((domainId) => domainIds.includes(domainId)))
    .sort((left, right) => right.weight - left.weight || left.key.localeCompare(right.key))
    .slice(0, Math.min(weights.size, domainIds.length * 2 + 1))
    .map((entry, index) => ({
      id: `island-domain:${index}`,
      sources: [domainNodeId(entry.domainIds[0])],
      targets: [domainNodeId(entry.domainIds[1])]
    }));
}

function extentFor(points, padding) {
  if (points.length === 0) return { minX: -padding, maxX: padding, minY: -padding, maxY: padding };
  return {
    minX: Math.min(...points.map((point) => point.x)) - padding,
    maxX: Math.max(...points.map((point) => point.x)) + padding,
    minY: Math.min(...points.map((point) => point.y)) - padding,
    maxY: Math.max(...points.map((point) => point.y)) + padding
  };
}

function groupBy(items, keyFor) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFor(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function domainNodeId(domainId) {
  return `${DOMAIN_PREFIX}${domainId}`;
}

function domainPairKey(left, right) {
  return [left, right].sort().join('|');
}

function compareTestSource(left, right) {
  return left.file.localeCompare(right.file) || left.line - right.line || left.id.localeCompare(right.id);
}

function squaredDistance(left, right) {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2;
}
