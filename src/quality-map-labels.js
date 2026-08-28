const OVERVIEW_RATIO = .72;
const CONTEXT_RATIO = .28;
const DETAIL_RATIO = .055;

export function semanticDomainQuota({
  cameraRatio,
  domainCoverage = 0,
  visibleCount = 0,
  compact = false
}) {
  const count = Math.max(0, Math.floor(Number(visibleCount) || 0));
  if (count === 0) return 0;
  const ratio = Math.max(.001, Number(cameraRatio) || 1);
  const coverage = clamp(Number(domainCoverage) || 0, 0, 1);
  const overviewMinimum = compact ? 2 : 3;
  const overviewMaximum = compact ? 4 : 6;
  const overviewTarget = Math.min(
    count,
    Math.round(overviewMinimum + Math.sqrt(coverage) * (overviewMaximum - overviewMinimum))
  );
  const contextTarget = Math.min(
    count,
    (compact ? 6 : 10) + Math.round(clamp((coverage - .1) / .5, 0, 1) * (compact ? 4 : 10))
  );
  const contextProgress = smoothStep(inverseLerp(OVERVIEW_RATIO, CONTEXT_RATIO, ratio));
  const contextual = lerp(overviewTarget, contextTarget, contextProgress);
  const detailProgress = smoothStep(inverseLerp(.16, DETAIL_RATIO, ratio));
  return Math.max(1, Math.min(count, Math.round(lerp(contextual, count, detailProgress))));
}

export function selectSemanticLabelCandidates({
  tests,
  cameraRatio,
  domainCoverageById = new Map(),
  selectedTestId = null,
  hoveredTestId = null,
  focusedScenarioId = null,
  compact = false
}) {
  const eligible = tests.filter((test) => (
    !focusedScenarioId
    || test.id === selectedTestId
    || test.id === hoveredTestId
    || test.scenarioIds.includes(focusedScenarioId)
  ));
  const byDomain = new Map();
  for (const test of eligible) {
    if (!byDomain.has(test.domainId)) byDomain.set(test.domainId, []);
    byDomain.get(test.domainId).push(test);
  }
  const quotas = new Map([...byDomain].map(([domainId, entries]) => [
    domainId,
    semanticDomainQuota({
      cameraRatio,
      domainCoverage: valueById(domainCoverageById, domainId),
      visibleCount: entries.length,
      compact
    })
  ]));
  const selected = new Map();
  const countsByDomain = new Map();
  const coveredScenarios = new Set();

  const add = (test, reason) => {
    if (!test || selected.has(test.id)) return false;
    const used = countsByDomain.get(test.domainId) ?? 0;
    if (used >= (quotas.get(test.domainId) ?? 0)) return false;
    selected.set(test.id, { test, reason, priority: priorityFor(test, reason, selectedTestId, hoveredTestId) });
    countsByDomain.set(test.domainId, used + 1);
    for (const scenarioId of test.scenarioIds) coveredScenarios.add(scenarioId);
    return true;
  };

  add(eligible.find((test) => test.id === selectedTestId), 'selected');
  add(eligible.find((test) => test.id === hoveredTestId), 'hovered');

  for (const [domainId, entries] of [...byDomain].sort(([left], [right]) => left.localeCompare(right))) {
    if ((countsByDomain.get(domainId) ?? 0) > 0) continue;
    add(bestCandidate(entries, coveredScenarios, focusedScenarioId), 'domain');
  }

  const scenarioCounts = new Map();
  for (const test of eligible) {
    for (const scenarioId of test.scenarioIds) {
      scenarioCounts.set(scenarioId, (scenarioCounts.get(scenarioId) ?? 0) + 1);
    }
  }
  const majorScenarios = [...scenarioCounts]
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  for (const [scenarioId] of majorScenarios) {
    if (coveredScenarios.has(scenarioId)) continue;
    const candidate = bestCandidate(
      eligible.filter((test) => test.scenarioIds.includes(scenarioId)),
      coveredScenarios,
      focusedScenarioId
    );
    add(candidate, 'scenario');
  }

  for (const [domainId, entries] of [...byDomain].sort(([left], [right]) => left.localeCompare(right))) {
    while ((countsByDomain.get(domainId) ?? 0) < (quotas.get(domainId) ?? 0)) {
      const remaining = entries.filter((test) => !selected.has(test.id));
      if (remaining.length === 0) break;
      if (!add(bestCandidate(remaining, coveredScenarios, focusedScenarioId), 'density')) break;
    }
  }

  return [...selected.values()]
    .sort((left, right) => right.priority - left.priority || stableHash(left.test) - stableHash(right.test));
}

function bestCandidate(entries, coveredScenarios, focusedScenarioId) {
  return [...entries].sort((left, right) => (
    candidateScore(right, coveredScenarios, focusedScenarioId)
      - candidateScore(left, coveredScenarios, focusedScenarioId)
    || stableHash(left) - stableHash(right)
  ))[0] ?? null;
}

function candidateScore(test, coveredScenarios, focusedScenarioId) {
  const newScenarioCount = test.scenarioIds.filter((id) => !coveredScenarios.has(id)).length;
  const meaningfulRiskCount = (test.riskTags ?? []).filter((tag) => tag !== '行为回归').length;
  return newScenarioCount * 10_000
    + (focusedScenarioId && test.scenarioIds.includes(focusedScenarioId) ? 4_000 : 0)
    + (test.status === 'FAILED' ? 3_000 : 0)
    + meaningfulRiskCount * 900
    + (test.transfer ? 650 : 0)
    + test.scenarioIds.length * 90;
}

function priorityFor(test, reason, selectedTestId, hoveredTestId) {
  if (test.id === selectedTestId || reason === 'selected') return 1_000_000;
  if (test.id === hoveredTestId || reason === 'hovered') return 900_000;
  if (reason === 'scenario') return 500_000 + candidateScore(test, new Set(), null);
  if (reason === 'domain') return 400_000 + candidateScore(test, new Set(), null);
  return candidateScore(test, new Set(), null);
}

function stableHash(test) {
  const value = `${test.file ?? ''}:${test.line ?? 0}:${test.title ?? ''}`;
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function valueById(values, id) {
  if (typeof values?.get === 'function') return values.get(id) ?? 0;
  return values?.[id] ?? 0;
}

function inverseLerp(start, end, value) {
  if (start === end) return 0;
  return clamp((start - value) / (start - end), 0, 1);
}

function smoothStep(value) {
  const clamped = clamp(value, 0, 1);
  return clamped * clamped * (3 - 2 * clamped);
}

function lerp(start, end, progress) {
  return start + (end - start) * progress;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
