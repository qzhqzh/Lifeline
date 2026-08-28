import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const LIFELINE_AGENTS_BEGIN = '<!-- lifeline:begin -->';
export const LIFELINE_AGENTS_END = '<!-- lifeline:end -->';

export const LIFELINE_GLOBAL_AGENTS_BLOCK = `${LIFELINE_AGENTS_BEGIN}
## Lifeline portfolio reporting

- For non-trivial implementation work in a repository represented by a Lifeline project, call \`lifeline_list_projects\` and then \`lifeline_get_schedule\` before editing. Read schedules in pages instead of requesting an unnecessarily large payload.
- If the request contains more than one independently verifiable functional result or materially changes the schedule, sync exactly \`Project → Phase → Task\` with a stable \`planId\` before implementation. Reuse matching tasks; never create duplicates or filler work.
- For autonomous execution, \`lifeline_claim_next_task\` is the only start handshake. Do not send heartbeats, internal thoughts, or synthetic step events.
- Report a tracked task once at the end through \`lifeline_submit_completion\` with its real result, model, start/end time, and useful evidence. A completed result enters REVIEW; verify it only with deterministic evidence, an independent reviewer, or explicit owner approval.
- When concrete repository evidence supports another iteration and the completed task leaves no actionable work, include \`nextPlan\` in the same completion report. If there is no defensible next task, leave the queue empty instead of inventing work.
- Prefer overdue independent reviews before new execution when the reviewer is not the original submitter. Pass \`source.repositoryPath\` and \`source.repositoryUrl\` whenever the Lifeline tool accepts \`source\`.
- Do not create Lifeline records for read-only questions, exploratory diagnostics, or one-step incidental edits unless the user asks to track them.
${LIFELINE_AGENTS_END}`;

export async function installCodexLifelineWorkflow(options = {}) {
  const configPath = resolve(options.configPath ?? `${homedir()}/.codex/config.toml`);
  const agentsPath = resolve(options.agentsPath ?? `${homedir()}/.codex/AGENTS.md`);
  const serviceRoot = resolve(options.serviceRoot ?? ROOT);
  const dryRun = options.dryRun === true;
  const configBefore = await readOptionalFile(configPath);
  const agentsBefore = await readOptionalFile(agentsPath);
  const configResult = ensureLifelineMcpConfig(configBefore, { serviceRoot });
  const agentsAfter = upsertManagedBlock(
    agentsBefore,
    LIFELINE_AGENTS_BEGIN,
    LIFELINE_AGENTS_END,
    LIFELINE_GLOBAL_AGENTS_BLOCK
  );

  if (!dryRun) {
    if (configResult.changed) await writeAtomic(configPath, configResult.content);
    if (agentsAfter !== agentsBefore) await writeAtomic(agentsPath, agentsAfter);
    validateToml(configPath);
  }
  return {
    configPath,
    agentsPath,
    serviceRoot,
    configMode: configResult.mode,
    configChanged: configResult.changed,
    agentsChanged: agentsAfter !== agentsBefore,
    dryRun
  };
}

export function ensureLifelineMcpConfig(content, { serviceRoot }) {
  const normalized = String(content ?? '');
  const table = findTomlTable(normalized, 'mcp_servers.lifeline');
  if (!table) {
    const separator = normalized.trim() ? '\n\n' : '';
    const block = [
      '[mcp_servers.lifeline]',
      'command = "docker"',
      'args = ["compose", "exec", "-T", "-e", "LIFELINE_LOCAL_USER_ID=local-owner", "-e", "LIFELINE_MCP_CLIENT_NAME=codex", "lifeline", "node", "src/mcp-server.js"]',
      `cwd = "${escapeTomlString(serviceRoot)}"`
    ].join('\n');
    return { content: `${normalized.trimEnd()}${separator}${block}\n`, changed: true, mode: 'stdio-cwd' };
  }

  const body = normalized.slice(table.start, table.end);
  if (/^\s*url\s*=\s*"https?:\/\//m.test(body)) {
    return { content: normalized, changed: false, mode: 'http' };
  }
  if (/^\s*cwd\s*=/m.test(body)) {
    return { content: normalized, changed: false, mode: 'stdio-cwd' };
  }
  if (!/^\s*command\s*=/m.test(body)) {
    throw new Error('[mcp_servers.lifeline] must define either url or command');
  }
  const insertion = `cwd = "${escapeTomlString(serviceRoot)}"\n`;
  const updatedBody = body.replace(/^\[mcp_servers\.lifeline\]\s*\n/m, (header) => `${header}${insertion}`);
  return {
    content: `${normalized.slice(0, table.start)}${updatedBody}${normalized.slice(table.end)}`,
    changed: updatedBody !== body,
    mode: 'stdio-cwd'
  };
}

export function upsertManagedBlock(content, begin, end, block) {
  const normalized = String(content ?? '');
  const beginIndex = normalized.indexOf(begin);
  const endIndex = normalized.indexOf(end);
  if ((beginIndex === -1) !== (endIndex === -1) || (beginIndex !== -1 && endIndex < beginIndex)) {
    throw new Error(`Managed block markers are incomplete: ${begin}`);
  }
  if (beginIndex !== -1) {
    const afterEnd = endIndex + end.length;
    return `${normalized.slice(0, beginIndex)}${block}${normalized.slice(afterEnd)}`;
  }
  const separator = normalized.trim() ? '\n\n' : '';
  return `${normalized.trimEnd()}${separator}${block}\n`;
}

function findTomlTable(content, tableName) {
  const header = `[${tableName}]`;
  const start = content.split('\n').reduce((offset, line) => (
    offset >= 0 ? offset : line.trim() === header ? content.indexOf(line) : -1
  ), -1);
  if (start < 0) return null;
  const afterHeader = content.indexOf('\n', start);
  if (afterHeader < 0) return { start, end: content.length };
  const nextHeader = content.slice(afterHeader + 1).search(/^\s*\[/m);
  return {
    start,
    end: nextHeader < 0 ? content.length : afterHeader + 1 + nextHeader
  };
}

async function readOptionalFile(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

async function writeAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const existingMode = await stat(path).then((entry) => entry.mode).catch(() => 0o600);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, content, 'utf8');
  await chmod(temporaryPath, existingMode & 0o777);
  await rename(temporaryPath, path);
}

function validateToml(path) {
  const result = spawnSync('python3', [
    '-c',
    'import sys,tomllib; tomllib.load(open(sys.argv[1], "rb"))',
    path
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Codex config TOML validation failed: ${result.stderr.trim() || 'unknown error'}`);
  }
}

function escapeTomlString(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      agents: { type: 'string' },
      'service-root': { type: 'string' },
      'dry-run': { type: 'boolean', default: false }
    }
  });
  installCodexLifelineWorkflow({
    configPath: values.config,
    agentsPath: values.agents,
    serviceRoot: values['service-root'],
    dryRun: values['dry-run']
  }).then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
