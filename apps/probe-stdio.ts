/** Bundled into probe/stdio.cjs so native MCP startup never waits for npm. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({ name: 'bridge-compatibility-probe', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
  name: 'ping', description: 'Read-only bridge compatibility check. No desktop access.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false },
}] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  if (request.params.name !== 'ping' || Object.keys(request.params.arguments ?? {}).length) {
    return { content: [{ type: 'text', text: 'INVALID_INPUT' }], isError: true };
  }
  const value = { pong: true, mode: 'compatibility-probe', desktop_access: false };
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
});
// MCP protocol only on stdout. Do not dump incoming messages or environment on failure.
server.connect(new StdioServerTransport()).catch(() => {
  console.error('bridge-probe: stdio startup failed');
  process.exitCode = 1;
});
