import { pathToFileURL } from 'node:url';
import { createJwksResolver, verifyAccessToken } from '../../packages/auth/index.js';
import { createIdentityRuntime } from '../../packages/authorization/runtime.js';
import { openAuthorizationStore } from '../../packages/storage/database.js';
import { executeAdmin } from '../operator/commands.js';
import { startAdminSocket } from '../operator/socket.js';
import { readIdentityConfig } from './config.js';
import { startIdentityServer } from './server.js';

export async function startIdentityApplication(env: NodeJS.ProcessEnv = process.env): Promise<{ close(): Promise<void> }> {
  const config = readIdentityConfig(env);
  const store = await openAuthorizationStore({ ...config.database, now: Date.now });
  const runtime = createIdentityRuntime(store);
  let server: Awaited<ReturnType<typeof startIdentityServer>> | undefined;
  let admin: Awaited<ReturnType<typeof startAdminSocket>> | undefined;
  let closing: Promise<void> | undefined;
  let unsubscribe = () => undefined as void;
  function close(): Promise<void> {
    if (!closing) closing = (async () => {
      unsubscribe();
      await admin?.close();
      await server?.close();
      runtime.close();
      await store.close();
    })();
    return closing;
  }
  try {
    const resolveKey = createJwksResolver(config.auth, { fetch, now: Date.now });
    server = await startIdentityServer({ config, store, runtime, verify: token => verifyAccessToken(token, config.auth, { resolveKey, now: Date.now }) });
    admin = await startAdminSocket(config.adminSocketPath, command => executeAdmin(command, { store, runtime, coordinator: runtime.coordinator, now: Date.now }));
    unsubscribe = store.onUnavailable(() => { process.exitCode = 1; void close(); });
    return { close };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startIdentityApplication().then(application => {
    const stop = () => { void application.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).catch(() => { console.error('IDENTITY_STARTUP_FAILED'); process.exitCode = 1; });
}
