import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compactDispatchBoard } from '../src/mcp-server.js';
import {
  LIFELINE_AGENTS_BEGIN,
  ensureLifelineMcpConfig,
  installCodexLifelineWorkflow
} from '../scripts/install-codex-lifeline-workflow.mjs';

test('installer preserves stable HTTP MCP config and writes one managed global workflow block', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-codex-workflow-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'config.toml');
  const agentsPath = join(directory, 'AGENTS.md');
  const config = '[model]\nname = "gpt-5.6"\n\n[mcp_servers.lifeline]\nurl = "http://127.0.0.1:31009/mcp"\n';
  await writeFile(configPath, config, 'utf8');
  await writeFile(agentsPath, '# Existing user rules\n\n- Preserve this text.\n', 'utf8');

  const first = await installCodexLifelineWorkflow({ configPath, agentsPath, serviceRoot: '/srv/lifeline' });
  const second = await installCodexLifelineWorkflow({ configPath, agentsPath, serviceRoot: '/srv/lifeline' });
  const finalConfig = await readFile(configPath, 'utf8');
  const finalAgents = await readFile(agentsPath, 'utf8');

  assert.equal(first.configMode, 'http');
  assert.equal(first.configChanged, false);
  assert.equal(first.agentsChanged, true);
  assert.equal(second.agentsChanged, false);
  assert.equal(finalConfig, config);
  assert.match(finalAgents, /# Existing user rules/);
  assert.equal(finalAgents.split(LIFELINE_AGENTS_BEGIN).length - 1, 1);
  assert.match(finalAgents, /lifeline_submit_completion/);
  assert.match(finalAgents, /nextPlan/);
});

test('installer makes a stdio MCP independent from the caller repository', () => {
  const before = '[mcp_servers.lifeline]\ncommand = "docker"\nargs = ["compose", "exec", "-T", "lifeline", "node", "src/mcp-server.js"]\n\n[mcp_servers.other]\nurl = "https://example.com/mcp"\n';
  const result = ensureLifelineMcpConfig(before, { serviceRoot: '/srv/lifeline' });
  assert.equal(result.mode, 'stdio-cwd');
  assert.equal(result.changed, true);
  assert.match(result.content, /\[mcp_servers\.lifeline\]\ncwd = "\/srv\/lifeline"\ncommand/);
  assert.match(result.content, /\[mcp_servers\.other\]\nurl = "https:\/\/example\.com\/mcp"/);
});

test('compact dispatch view bounds large portfolio payloads while retaining decisions', () => {
  const decisions = Array.from({ length: 120 }, (_, index) => decision(index));
  const board = {
    generatedAt: '2026-08-12T12:00:00.000Z',
    policy: { version: 'autonomous-board-v1' },
    summary: { projectCount: 10, nextCount: 5 },
    recommendations: { running: decisions[0], highCompute: decisions[1], lowCompute: decisions[2], review: null },
    projects: Array.from({ length: 10 }, (_, index) => ({
      id: `project-${index}`,
      name: `Project ${index}`,
      strategicValue: 10 - index,
      health: 'ON_TRACK',
      phases: Array.from({ length: 20 }, () => ({ title: 'Must not leak into compact output' })),
      dispatch: { NOW: 0, NEXT: 1 }
    })),
    lanes: { now: decisions.slice(0, 5), next: decisions.slice(5, 25), reserve: decisions.slice(25, 70), backlog: decisions.slice(70) },
    decisions,
    recentChanges: Array.from({ length: 20 }, (_, index) => ({ id: `change-${index}`, type: 'dispatch.decision_changed', createdAt: '2026-08-12T12:00:00.000Z' })),
    efficiency: {
      window: '30d', confidence: 'ENOUGH', sampleThreshold: 5,
      summary: { sampleCount: 100, throughput: 100 },
      groups: { projects: Array.from({ length: 100 }, () => ({ huge: true })) },
      calibrations: Array.from({ length: 20 }, () => ({})),
      routingCalibrations: Array.from({ length: 20 }, () => ({}))
    }
  };
  const compact = compactDispatchBoard(board);
  const serialized = JSON.stringify(compact);

  assert.equal(compact.lanes.reserve.length, 10);
  assert.equal(compact.lanes.backlog.length, 10);
  assert.equal(compact.laneCounts.backlog, 50);
  assert.equal(compact.recentChanges.length, 5);
  assert.equal(compact.projects[0].phases, undefined);
  assert.equal(compact.efficiency.groups, undefined);
  assert.ok(serialized.length < JSON.stringify(board).length / 3);
  assert.equal(compact.recommendations.highCompute.taskId, 'task-1');
});

function decision(index) {
  return {
    taskId: `task-${index}`,
    projectId: `project-${index % 10}`,
    phaseId: `phase-${index % 20}`,
    title: `Task ${index}`,
    status: 'PLANNED',
    effectiveStatus: 'PLANNED',
    mode: 'EXECUTION',
    batch: 'NEXT',
    rank: index + 1,
    compute: index % 2 ? 'high' : 'low',
    recommendedAgent: 'codex',
    recommendedModelRef: 'gpt-5.6-sol',
    estimateMinutes: 30,
    reasonCodes: ['PRIORITY_P0'],
    policyVersion: 'autonomous-board-v1'
  };
}
