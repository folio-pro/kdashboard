// Atomic file writes: write a sibling temp file, then rename over the target,
// so a crash mid-write never leaves a half-written file behind. Three
// handlers (pricing cache, OpenAPI cache, kubeconfig) used to carry their own.

import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

let counter = 0;

function tempPath(target: string): string {
  return `${target}.tmp-${process.pid}-${Date.now()}-${counter++}`;
}

export async function atomicWrite(target: string, contents: string, mode?: number): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = tempPath(target);
  try {
    await fsp.writeFile(tmp, contents, mode !== undefined ? { encoding: 'utf8', mode } : 'utf8');
    await fsp.rename(tmp, target);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export function atomicWriteSync(target: string, contents: string, mode?: number): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = tempPath(target);
  try {
    fs.writeFileSync(tmp, contents, mode !== undefined ? { encoding: 'utf8', mode } : 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
