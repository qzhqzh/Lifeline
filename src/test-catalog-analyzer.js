import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';

export const TEST_CATALOG_ANALYZER_VERSION = 2;

const DOMAIN_COLORS = Object.freeze([
  '#43a9ff', '#39d39a', '#9c6cff', '#f1b73b', '#e879b5',
  '#62d3d8', '#ff8b62', '#76c98f', '#f06c6c'
]);

const SCENARIO_DEFINITIONS = Object.freeze([
  scenarioRule('state-transition', '状态流转', '#39d39a', /\b(?:state|status|transition|cancel|release|review|approve|reject)\b|状态|流转|审核/i),
  scenarioRule('persistence-consistency', '持久化与一致性', '#f1b73b', /persist|storage|database|transaction|atomic|idempoten|stale|conflict|reconcil|一致|持久|事务|冲突/i),
  scenarioRule('permission-boundary', '权限边界', '#e879b5', /auth|token|scope|permission|role|access|secret|origin|权限|鉴权|令牌/i),
  scenarioRule('error-recovery', '异常与恢复', '#f06c6c', /error|fail|invalid|retry|recover|repair|fallback|timeout|异常|失败|恢复|重试/i),
  scenarioRule('input-validation', '输入校验', '#d5d86e', /validat|schema|required|empty|null|undefined|boundary|limit|校验|边界|为空/i),
  scenarioRule('integration-contract', '集成契约', '#58c7d8', /\b(?:api|http|mcp|request|response|endpoint|adapter|integration|contract)\b|接口|协议|集成|契约/i),
  scenarioRule('user-interaction', '用户交互', '#6a9cff', /\b(?:ui|render|click|drag|drop|form|dialog|drawer|canvas|keyboard)\b|界面|点击|拖动|表单|画布/i),
  scenarioRule('concurrency-order', '并发与顺序', '#b779ef', /concurr|parallel|queue|order|depend|race|lock|lease|并发|并行|顺序|依赖/i),
  scenarioRule('data-transform', '数据转换', '#63d5aa', /serializ|parse|format|convert|map|merge|aggregate|transform|解析|格式|转换|合并/i),
  scenarioRule('performance-capacity', '性能与容量', '#ff8b62', /perform|latency|throughput|memory|cache|batch|capacity|性能|延迟|缓存|容量/i)
]);

const IGNORED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '.venv', 'venv', '__pycache__',
  '.pytest_cache', '.mypy_cache', 'vendor', 'target'
]);

const TOKEN_STOP_WORDS = new Set([
  'test', 'tests', 'testing', 'spec', 'specs', 'should', 'when', 'then', 'with',
  'from', 'into', 'that', 'this', 'the', 'and', 'for', 'src', 'lib', 'app',
  'public', 'index', 'main', 'returns', 'keeps', 'allows', 'using', 'without',
  'file', 'files', 'module', 'modules', 'service', 'services', 'helper', 'helpers'
]);

const PYTHON_EXTERNAL_MODULES = new Set([
  'pytest', 'unittest', 'os', 'sys', 'pathlib', 'json', 'typing', 'datetime',
  'tempfile', 'collections', 'itertools', 'functools', 're', 'math', 'asyncio'
]);

