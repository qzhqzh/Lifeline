import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeTestRepository } from '../src/catalog-analyzer.js';
import {
  createTestEvidence,
  parseNodeTestCoverage,
  parseTapTestReport
} from '../src/test-evidence.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputPath = resolve(process.argv[2] ?? resolve(ROOT, 'public/data/lifeline-test-evidence.json'));
const captureEnvironment = { ...process.env, LIFELINE_EVIDENCE_CAPTURE: '1' };
const testFiles = await findTestFiles(resolve(ROOT, 'test'));
const relativeFiles = testFiles.map((file) => normalizePath(relative(ROOT, file)));
const generatedAt = new Date().toISOString();
const coverageArgs = [
  '--test',
  '--experimental-test-coverage',
  '--test-coverage-include=src/**/*.js',
  '--test-coverage-include=public/**/*.js',
  '--test-coverage-include=extension/**/*.js',
  '--test-coverage-include=scripts/**/*.mjs',
  '--test-reporter=tap',
  ...relativeFiles
];

const coverageRun = await run(process.execPath, coverageArgs, ROOT, captureEnvironment);
process.stdout.write(coverageRun.stdout);
process.stderr.write(coverageRun.stderr);

const fileReports = [];
let caseRunFailed = false;
for (const file of relativeFiles) {
  const result = await run(process.execPath, [
    '--test',
    '--test-isolation=none',
    '--test-reporter=tap',
    file
  ], ROOT, captureEnvironment);
  process.stderr.write(result.stderr);
  if (result.code !== 0) caseRunFailed = true;
  const report = parseTapTestReport(result.stdout, { observedAt: generatedAt });
  fileReports.push({
    ...report,
    results: report.results.map((entry) => ({ ...entry, file }))
  });
}

const catalog = await analyzeTestRepository({ root: ROOT, generatedAt });
const testReport = combineTestReports(fileReports, generatedAt);
const coverageReport = parseNodeTestCoverage(coverageRun.stdout, { observedAt: generatedAt });
const evidence = createTestEvidence({
  generatedAt,
  command: `node ${coverageArgs.join(' ')}`,
  declarationCount: catalog.summary.testCount,
  runnerEntryCount: testReport.summary.total,
  testReport,
  coverageReport
});

const requiredCoverageSources = [
  'src/catalog-analyzer.js',
  'src/map-catalog.js',
  'src/map-overview-layouts.js',
  'src/project-test-map.js'
];
const missingCoverageSources = requiredCoverageSources.filter((source) => (
  !coverageReport.files.some((entry) => entry.path === source || entry.path.endsWith(`/${source}`))
));
const countMismatch = catalog.summary.testCount !== testReport.summary.total;
if (countMismatch) {
  process.stderr.write(`Test evidence count mismatch: ${catalog.summary.testCount} declarations, ${testReport.summary.total} runner entries\n`);
}
if (missingCoverageSources.length > 0) {
  process.stderr.write(`Coverage omitted production sources: ${missingCoverageSources.join(', ')}\n`);
}
const captureFailed = coverageRun.code !== 0 || caseRunFailed || countMismatch || missingCoverageSources.length > 0;
if (captureFailed) {
  process.stderr.write('Evidence capture failed; the last known-good evidence file was preserved.\n');
  process.exitCode = 1;
} else {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.stdout.write(`Evidence captured for ${testReport.summary.total} tests and ${coverageReport.files.length} source files → ${outputPath}\n`);
}

async function findTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findTestFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(path);
  }
  return files;
}

async function run(command, args, cwd, env = process.env) {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-test-evidence-'));
  const stdoutPath = join(directory, 'stdout.txt');
  const stderrPath = join(directory, 'stderr.txt');
  const stdoutHandle = await open(stdoutPath, 'w');
  const stderrHandle = await open(stderrPath, 'w');
  let outcome;
  try {
    outcome = await new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd,
        env,
        stdio: ['ignore', stdoutHandle.fd, stderrHandle.fd]
      });
      child.once('error', reject);
      child.once('close', (code, signal) => resolvePromise({ code, signal }));
    });
  } finally {
    await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
  }
  const [stdout, stderr] = await Promise.all([
    readFile(stdoutPath, 'utf8'),
    readFile(stderrPath, 'utf8')
  ]);
  await rm(directory, { recursive: true, force: true });
  return { ...outcome, stdout, stderr };
}

function combineTestReports(reports, observedAt) {
  const results = reports.flatMap((report) => report.results);
  const count = (status) => results.filter((entry) => entry.status === status).length;
  return {
    format: 'tap',
    observedAt,
    summary: {
      total: results.length,
      passed: count('PASSED'),
      failed: count('FAILED'),
      skipped: count('SKIPPED'),
      todo: count('TODO'),
      durationMs: results.reduce((sum, entry) => sum + (Number(entry.durationMs) || 0), 0)
    },
    results
  };
}

function normalizePath(value) {
  return value.replaceAll('\\', '/');
}
