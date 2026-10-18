import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { AuthError, authenticationChallenge, metadataPath, protectedResourceMetadata, requireScopes } from '../../packages/auth/index.js';
import type { VerifiedPrincipal, VerifiedRequestAuth } from '../../packages/auth/types.js';
import { createNativeObservations, type NativeObservations } from '../../packages/authorization/native-observations.js';
import { PolicyError } from '../../packages/authorization/errors.js';
import { authorizeIdentity } from '../../packages/authorization/identity.js';
import type { IdentityRuntime } from '../../packages/authorization/runtime.js';
import { assertTransportContext, recordTransportContext, revokeTransportContext, type ContextRef } from '../../packages/storage/contexts.js';
import type { Store } from '../../packages/storage/types.js';
import type { IdentityConfig } from './config.js';

const MAX_BYTES = 65_536;
const MAX_BEARER_BYTES = 16_384;
const SESSION_LIFETIME_MS = 3_600_000;
const requestEvidence = new AsyncLocalStorage<{ auth: VerifiedRequestAuth; deny(): void }>();
type Session = { context: ContextRef; issuer: string; subject: string; expiresAt: number; server: Server; transport: StreamableHTTPServerTransport; unregister: () => void };
class HttpError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }

export async function startIdentityServer(options: {
  config: IdentityConfig; store: Store; verify(token: string): Promise<VerifiedPrincipal>; runtime: IdentityRuntime; clock?: () => number;
}): Promise<{ url: string; observations: NativeObservations; close(): Promise<void> }> {
  const { config, store, runtime } = options;
  const clock = options.clock ?? Date.now;
  const observations = createNativeObservations(clock);
  // Validate existing durable authority even when maintenance intentionally denies readiness.
  await store.transaction(async tx => {
    const row = (await tx.query('SELECT store_id,boot_id,deployment_epoch,token_iat_after FROM mpd_identity.service_state WHERE singleton=true')).rows[0];
    if (!row || row.store_id !== config.database.expectedStoreId || row.boot_id !== store.bootId || row.deployment_epoch !== store.deploymentEpoch || Number(row.token_iat_after) !== store.tokenIatAfter) throw new Error('STORE_UNAVAILABLE');
  });
  const external = new URL(config.externalOrigin);
  const sessions = new Map<string, Session>();
  const ipLimits = new Map<string, { reset: number; count: number }>();
  const userLimits = new Map<string, { reset: number; count: number }>();
  let closed = false;
  let unsubscribe = () => undefined as void;
  let closePromise: Promise<void> | undefined;
  function rateLimit(limits: typeof ipLimits, key: string, max: number): void {
    const now = clock();
    for (const [id, limit] of limits) if (limit.reset <= now) limits.delete(id);
    let limit = limits.get(key);
    if (!limit) {
      if (limits.size >= 1024) throw new HttpError(429, 'RATE_LIMITED');
      limit = { reset: now + 60_000, count: 0 }; limits.set(key, limit);
    }
    if (++limit.count > max) throw new HttpError(429, 'RATE_LIMITED');
  }
  function removeSession(id: string): void {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id); session.unregister();
    void session.server.close().catch(() => undefined);
    void revokeTransportContext(store, id, clock).catch(() => undefined);
  }
  function currentEvidence(): VerifiedRequestAuth {
    const evidence = requestEvidence.getStore();
    if (!evidence) throw new PolicyError('CONTEXT_DENIED');
    return evidence.auth;
  }
  async function checkSession(session: Session, auth: VerifiedRequestAuth): Promise<void> {
    if (!runtime.isActive(session.context.id) || session.expiresAt <= clock() || session.issuer !== auth.principal.issuer || session.subject !== auth.principal.subject || session.context.clientId !== auth.principal.clientId || session.context.resource !== auth.resource) throw new PolicyError('CONTEXT_DENIED');
    await assertTransportContext(store, session.context, auth, clock);
  }
  async function identityForTool(session: Session) {
    const auth = currentEvidence();
    try { return await runtime.coordinator.withFence(async () => {
      if (closed || config.maintenance) throw new PolicyError('STORE_UNAVAILABLE');
      const view = await authorizeIdentity(store, auth, { clock });
      await checkSession(session, auth);
      // Recheck expiry/readiness immediately before producing the protected result.
      if (!await store.ready()) throw new PolicyError('STORE_UNAVAILABLE');
      if (auth.principal.expiresAt <= clock()) throw new PolicyError('TOKEN_EXPIRED');
      return view;
    }); } catch (error) {
      requestEvidence.getStore()?.deny();
      throw error;
    }
  }
  const http = createServer({ maxHeaderSize: 32_768 }, async (req, res) => {
    const send = (status: number, body: unknown) => {
      if (res.headersSent || res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(body));
    };
    const timer = setTimeout(() => {
      if (!res.headersSent) send(503, { error: 'REQUEST_TIMEOUT' });
      else res.destroy();
      req.destroy();
    }, 35_000);
    timer.unref();
    res.once('close', () => clearTimeout(timer));
    res.once('finish', () => clearTimeout(timer));
    let observedAuth: VerifiedRequestAuth | undefined;
    let observedContext: string | undefined;
    let outcome: 'allowed' | 'denied' = 'denied';
    try {
      const path = req.url;
      // Railway probes this fixed hostname. It is a liveness exception only,
      // never an alternate resource host or trusted proxy for protected routes.
      const railwayHealth = req.method === 'GET' && path === '/health' && req.headers.host === 'healthcheck.railway.app' && !req.headers.origin && !req.headers.forwarded && !req.headers['x-forwarded-host'] && !req.headers['x-forwarded-proto'];
      if (!railwayHealth && (req.headers.host !== external.host || (req.headers.origin && !config.allowedOrigins.includes(req.headers.origin)) || req.headers.forwarded || (req.headers['x-forwarded-host'] && req.headers['x-forwarded-host'] !== external.host) || (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] !== external.protocol.slice(0, -1)))) throw new HttpError(403, 'ORIGIN_REJECTED');
      if (req.method === 'GET' && path === '/health') return send(200, { status: 'ok' });
      if (req.method === 'GET' && path === metadataPath(config.auth.resource)) return send(200, protectedResourceMetadata(config.auth));
      if (req.method === 'GET' && path === '/ready') {
        const ready = !closed && !config.maintenance && await store.ready();
        return send(ready ? 200 : 503, { status: ready ? 'ready' : 'unavailable' });
      }
      if (closed || config.maintenance || !await store.ready()) throw new PolicyError('STORE_UNAVAILABLE');
      rateLimit(ipLimits, req.socket.remoteAddress ?? 'unknown', 240);
      const bearer = readBearer(req);
      const principal = await options.verify(bearer);
      const auth: VerifiedRequestAuth = Object.freeze({ principal, resource: config.auth.resource, tokenFingerprint: createHash('sha256').update(bearer).digest('hex') });
      observedAuth = auth;
      requireScopes(principal, config.auth.requiredScopes);
      const admission = await runtime.coordinator.withFence(async () => {
        if (closed || config.maintenance) throw new PolicyError('STORE_UNAVAILABLE');
        const view = await authorizeIdentity(store, auth, { clock });
        rateLimit(userLimits, view.userId, 120);
        const sessionHeader = req.headers['mcp-session-id'];
        if (Array.isArray(sessionHeader)) throw new HttpError(400, 'INVALID_SESSION');
        const session = sessionHeader ? sessions.get(sessionHeader) : undefined;
        if (sessionHeader && !session) throw new PolicyError('CONTEXT_DENIED');
        if (session) { await checkSession(session, auth); observedContext = session.context.id; }
        return { view, session };
      });
      if (path !== '/mcp') throw new HttpError(404, 'NOT_FOUND');
      if (!['POST', 'GET', 'DELETE'].includes(req.method ?? '')) throw new HttpError(405, 'METHOD_NOT_ALLOWED');
      let body: unknown;
      if (req.method === 'POST') body = await readJson(req);
      let session = admission.session;
      if (!session) {
        if (req.method !== 'POST' || !isInitializeRequest(body)) throw new HttpError(400, 'INITIALIZE_REQUIRED');
        session = await runtime.coordinator.withFence(async () => {
          if (closed || !await store.ready()) throw new PolicyError('STORE_UNAVAILABLE');
          const view = await authorizeIdentity(store, auth, { clock });
          if (sessions.size >= 64 || [...sessions.values()].filter(item => item.context.userId === view.userId).length >= 8) throw new HttpError(429, 'SESSION_LIMIT');
          const context = await recordTransportContext(store, auth.principal, config.auth.resource, clock);
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => context.id, enableJsonResponse: true, maxRequestBodySize: MAX_BYTES });
          const server = new Server({ name: 'class-identity', version: '0.1.0' }, { capabilities: { tools: {} } });
          const created: Session = { context, issuer: auth.principal.issuer, subject: auth.principal.subject, expiresAt: clock() + SESSION_LIFETIME_MS, server, transport, unregister: () => undefined };
          server.setRequestHandler(ListToolsRequestSchema, async () => {
            await identityForTool(created);
            return { tools: [{ name: 'class_identity', description: 'Current authorized class identity. Desktop access is disabled.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } }] };
          });
          server.setRequestHandler(CallToolRequestSchema, async request => {
            try {
              const view = await identityForTool(created);
              if (request.params.name !== 'class_identity' || (request.params.arguments && Object.keys(request.params.arguments).length !== 0)) {
                requestEvidence.getStore()?.deny();
                return { isError: true, content: [{ type: 'text', text: '{"error":"INVALID_TOOL"}' }] };
              }
              return { content: [{ type: 'text', text: JSON.stringify(view) }], structuredContent: view };
            } catch (error) {
              return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: safeError(error).code }) }] };
            }
          });
          await server.connect(transport);
          created.unregister = runtime.registerContext(context, view.teamIds, () => removeSession(context.id));
          sessions.set(context.id, created);
          const previousOnClose = transport.onclose;
          transport.onclose = () => { previousOnClose?.(); removeSession(context.id); };
          return created;
        });
      }
      const selected = session;
      observedContext = selected.context.id;
      if (req.method === 'DELETE') await runtime.coordinator.withFence(async () => {
        await authorizeIdentity(store, auth, { clock }); await checkSession(selected, auth);
        await revokeTransportContext(store, selected.context.id, clock);
      });
      if (req.method !== 'DELETE') await runtime.coordinator.withFence(async () => {
        if (closed || config.maintenance) throw new PolicyError('STORE_UNAVAILABLE');
        await authorizeIdentity(store, auth, { clock }); await checkSession(selected, auth);
      });
      outcome = 'allowed';
      await requestEvidence.run({ auth, deny: () => { outcome = 'denied'; } }, () => selected.transport.handleRequest(req, res, body));
      if (req.method === 'DELETE') removeSession(selected.context.id);
      if (res.statusCode >= 400) outcome = 'denied';
    } catch (error) {
      outcome = 'denied';
      const failure = safeError(error);
      if (!res.headersSent && !res.destroyed && (failure.status === 401 || (error instanceof AuthError && error.code === 'INSUFFICIENT_SCOPE'))) res.setHeader('WWW-Authenticate', authenticationChallenge(config.auth, failure.status === 401 ? 'invalid_token' : 'insufficient_scope'));
      send(failure.status, { error: failure.code });
    } finally {
      if (observedAuth) observations.record(observedAuth, outcome, observedContext);
    }
  });
  http.headersTimeout = 10_000;
  http.requestTimeout = 35_000;
  http.keepAliveTimeout = 5_000;
  http.maxConnections = 256;
  http.on('upgrade', (_req, socket) => socket.destroy());
  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    closed = true; observations.close(); unsubscribe(); clearInterval(sweeper);
    closePromise = (async () => {
      for (const id of [...sessions.keys()]) removeSession(id);
      runtime.close();
      http.closeAllConnections();
      await new Promise<void>(resolve => http.close(() => resolve()));
    })();
    return closePromise;
  }
  const sweeper = setInterval(() => { for (const [id, session] of sessions) if (session.expiresAt <= clock()) removeSession(id); }, 60_000);
  sweeper.unref();
  unsubscribe = store.onUnavailable(() => { void close(); });
  try {
    if (closed) throw new Error('STORE_UNAVAILABLE');
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(config.port, config.host, () => { http.off('error', reject); resolve(); }); });
    if (closed) throw new Error('STORE_UNAVAILABLE');
  } catch (error) { await close(); throw error; }
  const address = http.address();
  if (!address || typeof address === 'string') { await close(); throw new Error('SERVER_UNAVAILABLE'); }
  return { url: `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${address.port}`, observations, close };
}

