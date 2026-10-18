import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('probe source and bundled entrypoint expose the same fixed ping-only contract', async () => {
  const coverage = process.env.NODE_V8_COVERAGE;
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'apps/probe-stdio.ts'], stderr: 'pipe', ...(coverage ? { env: { NODE_V8_COVERAGE: coverage } } : {}) });
  const client = new Client({ name: 'source-probe-contract', version: '1' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['ping']);
    const result = await client.callTool({ name: 'ping', arguments: {} });
    assert.deepEqual(result.structuredContent, { pong: true, mode: 'compatibility-probe', desktop_access: false });
    const badArguments = await client.callTool({ name: 'ping', arguments: { unexpected: 'value' } });
    assert.equal(badArguments.isError, true);
    const badTool = await client.callTool({ name: 'blender_execute_code', arguments: {} });
    assert.equal(badTool.isError, true);
    assert.equal(stderr, '');
  } finally { await client.close(); }
});
