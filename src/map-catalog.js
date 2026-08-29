import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { javascriptCodeMask } from './catalog-analyzer.js';

export const TEST_STATUS = Object.freeze({
  UNOBSERVED: 'UNOBSERVED'
});

export const TEST_DOMAINS = Object.freeze([
  domain('scheduling', '调度与依赖', '#f1b73b', [
    'autonomous-board.test.js',
    'dependency-schedule.test.js',
    'domain.test.js',
    'phase-edit.test.js',
    'scan-proposal.test.js',
    'schedule-edit.test.js'
  ]),
  domain('agent-execution', 'Agent 执行与复核', '#9c6cff', [
    'agent-auth.test.js',
    'agent-dispatch.test.js',
    'agent-reporting.test.js',
    'agent-run-repair.test.js',
    'autonomous-api.test.js',
    'vertical-slice.test.js'
  ]),
  domain('client-experience', '客户界面', '#43a9ff', [
    'autonomous-ui.test.js',
    'brand-assets.test.js',
    'client-board.test.js',
    'ui-form.test.js'
  ]),
  domain('mcp-integration', 'MCP 与集成', '#62d3d8', [
    'codex-integration.test.js',
    'mcp-http.test.js',
    'mcp.test.js',
    'test-governance.test.js',
    'test-map.test.js'
  ]),
  domain('subscriptions', '订阅余量', '#e879b5', [
    'subscription-adapters.test.js',
    'subscription-api.test.js',
    'subscription-extension.test.js',
    'subscription-ui.test.js',
    'subscriptions.test.js'
  ]),
  domain('storage-projects', '存储与项目', '#39d39a', [
    'compose-dev.test.js',
    'portfolio-v2.test.js',
    'project-merge.test.js',
    'schedule-reconciliation.test.js',
    'store.test.js',
    'trajectory.test.js'
  ]),
  domain('collaborative-canvas', '协作画布', '#f06c6c', [
    'canvas-service.test.js',
    'project-access-api.test.js',
    'project-collaboration.test.js'
  ])
]);

export const TEST_SCENARIOS = Object.freeze([
  scenario('client-board', '客户面板拖动', '#43a9ff'),
  scenario('state-flow', '状态流转', '#39d39a'),
  scenario('run-lifecycle', 'Run 生命周期', '#9c6cff'),
  scenario('data-consistency', '数据一致性', '#f1b73b'),
  scenario('task-scheduling', '任务排期', '#ff8b62'),
  scenario('dependency-order', '依赖顺序', '#d5d86e'),
  scenario('agent-dispatch', 'Agent 调度', '#b779ef'),
  scenario('evidence-review', '证据与复核', '#63d5aa'),
  scenario('client-interface', '客户交互', '#6a9cff'),
  scenario('mcp-contract', 'MCP 契约', '#58c7d8'),
  scenario('subscription-data', '额度采集', '#e879b5'),
  scenario('project-storage', '项目与存储', '#76c98f'),
  scenario('canvas-sync', '画布协作', '#f06c6c')
]);

const DOMAIN_BY_FILE = new Map(
  TEST_DOMAINS.flatMap((entry) => entry.files.map((file) => [file, entry.id]))
);

const PRIMARY_SCENARIO_BY_FILE = Object.freeze({
  'agent-auth.test.js': 'agent-dispatch',
  'agent-dispatch.test.js': 'agent-dispatch',
  'agent-reporting.test.js': 'evidence-review',
  'agent-run-repair.test.js': 'run-lifecycle',
  'autonomous-api.test.js': 'run-lifecycle',
  'autonomous-board.test.js': 'task-scheduling',
  'autonomous-ui.test.js': 'client-interface',
  'brand-assets.test.js': 'client-interface',
  'canvas-service.test.js': 'canvas-sync',
  'project-access-api.test.js': 'canvas-sync',
  'project-collaboration.test.js': 'canvas-sync',
  'client-board.test.js': 'client-board',
  'codex-integration.test.js': 'mcp-contract',
  'compose-dev.test.js': 'project-storage',
  'dependency-schedule.test.js': 'dependency-order',
  'domain.test.js': 'state-flow',
  'mcp-http.test.js': 'mcp-contract',
  'mcp.test.js': 'mcp-contract',
  'phase-edit.test.js': 'task-scheduling',
  'portfolio-v2.test.js': 'project-storage',
  'project-merge.test.js': 'project-storage',
  'scan-proposal.test.js': 'evidence-review',
  'schedule-edit.test.js': 'task-scheduling',
  'schedule-reconciliation.test.js': 'data-consistency',
  'store.test.js': 'project-storage',
  'subscription-adapters.test.js': 'subscription-data',
  'subscription-api.test.js': 'subscription-data',
  'subscription-extension.test.js': 'subscription-data',
  'subscription-ui.test.js': 'subscription-data',
  'subscriptions.test.js': 'subscription-data',
  'test-map.test.js': 'mcp-contract',
  'test-governance.test.js': 'mcp-contract',
  'trajectory.test.js': 'evidence-review',
  'ui-form.test.js': 'client-interface',
  'vertical-slice.test.js': 'run-lifecycle'
});

