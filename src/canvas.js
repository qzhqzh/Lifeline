import { createHmac } from 'node:crypto';

export const DEFAULT_CANVAS_BASE_PATH = '/whiteboard';
export const DEFAULT_CANVAS_SESSION_TTL_SECONDS = 8 * 60 * 60;

export class CanvasConfigurationError extends Error {
  constructor(message, code = 'CANVAS_NOT_CONFIGURED') {
    super(message);
    this.code = code;
  }
}

export function canvasBoardId(projectId) {
  const value = String(projectId ?? '').trim();
  if (!/^project_[a-zA-Z0-9-]{8,120}$/.test(value)) {
    throw new CanvasConfigurationError('Project id cannot be mapped to a canvas board', 'INVALID_CANVAS_PROJECT');
  }
  return `lf-${value.slice('project_'.length).toLowerCase()}`;
}

export function createWboCanvasSession({
  projectId,
  secret,
  now = new Date(),
  ttlSeconds = DEFAULT_CANVAS_SESSION_TTL_SECONDS,
  publicBasePath = DEFAULT_CANVAS_BASE_PATH
}) {
  const signingSecret = String(secret ?? '').trim();
  if (signingSecret.length < 32) {
    throw new CanvasConfigurationError('Collaborative canvas signing is not configured');
  }
  const issuedAt = Math.floor(new Date(now).getTime() / 1000);
  if (!Number.isFinite(issuedAt)) {
    throw new CanvasConfigurationError('Canvas session time is invalid', 'INVALID_CANVAS_SESSION');
  }
  const lifetime = clampSessionTtl(ttlSeconds);
  const expiresAt = issuedAt + lifetime;
  const boardId = canvasBoardId(projectId);
  const token = signJwt({
    sub: `lifeline:${projectId}`,
    iat: issuedAt,
    exp: expiresAt,
    roles: [`editor:${boardId}`]
  }, signingSecret);
  const basePath = normalizeCanvasBasePath(publicBasePath);
  const query = new URLSearchParams({ lang: 'zh-CN', token });

  return {
    provider: 'wbo',
    boardId,
    iframeUrl: `${basePath}/boards/${encodeURIComponent(boardId)}?${query}`,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    permissions: {
      canOpen: true,
      canEdit: true,
      canClear: false
    },
    accessModel: 'project-link'
  };
}

export function buildWboProxyUrl(requestUrl, upstreamUrl, publicBasePath = DEFAULT_CANVAS_BASE_PATH) {
  const source = requestUrl instanceof URL ? requestUrl : new URL(String(requestUrl), 'http://localhost');
  const basePath = normalizeCanvasBasePath(publicBasePath);
  if (source.pathname !== basePath && !source.pathname.startsWith(`${basePath}/`)) return null;

  let target;
  try {
    target = new URL(String(upstreamUrl));
  } catch {
    throw new CanvasConfigurationError('Collaborative canvas upstream URL is invalid');
  }
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new CanvasConfigurationError('Collaborative canvas upstream must use HTTP or HTTPS');
  }

  const upstreamPrefix = target.pathname === '/' ? '' : target.pathname.replace(/\/$/, '');
  const suffix = source.pathname.slice(basePath.length) || '/';
  target.pathname = `${upstreamPrefix}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
  target.search = source.search;
  target.hash = '';
  return target;
}

export function normalizeCanvasBasePath(value) {
  const path = String(value ?? DEFAULT_CANVAS_BASE_PATH).trim();
  if (!/^\/[a-zA-Z0-9/_-]*$/.test(path)) {
    throw new CanvasConfigurationError('Collaborative canvas base path is invalid');
  }
  return path.length > 1 ? path.replace(/\/$/, '') : path;
}

function clampSessionTtl(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return DEFAULT_CANVAS_SESSION_TTL_SECONDS;
  return Math.min(12 * 60 * 60, Math.max(5 * 60, Math.round(seconds)));
}

function signJwt(payload, secret) {
  const header = encodeJwtPart({ alg: 'HS256', typ: 'JWT' });
  const body = encodeJwtPart(payload);
  const unsigned = `${header}.${body}`;
  const signature = createHmac('sha256', secret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

function encodeJwtPart(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