export async function analyzeTestRepository({
  root,
  projectName = null,
  repositoryUrl = null,
  generatedAt = new Date().toISOString(),
  cachePath = null,
  domainLabeler = null
}) {
  const repositoryRoot = resolve(root);
  const cached = await readCache(cachePath);
  const discovered = await discoverTestFiles(repositoryRoot);
  const cacheFiles = {};
  const analyses = [];
  const errors = [];
  let hitCount = 0;
  let missCount = 0;

  for (const entry of discovered) {
    try {
      const source = await readFile(entry.absoluteFile, 'utf8');
      const fingerprint = createHash('sha256').update(source).digest('hex');
      const prior = cached.files?.[entry.file];
      let analysis;
      if (prior?.fingerprint === fingerprint && prior.adapterId === entry.adapter.id) {
        analysis = prior.analysis;
        hitCount += 1;
      } else {
        analysis = entry.adapter.analyze({
          source,
          file: entry.file,
          absoluteFile: entry.absoluteFile,
          repositoryRoot
        });
        missCount += 1;
      }
      cacheFiles[entry.file] = {
        fingerprint,
        adapterId: entry.adapter.id,
        analysis
      };
      if (analysis.tests.length > 0) analyses.push({ ...analysis, file: entry.file });
    } catch (error) {
      errors.push({ file: entry.file, message: error.message });
    }
  }

  const clustered = await clusterDomains(analyses, domainLabeler);
  const domainByFile = new Map(clustered.domains.flatMap((domain) => (
    domain.files.map((file) => [file, domain.id])
  )));
  const domainById = new Map(clustered.domains.map((domain) => [domain.id, domain]));
  const scenariosById = new Map();
  const tests = [];

  for (const analysis of analyses) {
    const domainId = domainByFile.get(analysis.file);
    const domainEntry = domainById.get(domainId);
    const titleOccurrences = new Map();
    analysis.tests.forEach((test) => {
      const evidenceText = [
        test.title,
        ...analysis.sourceModules,
        ...test.calls,
        ...test.assertions
      ].join(' ');
      const scenarioIds = [];
      for (const definition of SCENARIO_DEFINITIONS) {
        if (!definition.pattern.test(evidenceText)) continue;
        scenarioIds.push(definition.id);
        scenariosById.set(definition.id, definition);
        if (scenarioIds.length === 4) break;
      }
      if (scenarioIds.length === 0) {
        const fallbackId = `domain-behavior-${domainId}`;
        scenarioIds.push(fallbackId);
        scenariosById.set(fallbackId, {
          id: fallbackId,
          label: `${domainEntry?.label ?? '核心'}行为`,
          color: domainEntry?.color ?? DOMAIN_COLORS[0]
        });
      }
      const occurrenceKey = `${test.declaration}:${test.title}`;
      const occurrence = titleOccurrences.get(occurrenceKey) ?? 0;
      titleOccurrences.set(occurrenceKey, occurrence + 1);
      tests.push({
        id: stableTestId(analysis.file, test.declaration, test.title, occurrence),
        title: test.title,
        file: analysis.file,
        line: test.line,
        framework: test.framework,
        declaration: test.declaration,
        status: 'UNOBSERVED',
        statusLabel: '未采集',
        domainId,
        scenarioIds,
        transfer: scenarioIds.length > 1,
        riskTags: classifyRiskTags(evidenceText),
        sourceModules: analysis.sourceModules,
        calls: test.calls,
        assertions: test.assertions
      });
    });
  }

  const domainOrder = new Map(clustered.domains.map((domain, index) => [domain.id, index]));
  tests.sort((left, right) => (
    (domainOrder.get(left.domainId) ?? 999) - (domainOrder.get(right.domainId) ?? 999)
    || left.file.localeCompare(right.file)
    || left.line - right.line
    || left.id.localeCompare(right.id)
  ));
  const domains = clustered.domains.map(({ files: _files, ...domain }) => ({
    ...domain,
    testCount: tests.filter((test) => test.domainId === domain.id).length
  }));
  const scenarios = [...scenariosById.values()]
    .map(({ pattern: _pattern, ...entry }) => ({
      ...entry,
      testCount: tests.filter((test) => test.scenarioIds.includes(entry.id)).length
    }))
    .sort((left, right) => right.testCount - left.testCount || left.id.localeCompare(right.id));
  const adapters = [...new Set(analyses.map((analysis) => analysis.adapterId))];

  if (cachePath) {
    await writeJson(cachePath, {
      version: TEST_CATALOG_ANALYZER_VERSION,
      analyzer: 'lifeline-test-catalog-v2',
      files: cacheFiles
    });
  }

  return {
    version: TEST_CATALOG_ANALYZER_VERSION,
    configured: true,
    generatedAt,
    project: {
      name: projectName ?? basename(repositoryRoot),
      repositoryUrl
    },
    source: {
      adapter: 'multi-framework-static-v2',
      adapters,
      root: '.',
      executionStatus: 'UNOBSERVED',
      executionStatusLabel: '未采集运行结果',
      cache: { hitCount, missCount },
      errors
    },
    summary: {
      testCount: tests.length,
      fileCount: analyses.length,
      domainCount: domains.length,
      scenarioCount: scenarios.length,
      transferCount: tests.filter((test) => test.transfer).length,
      observedCount: 0
    },
    domains,
    scenarios,
    tests
  };
}

