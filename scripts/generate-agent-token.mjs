import { randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_SCOPES } from '../src/agent-auth.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const envFile = resolve(root, '.env');
const rotate = process.argv.includes('--rotate');
const tokenCollectionKey = 'LIFELINE_AGENT_TOKENS';
const defaultScopes = AGENT_SCOPES.join(',');
const allowedScopes = new Set(AGENT_SCOPES);
const clientId = argumentValue('--client-id') ?? 'lifeline-lan-agent';
const scopeArgument = argumentValue('--scopes');
const requestedScopes = [...new Set((scopeArgument ?? defaultScopes).split(',').map((scope) => scope.trim()).filter(Boolean))];
if (!/^[a-zA-Z0-9._-]{1,160}$/.test(clientId)) throw new Error('clientId may contain only letters, numbers, dot, underscore, and dash');
const unknownScopes = requestedScopes.filter((scope) => !allowedScopes.has(scope));
if (unknownScopes.length > 0) throw new Error(`Unknown Lifeline Agent scope: ${unknownScopes.join(', ')}`);
let source = '';
try {
  source = await readFile(envFile, 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const sourceLines = source.split(/\r?\n/);
const tokenLineIndexes = sourceLines.flatMap((line, index) => (
  line.startsWith(`${tokenCollectionKey}=`) ? [index] : []
));
if (tokenLineIndexes.length > 1) throw new Error(`${tokenCollectionKey} must appear at most once in ${envFile}`);

let tokens = [];
const currentTokenJson = tokenLineIndexes.length === 1
  ? sourceLines[tokenLineIndexes[0]].slice(tokenCollectionKey.length + 1)
  : '';
if (currentTokenJson) {
  tokens = JSON.parse(currentTokenJson);
  if (!Array.isArray(tokens)) throw new Error(`${tokenCollectionKey} must be a JSON array`);
  for (const [index, entry] of tokens.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Agent token record ${index} must be an object`);
    if (typeof entry.clientId !== 'string' || !/^[a-zA-Z0-9._-]{1,160}$/.test(entry.clientId)) throw new Error(`Agent token record ${index} has an invalid clientId`);
    if (typeof entry.token !== 'string' || entry.token.length < 32) throw new Error(`Agent token record ${index} must contain at least 32 characters`);
    if (!Array.isArray(entry.scopes) || entry.scopes.some((scope) => !allowedScopes.has(scope))) throw new Error(`Agent token record ${index} has invalid scopes`);
  }
  if (new Set(tokens.map((entry) => entry.clientId)).size !== tokens.length) throw new Error(`${tokenCollectionKey} clientId values must be unique`);
  if (new Set(tokens.map((entry) => entry.token)).size !== tokens.length) throw new Error(`${tokenCollectionKey} token values must be unique`);
}
const existingIndex = tokens.findIndex((entry) => entry.clientId === clientId);
if (existingIndex >= 0 && !rotate) {
  console.log(`Agent token ${clientId} already exists in ${envFile}; pass --rotate to replace it.`);
  process.exit(0);
}

const effectiveScopes = existingIndex >= 0 && rotate && scopeArgument === null
  ? tokens[existingIndex].scopes
  : requestedScopes;
const record = { clientId, token: randomBytes(32).toString('hex'), scopes: effectiveScopes };
if (existingIndex >= 0) tokens[existingIndex] = record;
else tokens.push(record);
const nextTokenLine = `${tokenCollectionKey}=${JSON.stringify(tokens)}`;
let nextSource;
if (tokenLineIndexes.length === 1) {
  sourceLines[tokenLineIndexes[0]] = nextTokenLine;
  nextSource = `${sourceLines.join('\n').replace(/\n+$/u, '')}\n`;
} else {
  const prefix = source.length === 0 ? '' : `${source.replace(/\n+$/u, '')}\n`;
  nextSource = `${prefix}${nextTokenLine}\n`;
}
await writeFile(envFile, nextSource, { mode: 0o600 });
await chmod(envFile, 0o600);
console.log(`Agent token ${clientId} ${rotate ? 'rotated' : 'created'} in ${envFile} with mode 0600. The token value was not printed.`);

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}
