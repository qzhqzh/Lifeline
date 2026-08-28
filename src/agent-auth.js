import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const AGENT_SCOPES = Object.freeze([
  'portfolio:read',
  'schedule:write',
  'task:claim',
  'completion:write',
  'verification:write'
]);

export function agentTokenConfig(env = process.env) {
  const tokens = parseAgentTokenRecords(env);
  return {
    enabled: tokens.length > 0,
    tokens,
    token: tokens[0]?.token ?? '',
    scopes: tokens[0]?.scopes ?? [],
    clientId: tokens[0]?.clientId ?? 'lifeline-lan-agent',
    allowedOrigins: String(env.LIFELINE_MCP_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  };
}

export function authenticateAgentRequest(headers, env = process.env) {
  const config = agentTokenConfig(env);
  if (!config.enabled) return { ok: false, status: 503, code: 'MCP_TOKEN_NOT_CONFIGURED' };
  const authorization = String(headers.authorization ?? headers.Authorization ?? '');
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  const tokenRecord = match ? config.tokens.find((entry) => secureTextEqual(match[1], entry.token)) : null;
  if (!tokenRecord) {
    return { ok: false, status: 401, code: 'MCP_TOKEN_INVALID' };
  }
  return {
    ok: true,
    authInfo: {
      token: tokenRecord.token,
      clientId: tokenRecord.clientId,
      scopes: tokenRecord.scopes
    },
    allowedOrigins: config.allowedOrigins
  };
}

function parseAgentTokenRecords(env) {
  const encoded = String(env.LIFELINE_AGENT_TOKENS ?? '').trim();
  if (encoded) {
    let records;
    try {
      records = JSON.parse(encoded);
    } catch {
      throw new Error('LIFELINE_AGENT_TOKENS must be valid JSON');
    }
    if (!Array.isArray(records)) throw new Error('LIFELINE_AGENT_TOKENS must be a JSON array');
    const normalized = records.map((record, index) => normalizeTokenRecord(record, index));
    if (new Set(normalized.map((record) => record.clientId)).size !== normalized.length) {
      throw new Error('LIFELINE_AGENT_TOKENS clientId values must be unique');
    }
    if (new Set(normalized.map((record) => record.token)).size !== normalized.length) {
      throw new Error('LIFELINE_AGENT_TOKENS token values must be unique');
    }
    return normalized;
  }

  const token = String(env.LIFELINE_AGENT_TOKEN ?? '').trim();
  if (!token) return [];
  return [normalizeTokenRecord({
    token,
    clientId: String(env.LIFELINE_AGENT_CLIENT_ID ?? 'lifeline-lan-agent').trim() || 'lifeline-lan-agent',
    scopes: String(env.LIFELINE_AGENT_SCOPES ?? AGENT_SCOPES.join(',')).split(',')
  }, 0)];
}

function normalizeTokenRecord(record, index) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`Agent token record ${index} must be an object`);
  }
  const token = String(record.token ?? '').trim();
  const clientId = String(record.clientId ?? '').trim();
  const scopes = Array.isArray(record.scopes)
    ? record.scopes.map((scope) => String(scope).trim()).filter(Boolean)
    : [];
  if (token.length < 32) throw new Error(`Agent token record ${index} must contain at least 32 characters`);
  if (!clientId || clientId.length > 160) throw new Error(`Agent token record ${index} has an invalid clientId`);
  const unknownScopes = scopes.filter((scope) => !AGENT_SCOPES.includes(scope));
  if (unknownScopes.length > 0) throw new Error(`Unknown Lifeline Agent scope: ${unknownScopes.join(', ')}`);
  return { token, clientId, scopes: [...new Set(scopes)] };
}

export function validateAgentHttpBoundary({ host, origin, remoteAddress }, allowedOrigins = []) {
  const hostname = normalizeHostname(host);
  if (!isAllowedLanHostname(hostname)) {
    return { ok: false, status: 403, code: 'MCP_HOST_REJECTED' };
  }
  if (remoteAddress && !isAllowedLanHostname(normalizeRemoteAddress(remoteAddress))) {
    return { ok: false, status: 403, code: 'MCP_REMOTE_ADDRESS_REJECTED' };
  }
  if (origin && !originAllowed(origin, allowedOrigins)) {
    return { ok: false, status: 403, code: 'MCP_ORIGIN_REJECTED' };
  }
  return { ok: true };
}

function originAllowed(origin, configured) {
  if (configured.includes(origin)) return true;
  try {
    return isAllowedLanHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function normalizeHostname(host) {
  try {
    return new URL(`http://${String(host ?? '')}`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

function normalizeRemoteAddress(value) {
  const normalized = String(value ?? '').trim().replace(/^\[|\]$/g, '');
  return normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
}

function isAllowedLanHostname(hostname) {
  if (hostname === 'localhost') return true;
  const family = isIP(hostname);
  if (family === 4) {
    const [first, second] = hostname.split('.').map(Number);
    return first === 127
      || first === 10
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
  }
  if (family === 6) {
    const normalized = hostname.toLowerCase();
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
  }
  return false;
}

function secureTextEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