export function extractNodeTestDeclarations(source, file = '') {
  const framework = detectNodeFramework(source);
  const codeMask = javascriptCodeMask(source);
  const matches = [];
  const pattern = /(^|\n)[\t ]*(test|it)(?:\.(skip|todo|only|concurrent))?(?:\.each\s*\([\s\S]*?\))?\s*\(\s*(['"`])((?:\\[\s\S]|(?!\4)[\s\S])*?)\4/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const offset = match.index + match[1].length;
    if (!codeMask[offset]) continue;
    const title = decodeTitle(match[5]);
    if (!title) continue;
    matches.push({
      offset,
      bodyStart: pattern.lastIndex,
      title,
      line: countLines(source, match.index + match[1].length),
      framework,
      declaration: match[3] ? `${match[2]}.${match[3]}` : match[2]
    });
  }
  return matches.map((entry, index) => {
    const body = source.slice(entry.bodyStart, matches[index + 1]?.offset ?? source.length);
    return {
      title: entry.title,
      line: entry.line,
      framework: entry.framework,
      declaration: entry.declaration,
      calls: extractCalls(body, 'node'),
      assertions: extractAssertions(body, 'node'),
      file
    };
  });
}

export function javascriptCodeMask(source) {
  const mask = new Uint8Array(source.length);
  mask.fill(1);
  let mode = 'code';
  let quote = null;
  let regexCharacterClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (mode === 'code') {
      if (character === '/' && next === '/') {
        mask[index] = 0;
        mask[index + 1] = 0;
        mode = 'line-comment';
        index += 1;
        continue;
      }
      if (character === '/' && next === '*') {
        mask[index] = 0;
        mask[index + 1] = 0;
        mode = 'block-comment';
        index += 1;
        continue;
      }
      if (character === '/' && isRegexLiteralStart(source, index)) {
        mask[index] = 0;
        regexCharacterClass = false;
        mode = 'regex';
        continue;
      }
      if (character === "'" || character === '"' || character === '`') {
        mask[index] = 0;
        quote = character;
        mode = 'string';
      }
      continue;
    }
    if (mode === 'line-comment') {
      if (character === '\n') mode = 'code';
      else mask[index] = 0;
      continue;
    }
    if (mode === 'block-comment') {
      mask[index] = 0;
      if (character === '*' && next === '/') {
        mask[index + 1] = 0;
        index += 1;
        mode = 'code';
      }
      continue;
    }
    if (mode === 'regex') {
      mask[index] = 0;
      if (character === '\\') {
        if (index + 1 < source.length) mask[index + 1] = 0;
        index += 1;
        continue;
      }
      if (character === '[') regexCharacterClass = true;
      else if (character === ']') regexCharacterClass = false;
      else if (character === '/' && !regexCharacterClass) mode = 'code';
      continue;
    }
    mask[index] = 0;
    if (character === '\\') {
      if (index + 1 < source.length) mask[index + 1] = 0;
      index += 1;
      continue;
    }
    if (character === quote) {
      quote = null;
      mode = 'code';
    }
  }
  return mask;
}

function isRegexLiteralStart(source, index) {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1;
  if (cursor < 0) return true;
  if (/[(\[{=,:;!?&|+\-*%^~<>]/.test(source[cursor])) return true;
  const before = source.slice(0, cursor + 1);
  const word = /([A-Za-z_$][\w$]*)$/.exec(before)?.[1];
  return ['case', 'delete', 'do', 'else', 'in', 'instanceof', 'of', 'return', 'throw', 'typeof', 'void', 'yield'].includes(word);
}

export function extractPythonTestDeclarations(source, file = '') {
  const lines = source.split(/\r?\n/);
  const declarations = [];
  const framework = /\b(?:import|from)\s+pytest\b/.test(source)
    ? 'pytest'
    : /\bunittest(?:\.TestCase)?\b/.test(source) ? 'unittest' : 'python-test';

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)(async\s+)?def\s+(test_[A-Za-z0-9_]+)\s*\(/.exec(lines[index]);
    if (!match) continue;
    const indent = indentation(match[1]);
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (!lines[cursor].trim()) continue;
      const nextIndent = indentation(/^\s*/.exec(lines[cursor])[0]);
      if (nextIndent <= indent && /^(?:\s*)(?:def|class)\s+/.test(lines[cursor])) {
        end = cursor;
        break;
      }
    }
    const body = lines.slice(index + 1, end).join('\n');
    const className = nearestPythonClass(lines, index, indent);
    declarations.push({
      title: className ? `${className}.${match[3]}` : match[3],
      line: index + 1,
      framework,
      declaration: match[2] ? 'async def' : 'def',
      calls: extractCalls(body, 'python'),
      assertions: extractAssertions(body, 'python'),
      file
    });
  }
  return declarations;
}

async function discoverTestFiles(repositoryRoot) {
  const discovered = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absoluteFile = resolve(directory, entry.name);
      const file = normalizePath(relative(repositoryRoot, absoluteFile));
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(absoluteFile);
        continue;
      }
      if (!entry.isFile()) continue;
      const adapter = adapterFor(file);
      if (adapter) discovered.push({ absoluteFile, file, adapter });
    }
  }
  await walk(repositoryRoot);
  return discovered;
}

