import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { projectRoot } from '../src/paths.js';

test('MCP initializes and lists nine tools from an unrelated working directory', async () => {
  const client = new Client({ name: 'protocol-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(projectRoot, 'src', 'server.js')], cwd: path.dirname(projectRoot), stderr: 'pipe' });
  let errors = ''; transport.stderr.on('data', bytes => { errors += bytes.toString(); });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    assert.equal(result.tools.length, 9);
    assert.ok(result.tools.some(tool => tool.name === 'nte_start' && tool.inputSchema.properties.url));
    assert.ok(result.tools.some(tool => tool.name === 'nte_diagnose'));
    assert.equal(errors, '');
  } finally { await client.close(); }
});
