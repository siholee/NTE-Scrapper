import fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { dataRoot, projectRoot } from './paths.js';
import { sleep } from './source.js';

async function call(runtime, method, args, timeout = 45000) {
  const response = await fetch(`http://127.0.0.1:${runtime.port}/rpc`, {
    method: 'POST', headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(timeout),
  });
  const json = await response.json();
  if (!response.ok || json.error) { const error = new Error(json.error || `Worker HTTP ${response.status}`); error.workerResponse = true; throw error; }
  return json.result;
}
async function runtime() { return JSON.parse(await fs.readFile(path.join(dataRoot, 'runtime.json'), 'utf8')); }
let starting = null;
async function ensureWorker() {
  try { const info = await runtime(); await call(info, 'health', {}, 1200); return info; } catch {}
  await fs.mkdir(dataRoot, { recursive: true });
  const log = openSync(path.join(dataRoot, 'worker.log'), 'a');
  try {
    const child = spawn(process.execPath, [path.join(projectRoot, 'src', 'worker.js')], {
      cwd: projectRoot, detached: true, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}), NTE_DATA_DIR: dataRoot },
    });
    child.unref(); child.on('error', error => console.error('[NTE worker]', error.message));
  } finally { closeSync(log); }
  for (let attempt = 0; attempt < 80; attempt++) {
    await sleep(200);
    try { const info = await runtime(); await call(info, 'health', {}, 1200); return info; } catch {}
  }
  throw new Error(`NTE 작업 프로세스가 시작되지 않았습니다. ${path.join(dataRoot, 'worker.log')}를 확인해주세요.`);
}
export async function rpc(method, args = {}) {
  if (!starting) starting = ensureWorker().finally(() => { starting = null; });
  const info = await starting;
  // Do not replay writes after a lost response. Query status before deciding to retry.
  return call(info, method, args);
}