function readBearer(req: IncomingMessage): string {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]?.toLowerCase() === 'authorization') count++;
  const value = req.headers.authorization;
  if (count !== 1 || !value || Buffer.byteLength(value) > MAX_BEARER_BYTES || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw new AuthError('INVALID_TOKEN');
  return value.slice(7);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE');
  if (Number(req.headers['content-length']) > MAX_BYTES) throw new HttpError(413, 'TOO_LARGE');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_BYTES) { req.resume(); throw new HttpError(413, 'TOO_LARGE'); }
    chunks.push(bytes);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
  catch { throw new HttpError(400, 'INVALID_JSON'); }
}

function safeError(error: unknown): { status: number; code: string } {
  if (error instanceof HttpError) return error;
  if (error instanceof AuthError) return { status: error.code === 'INSUFFICIENT_SCOPE' ? 403 : 401, code: error.code };
  if (error instanceof PolicyError) {
    if (error.code === 'STORE_UNAVAILABLE') return { status: 503, code: 'SERVICE_UNAVAILABLE' };
    if (['TOKEN_EXPIRED', 'TOKEN_ISSUED_BEFORE_CUTOFF', 'TOKEN_REVOKED'].includes(error.code)) return { status: 401, code: 'INVALID_TOKEN' };
    return { status: 403, code: 'FORBIDDEN' };
  }
  return { status: 503, code: 'SERVICE_UNAVAILABLE' };
}