const CROSS_SCENARIO_RULES = Object.freeze([
  rule('state-flow', /\b(?:status|state|transition|cancel|defer|ready|review|verified|released)\b|状态|流转/i),
  rule('data-consistency', /persist|idempoten|stale|conflict|version|replay|reconcil|round.?trip|atomic|一致|持久|冲突/i),
  rule('run-lifecycle', /\b(?:runs?|claim|lease|executor|completion)\b|运行|领取|租约/i),
  rule('agent-dispatch', /\b(?:agent|dispatch|capabilit|compute|model)\b|调度|模型/i),
  rule('evidence-review', /evidence|review|verify|proposal|audit|证据|复核|验收|审计/i),
  rule('client-board', /drag|drop|swimlane|client board|customer board|move task|拖|泳道|客户面板/i),
  rule('client-interface', /\b(?:ui|html|css|render|dialog|drawer|button|form)\b|界面|表单|抽屉/i),
  rule('mcp-contract', /\b(?:mcp|http|transport|tool|token|scope|origin)\b|协议|接口/i),
  rule('dependency-order', /depend|parallel|\bdag\b|依赖|并行/i),
  rule('task-scheduling', /schedule|phase|rank|reorder|排期|阶段|排序/i),
  rule('subscription-data', /subscription|quota|balance|collector|provider|额度|余额|订阅/i),
  rule('project-storage', /\b(?:store|storage|project|portfolio|snapshot|json)\b|存储|项目/i),
  rule('canvas-sync', /canvas|whiteboard|websocket|\bwbo\b|画布|白板/i)
]);

export async function buildTestCatalog({
  root,
  projectName = 'Lifeline',
  repositoryUrl = 'https://github.com/qzhqzh/Lifeline',
  generatedAt = new Date().toISOString()
}) {
  const repositoryRoot = resolve(root);
  const files = await findTestFiles(resolve(repositoryRoot, 'test'));
  const tests = [];

  for (const absoluteFile of files) {
    const source = await readFile(absoluteFile, 'utf8');
    const file = normalizePath(relative(repositoryRoot, absoluteFile));
    const fileName = file.split('/').at(-1);
    const sourceModules = extractSourceModules(source);
    for (const declaration of extractTestDeclarations(source)) {
      const domainId = DOMAIN_BY_FILE.get(fileName) ?? 'mcp-integration';
      const scenarioIds = classifyScenarios(fileName, declaration.title);
      tests.push({
        id: stableTestId(file, declaration.line, declaration.title),
        title: declaration.title,
        file,
        line: declaration.line,
        framework: declaration.call === 'it' ? 'node:test · it' : 'node:test',
        declaration: declaration.modifier ? `${declaration.call}.${declaration.modifier}` : declaration.call,
        status: TEST_STATUS.UNOBSERVED,
        statusLabel: '未采集',
        domainId,
        scenarioIds,
        transfer: scenarioIds.length > 1,
        riskTags: classifyRiskTags(declaration.title, fileName),
        sourceModules
      });
    }
  }

  tests.sort(compareTests);
  const domains = TEST_DOMAINS.map(({ files: _files, ...entry }) => ({
    ...entry,
    testCount: tests.filter((test) => test.domainId === entry.id).length
  }));
  const scenarios = TEST_SCENARIOS.map((entry) => ({
    ...entry,
    testCount: tests.filter((test) => test.scenarioIds.includes(entry.id)).length
  })).filter((entry) => entry.testCount > 0);

  return {
    version: 1,
    configured: true,
    generatedAt,
    project: { name: projectName, repositoryUrl },
    source: {
      adapter: 'node-test-static-v1',
      root: 'test',
      executionStatus: 'UNOBSERVED',
      executionStatusLabel: '未采集运行结果'
    },
    summary: {
      testCount: tests.length,
      fileCount: files.length,
      domainCount: domains.filter((entry) => entry.testCount > 0).length,
      scenarioCount: scenarios.length,
      transferCount: tests.filter((test) => test.transfer).length,
      observedCount: 0
    },
    domains,
    scenarios,
    tests
  };
}

