import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_SCOPES,
  agentTokenConfig,
  authenticateAgentRequest,
  validateAgentHttpBoundary
} from '../src/agent-auth.js';

const ENV = {
  LIFELINE_AGENT_TOKEN: 'test-token-with-enough-entropy-for-fixture',
  LIFELINE_AGENT_CLIENT_ID: 'agent-fixture',
  LIFELINE_AGENT_SCOPES: 'portfolio:read,task:claim'
};

test('Agent bearer token authenticates with an explicit scope set', () => {
  const result = authenticateAgentRequest({
    authorization: `Bearer ${ENV.LIFELINE_AGENT_TOKEN}`
  }, ENV);
  assert.equal(result.ok, true);
  assert.equal(result.authInfo.clientId, 'agent-fixture');
  assert.deepEqual(result.authInfo.scopes, ['portfolio:read', 'task:claim']);
});

test('missing configuration, wrong tokens, and unknown scopes fail closed', () => {
  assert.deepEqual(authenticateAgentRequest({}, {}), {
    ok: false, status: 503, code: 'MCP_TOKEN_NOT_CONFIGURED'
  });
  assert.equal(authenticateAgentRequest({ authorization: 'Bearer wrong' }, ENV).status, 401);
  assert.throws(() => agentTokenConfig({
    LIFELINE_AGENT_TOKEN: 'c'.repeat(64),
    LIFELINE_AGENT_SCOPES: 'portfolio:read,database:drop'
  }), /Unknown Lifeline Agent scope/);
  assert.equal(agentTokenConfig({ LIFELINE_AGENT_TOKEN: 'c'.repeat(64) }).scopes.length, AGENT_SCOPES.length);
});

test('multiple Agent tokens keep execution and review identities separate', () => {
  const env = {
    LIFELINE_AGENT_TOKENS: JSON.stringify([
      { clientId: 'executor-a', token: 'a'.repeat(64), scopes: ['portfolio:read', 'task:claim', 'completion:write'] },
      { clientId: 'reviewer-b', token: 'b'.repeat(64), scopes: ['portfolio:read', 'task:claim', 'verification:write'] }
    ])
  };
  const executor = authenticateAgentRequest({ authorization: `Bearer ${'a'.repeat(64)}` }, env);
  const reviewer = authenticateAgentRequest({ authorization: `Bearer ${'b'.repeat(64)}` }, env);
  assert.equal(executor.authInfo.clientId, 'executor-a');
  assert.equal(reviewer.authInfo.clientId, 'reviewer-b');
  assert.notDeepEqual(executor.authInfo.scopes, reviewer.authInfo.scopes);
});

test('multiple Agent token configuration rejects duplicate identities and secrets', () => {
  assert.throws(() => agentTokenConfig({
    LIFELINE_AGENT_TOKENS: JSON.stringify([
      { clientId: 'duplicate', token: 'a'.repeat(64), scopes: ['portfolio:read'] },
      { clientId: 'duplicate', token: 'b'.repeat(64), scopes: ['portfolio:read'] }
    ])
  }), /clientId values must be unique/);
  assert.throws(() => agentTokenConfig({
    LIFELINE_AGENT_TOKENS: JSON.stringify([
      { clientId: 'executor', token: 'a'.repeat(64), scopes: ['portfolio:read'] },
      { clientId: 'reviewer', token: 'a'.repeat(64), scopes: ['portfolio:read'] }
    ])
  }), /token values must be unique/);
});

test('Streamable HTTP boundary accepts loopback and private LAN hosts only', () => {
  assert.equal(validateAgentHttpBoundary({ host: '127.0.0.1:8019' }).ok, true);
  assert.equal(validateAgentHttpBoundary({ host: '192.168.124.2:8019', origin: 'http://192.168.124.8:3000' }).ok, true);
  assert.equal(validateAgentHttpBoundary({
    host: '192.168.124.2:8019',
    remoteAddress: '::ffff:192.168.124.8'
  }).ok, true);
  assert.equal(validateAgentHttpBoundary({
    host: '192.168.124.2:8019',
    remoteAddress: '203.0.113.10'
  }).code, 'MCP_REMOTE_ADDRESS_REJECTED');
  assert.equal(validateAgentHttpBoundary({ host: 'example.com:8019' }).code, 'MCP_HOST_REJECTED');
  assert.equal(validateAgentHttpBoundary({
    host: '192.168.124.2:8019', origin: 'https://example.com'
  }).code, 'MCP_ORIGIN_REJECTED');
  assert.equal(validateAgentHttpBoundary({
    host: '192.168.124.2:8019', origin: 'https://agent.example.com'
  }, ['https://agent.example.com']).ok, true);
});