const NODE_ADAPTER = {
  id: 'node-static-v2',
  matches(file) {
    if (!/\.(?:[cm]?[jt]sx?)$/i.test(file)) return false;
    return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/i.test(file)
      || /(?:\.test|\.spec)\.(?:[cm]?[jt]sx?)$/i.test(file);
  },
  analyze({ source, file, absoluteFile, repositoryRoot }) {
    return {
      adapterId: this.id,
      sourceModules: extractNodeSourceModules(source, absoluteFile, repositoryRoot),
      tests: extractNodeTestDeclarations(source, file)
    };
  }
};

const PYTHON_ADAPTER = {
  id: 'python-static-v2',
  matches(file) {
    return /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/i.test(file)
      || /(?:^|\/)tests?\/[^/]+\.py$/i.test(file);
  },
  analyze({ source, file }) {
    return {
      adapterId: this.id,
      sourceModules: extractPythonSourceModules(source),
      tests: extractPythonTestDeclarations(source, file)
    };
  }
};

function adapterFor(file) {
  if (NODE_ADAPTER.matches(file)) return NODE_ADAPTER;
  if (PYTHON_ADAPTER.matches(file)) return PYTHON_ADAPTER;
  return null;
}

async function clusterDomains(analyses, domainLabeler) {
  if (analyses.length === 0) return { domains: [] };
  const targetCount = analyses.length <= 3
    ? analyses.length
    : Math.min(9, Math.max(2, Math.round(Math.sqrt(analyses.length))));
  const clusters = analyses.map((analysis) => ({
    files: [analysis.file],
    weights: featureWeights(analysis)
  }));

  while (clusters.length > targetCount) {
    let best = null;
    for (let left = 0; left < clusters.length; left += 1) {
      for (let right = left + 1; right < clusters.length; right += 1) {
        const score = weightedJaccard(clusters[left].weights, clusters[right].weights);
        const key = `${clusters[left].files[0]}:${clusters[right].files[0]}`;
        if (!best || score > best.score || (score === best.score && key < best.key)) {
          best = { left, right, score, key };
        }
      }
    }
    const right = clusters.splice(best.right, 1)[0];
    const left = clusters[best.left];
    left.files = [...left.files, ...right.files].sort();
    left.weights = mergeWeights(left.weights, right.weights);
  }

  clusters.sort((left, right) => left.files[0].localeCompare(right.files[0]));
  const proposed = clusters.map((cluster) => defaultDomainLabel(cluster.weights));
  const labels = typeof domainLabeler === 'function'
    ? await domainLabeler(clusters.map((cluster, index) => ({ files: cluster.files, suggestedLabel: proposed[index] })))
    : proposed;
  return {
    domains: clusters.map((cluster, index) => ({
      id: `domain_${createHash('sha1').update(cluster.files.join('|')).digest('hex').slice(0, 10)}`,
      label: normalizeDomainLabel(labels?.[index]) || proposed[index],
      color: DOMAIN_COLORS[index % DOMAIN_COLORS.length],
      files: cluster.files
    }))
  };
}

