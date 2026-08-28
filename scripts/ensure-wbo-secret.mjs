import { randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const envPath = resolve(process.argv[2] ?? '.env');
let contents = '';
try {
  contents = await readFile(envPath, 'utf8');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const keyPattern = /^(?:export\s+)?WBO_AUTH_SECRET_KEY=(.*)$/m;
const existing = keyPattern.exec(contents);
if (existing && normalizeExistingValue(existing[1]).length >= 32) {
  await chmod(envPath, 0o600);
  console.log('WBO_AUTH_SECRET_KEY is already configured in .env');
  process.exit(0);
}

const line = `WBO_AUTH_SECRET_KEY=${randomBytes(48).toString('base64url')}`;
const next = existing
  ? contents.replace(keyPattern, line)
  : `${contents.replace(/\s*$/, '')}${contents.trim() ? '\n' : ''}${line}\n`;
await writeFile(envPath, next, { encoding: 'utf8', mode: 0o600 });
await chmod(envPath, 0o600);
console.log('Created WBO_AUTH_SECRET_KEY in .env without exposing its value');

function normalizeExistingValue(value) {
  return String(value ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');
}
