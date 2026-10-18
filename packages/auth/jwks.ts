import { createLocalJWKSet, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose';
import { AuthError } from './errors.js';
import type { AuthConfig } from './types.js';

const REFRESH_AFTER_MS = 600_000;
const TRUSTED_KEY_LIFETIME_MS = 3_600_000;
const RETRY_AFTER_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 65_536;
const MAX_KEYS = 32;

type TrustedKeys = {
  resolve: JWTVerifyGetKey;
  kids: Set<string>;
  successfulAt: number;
};

/** Each server instance owns its bounded cache, sourced only from trusted configuration. */
export function createJwksResolver(config: AuthConfig, deps: { fetch: typeof fetch; now(): number }): JWTVerifyGetKey {
  const jwksUri = config.jwksUri;
  try {
    const url = new URL(jwksUri);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new AuthError('INVALID_TOKEN');
    }
  } catch {
    throw new AuthError('INVALID_TOKEN');
  }
  let keys: TrustedKeys | undefined;
  let inFlight: Promise<TrustedKeys> | undefined;
  let lastUnknownRefresh = -Infinity;
  let lastRefreshAttempt = -Infinity;

  async function refresh(): Promise<TrustedKeys> {
    if (inFlight) return inFlight;
    lastRefreshAttempt = deps.now();
    inFlight = (async () => {
      const jwks = await fetchKeySet(jwksUri, deps.fetch);
      // Publish only complete, bounded, structurally valid responses. Failed refreshes
      // never extend the last successful fetch's trust lifetime.
      const fetched = {
        resolve: createLocalJWKSet(jwks),
        kids: new Set(jwks.keys.map((key) => key.kid).filter((kid): kid is string => typeof kid === 'string')),
        successfulAt: deps.now(),
      };
      keys = fetched;
      return fetched;
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = undefined;
    }
  }

  return async (header, token) => {
    try {
      if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
        throw new AuthError('INVALID_TOKEN');
      }
      const now = deps.now();
      if (!keys) {
        if (now - lastUnknownRefresh < RETRY_AFTER_MS) throw new AuthError('INVALID_TOKEN');
        try {
          const fetched = await refresh();
          if (!fetched.kids.has(header.kid)) lastUnknownRefresh = now;
        } catch {
          lastUnknownRefresh = now;
          throw new AuthError('INVALID_TOKEN');
        }
      } else if (!keys.kids.has(header.kid)) {
        if (now - lastUnknownRefresh >= RETRY_AFTER_MS) {
          lastUnknownRefresh = now;
          await refresh().catch(() => undefined);
        }
      } else if (now - keys.successfulAt >= REFRESH_AFTER_MS && now - lastRefreshAttempt >= RETRY_AFTER_MS) {
        await refresh().catch(() => undefined);
      }
      // Read the clock after asynchronous I/O so an outage cannot move acceptance
      // beyond the one-hour bound while a refresh was pending.
      if (!keys || deps.now() - keys.successfulAt >= TRUSTED_KEY_LIFETIME_MS || !keys.kids.has(header.kid)) {
        throw new AuthError('INVALID_TOKEN');
      }
      return await keys.resolve(header, token);
    } catch {
      throw new AuthError('INVALID_TOKEN');
    }
  };
}

async function fetchKeySet(uri: string, fetcher: typeof fetch): Promise<JSONWebKeySet> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      void reader?.cancel().catch(() => undefined);
      reject(new AuthError('INVALID_TOKEN'));
    }, FETCH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      deadline,
      (async () => {
        const response = await fetcher(uri, {
          redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json' },
        });
        if (response.status !== 200 || response.redirected || (response.url && response.url !== uri) || !response.body) {
          throw new AuthError('INVALID_TOKEN');
        }
        const contentLength = response.headers.get('content-length');
        if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES) throw new AuthError('INVALID_TOKEN');
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_RESPONSE_BYTES) throw new AuthError('INVALID_TOKEN');
          chunks.push(value);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!data || typeof data !== 'object' || !('keys' in data) || !Array.isArray(data.keys)
          || data.keys.length === 0 || data.keys.length > MAX_KEYS
          || data.keys.some((key: unknown) => !key || typeof key !== 'object' || !('kty' in key) || typeof key.kty !== 'string')) {
          throw new AuthError('INVALID_TOKEN');
        }
        return data as JSONWebKeySet;
      })(),
    ]);
  } catch {
    controller.abort();
    void reader?.cancel().catch(() => undefined);
    throw new AuthError('INVALID_TOKEN');
  } finally {
    clearTimeout(timeout);
  }
}
