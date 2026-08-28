import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  CanvasConfigurationError,
  buildWboProxyUrl,
  canvasBoardId,
  createWboCanvasSession
} from '../src/canvas.js';

const SECRET = 'test-secret-that-is-at-least-thirty-two-characters-long';

test('canvas sessions are scoped to one project board and never grant clear capability', () => {
  const session = createWboCanvasSession({
    projectId: 'project_67357539-3a03-4c0c-89ee-2cb0d2412c38',
    secret: SECRET,
    now: new Date('2026-08-26T20:00:00Z'),
    ttlSeconds: 3600
  });
  const [headerPart, payloadPart, signature] = session.iframeUrl.match(/[?&]token=([^&]+)/)
    ? decodeURIComponent(new URL(session.iframeUrl, 'http://localhost').searchParams.get('token')).split('.')
    : [];
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  const expectedSignature = createHmac('sha256', SECRET)
    .update(`${headerPart}.${payloadPart}`)
    .digest('base64url');

  assert.equal(session.provider, 'wbo');
  assert.equal(session.boardId, 'lf-67357539-3a03-4c0c-89ee-2cb0d2412c38');
  assert.match(session.iframeUrl, /^\/whiteboard\/boards\/lf-/);
  assert.deepEqual(payload.roles, [`editor:${session.boardId}`]);
  assert.equal(payload.exp - payload.iat, 3600);
  assert.equal(signature, expectedSignature);
  assert.deepEqual(session.permissions, { canOpen: true, canEdit: true, canClear: false });
  assert.equal(session.accessModel, 'project-link');
});

test('canvas board ids are stable, opaque project identifiers and isolated by project', () => {
  assert.equal(
    canvasBoardId('project_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
    'lf-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  );
  assert.notEqual(
    canvasBoardId('project_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
    canvasBoardId('project_ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  );
});

test('canvas session creation fails closed when the signing secret is missing or weak', () => {
  for (const secret of ['', 'too-short']) {
    assert.throws(
      () => createWboCanvasSession({ projectId: 'project_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', secret }),
      (error) => error instanceof CanvasConfigurationError && error.code === 'CANVAS_NOT_CONFIGURED'
    );
  }
});

test('WBO proxy routing strips the public prefix and preserves socket query parameters', () => {
  const target = buildWboProxyUrl(
    new URL('http://lifeline.local/whiteboard/socket.io/?EIO=4&transport=websocket&token=secret'),
    'http://whiteboard:80'
  );
  assert.equal(target.href, 'http://whiteboard/socket.io/?EIO=4&transport=websocket&token=secret');
  assert.equal(buildWboProxyUrl(new URL('http://lifeline.local/client.html'), 'http://whiteboard:80'), null);
});

test('WBO proxy routing rejects non-http upstream schemes', () => {
  assert.throws(
    () => buildWboProxyUrl(new URL('http://lifeline.local/whiteboard/'), 'file:///tmp/wbo'),
    (error) => error instanceof CanvasConfigurationError && error.code === 'CANVAS_NOT_CONFIGURED'
  );
});

test('canvas deployment pins WBO, persists board history, and publishes its session contract', async () => {
  const [compose, documentation, openApiSource] = await Promise.all([
    readFile(new URL('../compose.yaml', import.meta.url), 'utf8'),
    readFile(new URL('../docs/COLLABORATIVE_CANVAS.md', import.meta.url), 'utf8'),
    readFile(new URL('../openapi.json', import.meta.url), 'utf8')
  ]);
  const openApi = JSON.parse(openApiSource);

  assert.match(compose, /lovasoa\/wbo:v2\.17\.0@sha256:6a8afba36eb1e12d5c583391aa4bf1dd9a0c6618776e1fbeb13a79b51dd65b75/);
  assert.match(compose, /AUTH_SECRET_KEY: "\$\{WBO_AUTH_SECRET_KEY:/);
  assert.match(compose, /lifeline-whiteboard-data:\/opt\/app\/server-data/);
  assert.match(compose, /require\('net'\)\.connect\(80,'127\.0\.0\.1'\)/);
  assert.match(documentation, /project-link/);
  assert.match(documentation, /lifeline-whiteboard-data.*lifeline-data/s);
  assert.equal(
    openApi.paths['/api/projects/{projectId}/canvas-session'].get.responses['200'].content['application/json'].schema.$ref,
    '#/components/schemas/CanvasSession'
  );
  assert.deepEqual(openApi.components.schemas.CanvasSession.properties.accessModel.enum, ['project-link']);
});