function featureWeights(analysis) {
  const weights = new Map();
  addFeatureTokens(weights, analysis.file, 3);
  for (const module of analysis.sourceModules) addFeatureTokens(weights, module, 5);
  for (const test of analysis.tests) {
    addFeatureTokens(weights, test.title, 1);
    for (const call of test.calls) addFeatureTokens(weights, call, 1.5);
  }
  return weights;
}

function addFeatureTokens(weights, value, score) {
  for (const token of tokenize(value)) weights.set(token, (weights.get(token) ?? 0) + score);
}

function weightedJaccard(left, right) {
  const keys = new Set([...left.keys(), ...right.keys()]);
  let intersection = 0;
  let union = 0;
  for (const key of keys) {
    intersection += Math.min(left.get(key) ?? 0, right.get(key) ?? 0);
    union += Math.max(left.get(key) ?? 0, right.get(key) ?? 0);
  }
  return union === 0 ? 0 : intersection / union;
}

function mergeWeights(left, right) {
  const result = new Map(left);
  for (const [key, value] of right) result.set(key, (result.get(key) ?? 0) + value);
  return result;
}

function defaultDomainLabel(weights) {
  const ranked = [...weights]
    .filter(([token]) => token.length > 1 && !/^\d+$/.test(token))
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  if (ranked.length === 0) return 'Core behavior';
  const selected = [ranked[0][0]];
  if (ranked[1] && ranked[1][1] >= ranked[0][1] * .7) selected.push(ranked[1][0]);
  return selected.map(displayToken).join(' · ');
}

function extractNodeSourceModules(source, absoluteFile, repositoryRoot) {
  const modules = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      if (!match[1].startsWith('.')) continue;
      addUnique(modules, normalizePath(relative(repositoryRoot, resolve(dirname(absoluteFile), match[1]))));
    }
  }
  return modules.slice(0, 12);
}

function extractPythonSourceModules(source) {
  const modules = [];
  const pattern = /^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*))/gm;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const module = match[1] ?? match[2];
    const root = module.split('.')[0];
    if (!PYTHON_EXTERNAL_MODULES.has(root)) addUnique(modules, module.replaceAll('.', '/'));
  }
  return modules.slice(0, 12);
}

function extractCalls(body, language) {
  const calls = [];
  const pattern = language === 'python'
    ? /\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/g
    : /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g;
  const ignored = new Set(['test', 'it', 'describe', 'expect', 'assert', 'if', 'for', 'while', 'function', 'def', 'super']);
  let match;
  while ((match = pattern.exec(body)) !== null) {
    const root = match[1].split('.')[0];
    if (!ignored.has(root)) addUnique(calls, match[1]);
    if (calls.length === 12) break;
  }
  return calls;
}

