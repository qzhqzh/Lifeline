import { spawn } from 'node:child_process';

const { options, command } = parseArguments(process.argv.slice(2));
if (!options.server || !options.project || !options.proposal || !options.stage || !options.sourceUri || command.length === 0) {
  throw new Error('Usage: run-scenario-workflow --server <url> --project <id> --proposal <id> --stage baseline|implementation --source-uri <uri> [--phase <id>] [--access-token <token>] -- <command> [args...]');
}

const startedAt = new Date().toISOString();
const result = await run(command[0], command.slice(1));
const observedAt = new Date().toISOString();
const response = await fetch(new URL(
  `/api/projects/${encodeURIComponent(options.project)}/test-scenario-proposals/${encodeURIComponent(options.proposal)}/runs`,
  options.server
), {
  method: 'POST',
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {})
  },
  body: JSON.stringify({
    stage: options.stage.toUpperCase(),
    outcome: result.code === 0 ? 'PASSED' : 'FAILED',
    command,
    observedFailure: result.code === 0 ? null : boundedOutput(`${result.stderr}\n${result.stdout}`),
    sourceUri: options.sourceUri,
    phaseId: options.phase ?? null,
    commitSha: options.commitSha ?? null,
    observedAt,
    startedAt
  })
});
const body = await response.json().catch(() => null);
if (!response.ok) {
  throw new Error(body?.error?.message ?? `Lifeline rejected scenario evidence (${response.status})`);
}
process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
process.exitCode = result.code === 0 ? 0 : body?.proposal?.status === 'IMPLEMENTING' ? 0 : result.code || 1;

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout = boundedOutput(stdout + chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = boundedOutput(stderr + chunk);
      process.stderr.write(chunk);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code: code ?? 1, signal, stdout, stderr }));
  });
}

function parseArguments(values) {
  const separator = values.indexOf('--');
  const optionValues = separator >= 0 ? values.slice(0, separator) : values;
  const command = separator >= 0 ? values.slice(separator + 1) : [];
  const options = {};
  const names = {
    '--server': 'server',
    '--project': 'project',
    '--proposal': 'proposal',
    '--stage': 'stage',
    '--source-uri': 'sourceUri',
    '--phase': 'phase',
    '--access-token': 'accessToken',
    '--commit-sha': 'commitSha'
  };
  for (let index = 0; index < optionValues.length; index += 2) {
    const name = names[optionValues[index]];
    const value = optionValues[index + 1];
    if (!name || !value) throw new Error(`Unknown or incomplete argument: ${optionValues[index]}`);
    options[name] = value;
  }
  return { options, command };
}

function boundedOutput(value) {
  return String(value ?? '').slice(-8000);
}
