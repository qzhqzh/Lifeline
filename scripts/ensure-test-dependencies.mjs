import { spawnSync } from 'node:child_process';

const requiredPackages = [
  '@modelcontextprotocol/client',
  '@modelcontextprotocol/server',
  'zod'
];

const missing = requiredPackages.some((packageName) => {
  try {
    import.meta.resolve(packageName);
    return false;
  } catch {
    return true;
  }
});

if (missing) {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCommand, ['ci', '--ignore-scripts'], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
