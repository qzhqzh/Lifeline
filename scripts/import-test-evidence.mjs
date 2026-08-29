import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';

import {
  createTestEvidence,
  parseCoverageReport,
  parseMutationReport,
  parseQualityEvidence,
  parseTestReport
} from '../src/test-evidence.js';

const options = parseArguments(process.argv.slice(2));
if (!options.testReport || !options.output) {
  throw new Error('Usage: import-test-evidence --test-report <file> --output <file> [--test-format tap|junit] [--coverage-report <file>] [--coverage-format lcov|cobertura|jacoco|node] [--mutation-report <stryker.json>] [--quality-report <kind:file>] [--catalog <file>]');
}

const generatedAt = new Date().toISOString();
const testReportPath = resolve(options.testReport);
const testReport = parseTestReport(await readFile(testReportPath, 'utf8'), {
  format: options.testFormat ?? inferTestFormat(testReportPath),
  observedAt: generatedAt
});
const coverageReport = options.coverageReport
  ? parseCoverageReport(await readFile(resolve(options.coverageReport), 'utf8'), {
      format: options.coverageFormat ?? inferCoverageFormat(options.coverageReport),
      observedAt: generatedAt
    })
  : null;
const catalog = options.catalog ? JSON.parse(await readFile(resolve(options.catalog), 'utf8')) : null;
const mutationReport = options.mutationReport
  ? parseMutationReport(await readFile(resolve(options.mutationReport), 'utf8'), {
      format: options.mutationFormat ?? 'stryker',
      observedAt: generatedAt
    })
  : null;
const qualityEvidence = await Promise.all((options.qualityReports ?? []).map(async ({ kind, path }) => (
  parseQualityEvidence(await readFile(resolve(path), 'utf8'), { kind, observedAt: generatedAt })
)));
const outputPath = resolve(options.output);
const evidence = createTestEvidence({
  generatedAt,
  command: options.command ?? null,
  declarationCount: catalog?.summary?.testCount ?? null,
  runnerEntryCount: testReport.summary.total,
  testReport,
  coverageReport,
  mutationReport,
  qualityEvidence
});

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log(`Imported ${testReport.summary.total} test results${coverageReport ? `, ${coverageReport.files.length} coverage files` : ''}${mutationReport ? `, ${mutationReport.summary.total} mutants` : ''}${qualityEvidence.length ? `, ${qualityEvidence.length} quality reports` : ''} → ${outputPath}`);

function parseArguments(values) {
  const result = { qualityReports: [] };
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === '--quality-report') {
      const raw = values[index + 1];
      const separator = raw?.indexOf(':') ?? -1;
      if (separator <= 0 || separator === raw.length - 1) {
        throw new Error('--quality-report must use <kind:file>');
      }
      result.qualityReports.push({ kind: raw.slice(0, separator), path: raw.slice(separator + 1) });
      index += 1;
      continue;
    }
    const key = {
      '--test-report': 'testReport',
      '--test-format': 'testFormat',
      '--coverage-report': 'coverageReport',
      '--coverage-format': 'coverageFormat',
      '--mutation-report': 'mutationReport',
      '--mutation-format': 'mutationFormat',
      '--catalog': 'catalog',
      '--output': 'output',
      '--command': 'command'
    }[values[index]];
    if (!key || !values[index + 1]) throw new Error(`Unknown or incomplete argument: ${values[index]}`);
    result[key] = values[index + 1];
    index += 1;
  }
  return result;
}

function inferTestFormat(path) {
  return extname(path).toLowerCase() === '.xml' ? 'junit' : 'tap';
}

function inferCoverageFormat(path) {
  const name = String(path).toLowerCase();
  if (name.endsWith('.info') || name.endsWith('.lcov')) return 'lcov';
  if (name.includes('jacoco')) return 'jacoco';
  return 'cobertura';
}