export function extractTestDeclarations(source) {
  const declarations = [];
  const codeMask = javascriptCodeMask(source);
  const pattern = /(^|\n)[\t ]*(test|it)(?:\.(skip|todo|only))?\s*\(\s*(['"`])((?:\\[\s\S]|(?!\4)[\s\S])*?)\4/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const declarationStart = match.index + match[1].length;
    if (!codeMask[declarationStart]) continue;
    const title = decodeTestTitle(match[5]);
    if (!title) continue;
    declarations.push({
      call: match[2],
      modifier: match[3] ?? null,
      title,
      line: countLines(source, declarationStart)
    });
  }
  return declarations;
}

export function classifyScenarios(fileName, title) {
  const scenarioIds = [];
  addUnique(scenarioIds, PRIMARY_SCENARIO_BY_FILE[fileName] ?? 'data-consistency');
  for (const { scenarioId, pattern } of CROSS_SCENARIO_RULES) {
    if (pattern.test(title)) addUnique(scenarioIds, scenarioId);
  }
  return scenarioIds.slice(0, 4);
}

function classifyRiskTags(title, fileName) {
  const value = `${fileName} ${title}`;
  const tags = [];
  if (/stale|conflict|version|idempoten|persist|atomic|reconcil/i.test(value)) tags.push('状态一致性');
  if (/auth|token|scope|origin|permission|secret/i.test(value)) tags.push('权限边界');
  if (/retry|repair|recover|replay|restart/i.test(value)) tags.push('恢复路径');
  if (/drag|drop|render|ui|form|dialog|drawer|canvas/i.test(value)) tags.push('交互回归');
  if (/dependency|parallel|dag|order/i.test(value)) tags.push('顺序约束');
  return tags.length > 0 ? tags.slice(0, 3) : ['行为回归'];
}

function extractSourceModules(source) {
  const modules = [];
  const pattern = /from\s+['"]\.\.\/(src|public)\/([^'"]+)['"]/g;
  let match;
  while ((match = pattern.exec(source)) !== null) addUnique(modules, `${match[1]}/${match[2]}`);
  return modules.slice(0, 8);
}

async function findTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findTestFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(path);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function compareTests(left, right) {
  const domainOrder = new Map(TEST_DOMAINS.map((entry, index) => [entry.id, index]));
  return (domainOrder.get(left.domainId) ?? 999) - (domainOrder.get(right.domainId) ?? 999)
    || left.file.localeCompare(right.file)
    || left.line - right.line;
}

function countLines(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (source.charCodeAt(cursor) === 10) line += 1;
  return line;
}

function decodeTestTitle(value) {
  return value
    .replace(/\\\r?\n[\t ]*/g, ' ')
    .replace(/\\n/g, ' ')
    .replace(/\\(['"`\\])/g, '$1')
    .replace(/\$\{[^}]+\}/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
}

function stableTestId(file, line, title) {
  return `test_${createHash('sha1').update(`${file}:${line}:${title}`).digest('hex').slice(0, 14)}`;
}

function normalizePath(value) {
  return value.replaceAll('\\', '/');
}

function addUnique(values, value) {
  if (value && !values.includes(value)) values.push(value);
}

function domain(id, label, color, files) {
  return { id, label, color, files };
}

function scenario(id, label, color) {
  return { id, label, color };
}

function rule(scenarioId, pattern) {
  return { scenarioId, pattern };
}
