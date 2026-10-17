import { createInterface } from 'node:readline/promises';
import { connectDevice, FakeBlender } from './connector.js';
if (process.env.NODE_ENV === 'production') throw new Error('Mock connector is not a production sign-in flow.');
const url = process.env.BRIDGE_URL, token = process.env.BRIDGE_LOCAL_USER_TOKEN, owner = process.env.BRIDGE_LOCAL_USER_ID;
if (!url || !token || !owner) throw new Error('Set BRIDGE_URL, BRIDGE_LOCAL_USER_TOKEN and BRIDGE_LOCAL_USER_ID from a local development harness. Never set shared environment desktop credentials.');
if (new URL(url).hostname !== '127.0.0.1' || new URL(url).protocol !== 'http:') throw new Error('Mock only accepts loopback HTTP.');
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (text: string) => process.stdin.isTTY && (await rl.question(text)).trim() === 'yes';
if (!await ask('Enable mock Blender on this device for this run? Type yes: ')) process.exit(0);
const response = await fetch(`${url}/devices`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'My mock Blender' }) });
if (!response.ok) throw new Error(`Enrollment failed: ${response.status}`);
const device = await response.json() as { id: string; credential: string };
const connector = await connectDevice({ url: url.replace('http:', 'ws:') + '/agent', credential: device.credential, deviceId: device.id, owner,
  adapter: new FakeBlender(),
  approvePairing: async p => {
    const read = p.capabilities.filter(c => c === 'read');
    if (!await ask(`Request from ${JSON.stringify(p.context.user)}, team ${JSON.stringify(p.team)}, code ${JSON.stringify(p.code)}, expires ${new Date(p.expires).toISOString()}. Approve read access? Type yes: `)) return false;
    if (p.capabilities.includes('execute') && await ask('Arbitrary Python grants laptop code execution. Enable execute capability? Each request needs another approval. Type yes: ')) return [...read, 'execute'];
    return read.length ? read : false;
  },
  approveCode: async code => ask(`Review code (JSON escaped): ${JSON.stringify(code)}\nApprove this exact execution? Type yes: `),
});
console.log('Connected. Press Ctrl+C to disconnect. No automatic reconnection.');
process.once('SIGINT', () => { connector.disconnect(); rl.close(); });