function extractAssertions(body, language) {
  const assertions = [];
  if (language === 'python') {
    for (const line of body.split(/\r?\n/)) {
      if (/^\s*assert\b/.test(line)) addUnique(assertions, 'assert');
      const match = /\b(?:self\.)?(assert[A-Z]\w*)\s*\(/.exec(line);
      if (match) addUnique(assertions, match[1]);
    }
    return assertions.slice(0, 10);
  }
  let match;
  const assertPattern = /\b(assert(?:\.[A-Za-z_$][\w$]*)?)\s*\(/g;
  while ((match = assertPattern.exec(body)) !== null) addUnique(assertions, match[1]);
  const expectPattern = /\bexpect\s*\([\s\S]{0,160}?\)\s*\.\s*(to[A-Z][A-Za-z0-9_$]*)\s*\(/g;
  while ((match = expectPattern.exec(body)) !== null) addUnique(assertions, `expect.${match[1]}`);
  return assertions.slice(0, 10);
}

function classifyRiskTags(value) {
  const tags = [];
  if (/stale|conflict|atomic|idempoten|persist|transaction|一致|持久|冲突/i.test(value)) tags.push('状态一致性');
  if (/auth|token|scope|permission|secret|权限|鉴权/i.test(value)) tags.push('权限边界');
  if (/retry|recover|repair|timeout|fallback|恢复|重试|超时/i.test(value)) tags.push('恢复路径');
  if (/boundary|invalid|empty|null|undefined|limit|边界|校验/i.test(value)) tags.push('边界输入');
  if (/concurr|parallel|race|order|depend|并发|顺序|依赖/i.test(value)) tags.push('顺序约束');
  return tags.length > 0 ? tags.slice(0, 3) : ['行为回归'];
}

function detectNodeFramework(source) {
  if (/['"]node:test['"]/.test(source)) return 'node:test';
  if (/['"]vitest['"]/.test(source)) return 'Vitest';
  if (/['"]@jest\/globals['"]|\bjest\./.test(source)) return 'Jest';
  return 'JavaScript test';
}

function nearestPythonClass(lines, index, methodIndent) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const match = /^(\s*)class\s+([A-Za-z_]\w*)/.exec(lines[cursor]);
    if (!match) continue;
    if (indentation(match[1]) < methodIndent) return match[2];
  }
  return null;
}

function tokenize(value) {
  const normalized = String(value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._/\\:-]+/g, ' ')
    .toLowerCase();
  return (normalized.match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token) => !TOKEN_STOP_WORDS.has(token));
}

function displayToken(token) {
  const special = { api: 'API', ui: 'UI', mcp: 'MCP', cli: 'CLI', agent: 'Agent', auth: 'Auth' };
  return special[token] ?? `${token.charAt(0).toUpperCase()}${token.slice(1)}`;
}

function normalizeDomainLabel(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}

function decodeTitle(value) {
  return value
    .replace(/\\\r?\n[\t ]*/g, ' ')
    .replace(/\\n/g, ' ')
    .replace(/\\(['"`\\])/g, '$1')
    .replace(/\$\{[^}]+\}/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
}

function stableTestId(file, declaration, title, index) {
  return `test_${createHash('sha1').update(`${file}:${declaration}:${title}:${index}`).digest('hex').slice(0, 14)}`;
}

function scenarioRule(id, label, color, pattern) {
  return { id, label, color, pattern };
}

function indentation(value) {
  return value.replaceAll('\t', '    ').length;
}

function countLines(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (source.charCodeAt(cursor) === 10) line += 1;
  return line;
}

async function readCache(cachePath) {
  if (!cachePath) return { files: {} };
  try {
    const value = JSON.parse(await readFile(cachePath, 'utf8'));
    return value.version === TEST_CATALOG_ANALYZER_VERSION ? value : { files: {} };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return { files: {} };
    throw error;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizePath(value) {
  return value.replaceAll('\\', '/');
}

function addUnique(values, value) {
  if (value && !values.includes(value)) values.push(value);
}
