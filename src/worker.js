import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Engine } from './engine.js';
import { atomicWrite } from './storage.js';
import { dataRoot, projectRoot } from './paths.js';
import { isSameWorker } from './process-lock.js';

await fs.mkdir(dataRoot, { recursive: true });
const lockPath = path.join(dataRoot, 'worker.lock');
let lock;
try { lock = await fs.open(lockPath, 'wx'); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  let pid;
  try { pid = Number(await fs.readFile(lockPath, 'utf8')); } catch {}
  let alive = false;
  if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; } }
  if (alive && await isSameWorker(pid, path.join(projectRoot, 'src', 'worker.js'))) process.exit(0);
  // An empty lock may belong to another process that is still starting.
  const stat = await fs.stat(lockPath);
  if (!pid && Date.now() - stat.mtimeMs < 15000) process.exit(0);
  await fs.rm(lockPath, { force: true });
  try { lock = await fs.open(lockPath, 'wx'); } catch { process.exit(0); }
}
await lock.writeFile(String(process.pid)); await lock.close();
const engine = new Engine(dataRoot); await engine.init();
const token = randomBytes(32).toString('hex');
const server = http.createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  const authorization = Buffer.from(request.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  if (request.headers.origin || authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
    response.writeHead(403); response.end(JSON.stringify({ error: 'Forbidden' })); return;
  }
  if (request.method !== 'POST' || request.url !== '/rpc') { response.writeHead(404); response.end('{}'); return; }
  try {
    let body = '';
    for await (const chunk of request) { body += chunk; if (body.length > 100000) throw new Error('요청이 너무 큽니다.'); }
    const { method, args } = JSON.parse(body);
    const result = await engine.dispatch(method, args);
    response.end(JSON.stringify({ result }));
  } catch (error) { response.writeHead(400); response.end(JSON.stringify({ error: error.message })); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
await atomicWrite(path.join(dataRoot, 'runtime.json'), JSON.stringify({ pid: process.pid, port: server.address().port, token }));
console.error(`NTE worker ready (pid ${process.pid})`);
async function shutdown() {
  if (engine.active) await engine.cancel({ jobId: engine.active });
  await engine.reader.close();
  await fs.rm(lockPath, { force: true });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
