import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const artifactRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(artifactRoot, '../../public/brand/lifeline-3d');

await mkdir(destination, { recursive: true });
await cp(resolve(artifactRoot, 'dist'), destination, { recursive: true, force: true });
console.log(`Published Lifeline 3D brand asset to ${destination}`);
