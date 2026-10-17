import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
// Reintroducing an npm runtime dependency into .mcp.json breaks this behavior.
test('configured cloud probe starts in a fresh checkout before any npm install', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-probe-cold-'));
  const config = JSON.parse(await readFile('.mcp.json', 'utf8')).mcpServers['bridge-probe'];
  for (const path of ['apps', 'packages', 'probe', 'package.json']) {
    try { await access(path); } catch { continue; }
    await cp(path, join(dir, path), { recursive: true });
  }
  const transport = new StdioClientTransport({ command: config.command, args: config.args, cwd: dir, stderr: 'pipe' });
  const client = new Client({ name: 'cold-start-test', version: '1' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['ping']);
    const r = await client.callTool({ name: 'ping', arguments: {} });
    assert.equal((r.structuredContent as any)?.pong, true);
    assert.equal((r.structuredContent as any)?.desktop_access, false);
    assert.equal(stderr, '', 'stdout must be MCP only; successful startup needs no stderr');
  } catch (e) { throw new Error(`Cold checkout probe failed: ${stderr}`, { cause: e }); }
  finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});
