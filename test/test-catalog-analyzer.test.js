import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  analyzeTestRepository,
  extractNodeTestDeclarations,
  extractPythonTestDeclarations
} from '../src/catalog-analyzer.js';
import { catalogFileName, getProjectTestMap } from '../src/project-test-map.js';

const execFileAsync = promisify(execFile);
const ROOT = resolve(new URL('..', import.meta.url).pathname);

test('generic adapters extract Node.js and Python tests with traceable evidence', () => {
  const node = extractNodeTestDeclarations(`
    import { describe, expect, it } from 'vitest';
    it('keeps the complete visible title', () => {
      const result = client.persistDraft();
      expect(result).toEqual({ ok: true });
    });
  `);
  const jest = extractNodeTestDeclarations(`
    import { expect, test } from '@jest/globals';
    test('uses the Jest adapter', () => expect(true).toBe(true));
  `);
  const guarded = extractNodeTestDeclarations([
    'const fixture = `',
    "test('not a real declaration', () => {});",
    '`;',
    "// test('also not real', () => {});",
    "test('real declaration', () => {});"
  ].join('\n'));
  const python = extractPythonTestDeclarations(`
import pytest

def test_rejects_expired_token(client):
    response = client.login('expired')
    assert response.status_code == 401

class SampleTests:
    async def test_saves_result(self):
        self.assertEqual(save_result(), True)
  `);

  assert.equal(node[0].framework, 'Vitest');
  assert.equal(node[0].title, 'keeps the complete visible title');
  assert.ok(node[0].calls.includes('client.persistDraft'));
  assert.ok(node[0].assertions.includes('expect.toEqual'));
  assert.equal(jest[0].framework, 'Jest');
  assert.deepEqual(guarded.map((entry) => entry.title), ['real declaration']);
  assert.equal(python[0].framework, 'pytest');
  assert.equal(python[0].title, 'test_rejects_expired_token');
  assert.ok(python[0].assertions.includes('assert'));
  assert.equal(python[1].title, 'SampleTests.test_saves_result');
  assert.equal(python[1].declaration, 'async def');
  assert.ok(python[1].assertions.includes('assertEqual'));
});

test('zero-config repository analysis clusters domains, adds scenarios, and reuses file fingerprints', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lifeline-catalog-v2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'tests'), { recursive: true });
  await mkdir(join(root, 'src', 'billing'), { recursive: true });
  const nodeFile = join(root, 'tests', 'billing.test.js');
  const pythonFile = join(root, 'tests', 'test_auth.py');
  const cachePath = join(root, '.cache', 'catalog.json');
  await writeFile(nodeFile, `
    import test from 'node:test';
    import assert from 'node:assert/strict';
    import { saveInvoice } from '../src/billing/invoices.js';
    test('persists an invoice atomically', () => {
      const result = saveInvoice();
      assert.equal(result.ok, true);
    });
  `);
  await writeFile(pythonFile, `
from app.auth import validate_token

def test_rejects_expired_token():
    assert validate_token('expired') is False
  `);

  const first = await analyzeTestRepository({ root, cachePath, generatedAt: '2026-08-28T00:00:00.000Z' });
  const second = await analyzeTestRepository({ root, cachePath, generatedAt: '2026-08-28T00:01:00.000Z' });
  assert.equal(first.summary.testCount, 2);
  assert.equal(first.summary.fileCount, 2);
  assert.equal(first.source.cache.missCount, 2);
  assert.equal(second.source.cache.hitCount, 2);
  assert.deepEqual(second.tests.map((entry) => entry.id), first.tests.map((entry) => entry.id));
  assert.ok(first.tests.every((entry) => entry.domainId && entry.scenarioIds.length > 0));
  assert.ok(first.tests.some((entry) => entry.sourceModules.includes('src/billing/invoices.js')));
  assert.ok(first.tests.some((entry) => entry.assertions.length > 0));
  assert.doesNotMatch(JSON.stringify(first), /confidence|modelRef|recommendation/i);
  const originalNodeId = first.tests.find((entry) => entry.title === 'persists an invoice atomically').id;

  await writeFile(pythonFile, `
from app.auth import validate_token

def test_rejects_expired_token():
    assert validate_token('expired') is False

def test_accepts_active_token():
    assert validate_token('active') is True
  `);
  const third = await analyzeTestRepository({ root, cachePath });
  assert.equal(third.source.cache.hitCount, 1);
  assert.equal(third.source.cache.missCount, 1);
  assert.equal(third.summary.testCount, 3);

  await writeFile(nodeFile, `
    import test from 'node:test';
    import assert from 'node:assert/strict';
    import { saveInvoice } from '../src/billing/invoices.js';
    test('rejects an empty invoice', () => assert.equal(saveInvoice(null).ok, false));
    test('persists an invoice atomically', () => {
      const result = saveInvoice();
      assert.equal(result.ok, true);
    });
  `);
  const fourth = await analyzeTestRepository({ root, cachePath });
  assert.equal(fourth.source.cache.hitCount, 1);
  assert.equal(fourth.source.cache.missCount, 1);
  assert.equal(
    fourth.tests.find((entry) => entry.title === 'persists an invoice atomically').id,
    originalNodeId
  );
});

test('CLI emits a versioned catalog and project maps accept submitted catalogs without repository allowlists', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lifeline-catalog-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(join(root, 'test', 'sample.test.js'), `
    import test from 'node:test';
    test('runs from the generic CLI', () => {});
  `);
  const outputPath = join(root, 'catalog.json');
  await execFileAsync(process.execPath, [
    join(ROOT, 'scripts/analyze-test-catalog.mjs'),
    '--root', root,
    '--output', outputPath,
    '--project-name', 'Fixture',
    '--repository-url', 'https://example.com/fixture',
    '--no-layouts'
  ]);
  const catalog = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(catalog.version, 2);
  assert.equal(catalog.summary.testCount, 1);
  assert.equal(catalog.project.name, 'Fixture');

  const appRoot = await mkdtemp(join(tmpdir(), 'lifeline-catalog-store-'));
  t.after(() => rm(appRoot, { recursive: true, force: true }));
  const project = { id: 'project/fixture', name: 'Fixture', repositoryUrl: 'https://example.com/fixture' };
  const catalogDirectory = join(appRoot, 'data', 'test-catalogs');
  await mkdir(catalogDirectory, { recursive: true });
  await writeFile(join(catalogDirectory, catalogFileName(project.id)), JSON.stringify(catalog));
  const served = await getProjectTestMap(project, appRoot);
  assert.equal(served.configured, true);
  assert.equal(served.project.id, project.id);
  assert.equal(served.tests[0].title, 'runs from the generic CLI');
});
