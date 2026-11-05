import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../src/paths.js';

const all = process.argv.includes('--all');
const resumeIndex = process.argv.indexOf('--resume');
let client, transport;
async function connect() {
  client = new Client({ name: 'nte-live-verifier', version: '1.0.0' });
  transport = new StdioClientTransport({ command: process.execPath, args: [path.join(projectRoot, 'src', 'server.js')], cwd: projectRoot, env: { ...process.env }, stderr: 'pipe' });
  transport.stderr.on('data', data => process.stderr.write(data));
  await client.connect(transport);
}
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  if (result.isError) throw new Error(result.content[0].text);
  return result.structuredContent || JSON.parse(result.content[0].text);
}
try {
  await connect();
  const tools = await client.listTools();
  console.log('MCP handshake OK:', tools.tools.map(t => t.name).join(', '));
  console.log('health', JSON.stringify(await call('nte_health')));
  const job = resumeIndex >= 0
    ? await call('nte_continue', { jobId: process.argv[resumeIndex + 1] })
    : await call('nte_start', { url: 'https://toki35.com/novel/63829', ...(all ? {} : { end: 3 }) });
  console.log('START', JSON.stringify(job));
  await fs.mkdir(path.join(projectRoot, 'work'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'work', 'live-job.json'), JSON.stringify(job, null, 2));
  // The detached worker must survive closing the stdio MCP connection.
  await client.close(); await connect();
  console.log('MCP reconnect OK');
  let revision, lastLogged = -1;
  for (;;) {
    const state = await call('nte_status', { jobId: job.jobId, waitMs: 25000, ...(revision === undefined ? {} : { afterRevision: revision }) });
    revision = state.revision;
    await fs.writeFile(path.join(projectRoot, 'work', 'live-status.json'), JSON.stringify(state, null, 2));
    if (state.completed !== lastLogged || ['waiting', 'failed', 'completed', 'cancelled'].includes(state.status)) {
      console.log(new Date().toISOString(), state.status, `${state.completed}/${state.total}`, state.current?.number || '', state.error || ''); lastLogged = state.completed;
    }
    if (['failed', 'waiting', 'cancelled', 'interrupted'].includes(state.status)) { console.log('DIAGNOSE', JSON.stringify(await call('nte_diagnose', { jobId: job.jobId }))); process.exitCode = 1; break; }
    if (state.status === 'completed') {
      if (state.completed !== state.total || state.exports?.count !== state.total) throw new Error('Completion counts do not reconcile.');
      for (const file of [state.exports.txtPath, state.exports.epubPath]) console.log('OUTPUT', file, (await fs.stat(file)).size, 'bytes');
      break;
    }
  }
} finally { await client?.close(); }
