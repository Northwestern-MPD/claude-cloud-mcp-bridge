import { Bridge } from '../../packages/core.js';
import { startGateway } from './server.js';
if (process.env.NODE_ENV === 'production') throw new Error('Production auth is not implemented. Mock gateway cannot run in production.');
const b = new Bridge();
b.provision({ id: 'student-a', teams: ['team-a'] }); b.provision({ id: 'student-b', teams: ['team-b'] });
// Tokens are generated only for this local run and never printed or written to disk.
// Use dev:mock for the self-contained fixture demo. Standalone gateway is for SDK developers.
const g = await startGateway(b, Number(process.env.PORT ?? 3333));
console.log(`Mock gateway: ${g.url}; use npm run dev:mock for authenticated fixture clients.`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await g.close(); process.exit(0); });
