import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('development startup uses isolated data and does not seed demo projects by default', async () => {
  const [compose, packageText] = await Promise.all([
    readFile(new URL('../compose.dev.yaml', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8')
  ]);
  const packageJson = JSON.parse(packageText);

  assert.match(compose, /volumes:\s*!override/);
  assert.match(compose, /lifeline-dev-data:\/app\/data/);
  assert.doesNotMatch(compose, /- lifeline-data:\/app\/data/);
  assert.match(compose, /LIFELINE_SEED_DEMO:\s*"0"/);
  assert.doesNotMatch(packageJson.scripts.dev, /LIFELINE_SEED_DEMO/);
  assert.match(packageJson.scripts['dev:demo'], /LIFELINE_SEED_DEMO=1/);
});
