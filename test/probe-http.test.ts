import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
test('standalone HTTP ping probe speaks Streamable HTTP without any desktop state', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/probe.ts', '--http'], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'ignore', 'pipe'] });
  const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const client = new Client({ name: 'probe-http-test', version: '1' });
  try {
    // PORT=0 needs the allocated port, so read the server's non-secret startup line.
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('probe startup timeout')), 5000);
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.stderr.on('data', chunk => {
        const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+\/mcp/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['ping']);
    const r = await client.callTool({ name: 'ping', arguments: {} });
    assert.equal((r.structuredContent as any)?.desktop_access, false);
    assert.equal((r.structuredContent as any)?.pong, true);
  } finally { await client.close(); child.kill('SIGTERM'); await exit; }
});
