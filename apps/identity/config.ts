import { isAbsolute } from 'node:path';
import type { AuthConfig } from '../../packages/auth/types.js';
import { databaseClientConfig } from '../../packages/storage/database.js';
import type { OpenStoreOptions, TransportMode } from '../../packages/storage/types.js';

export type IdentityConfig = Readonly<{
  auth: AuthConfig;
  database: Omit<OpenStoreOptions, 'now'>;
  externalOrigin: string;
  allowedOrigins: readonly string[];
  host: string;
  port: number;
  maintenance: boolean;
  adminSocketPath: string;
}>;

export function readIdentityConfig(env: NodeJS.ProcessEnv): IdentityConfig {
  try {
    const required = (name: string) => { const value = env[name]; if (!value || value.trim() !== value) throw new Error(); return value; };
    const httpsUrl = (value: string) => {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || /[\x00-\x20\x7f"\\]/.test(value)) throw new Error();
      return url;
    };
    const issuer = required('AUTH0_ISSUER');
    const issuerUrl = httpsUrl(issuer);
    if (!issuer.endsWith('/') || issuerUrl.href !== issuer) throw new Error();
    const jwksUri = required('AUTH0_JWKS_URI');
    httpsUrl(jwksUri);
    const resource = required('MCP_RESOURCE_URI');
    const resourceUrl = httpsUrl(resource);
    if (resourceUrl.href !== resource || resourceUrl.pathname !== '/mcp') throw new Error();
    const externalOrigin = required('MCP_EXTERNAL_ORIGIN');
    if (httpsUrl(externalOrigin).origin !== externalOrigin || resourceUrl.origin !== externalOrigin) throw new Error();
    const allowedClientIds = required('AUTH0_ALLOWED_CLIENT_IDS').split(',').map(value => value.trim());
    if (allowedClientIds.some(value => !/^[A-Za-z0-9_-]{1,256}$/.test(value))) throw new Error();
    const allowedOrigins = (env.MCP_ALLOWED_ORIGINS ?? externalOrigin).split(',').map(value => value.trim());
    if (allowedOrigins.some(value => httpsUrl(value).origin !== value)) throw new Error();
    const connectionString = required('DATABASE_URL');
    if (decodeURIComponent(new URL(connectionString).username) !== 'mpd_identity_app') throw new Error();
    const transportMode = required('DB_TRANSPORT_MODE') as TransportMode;
    const ca = env.DB_CA_CERT;
    databaseClientConfig(connectionString, { transportMode, ca });
    const expectedStoreId = required('AUTHZ_STORE_ID');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(expectedStoreId)) throw new Error();
    const deploymentEpoch = required('AUTHZ_DEPLOY_EPOCH');
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(deploymentEpoch)) throw new Error();
    const cutoff = required('AUTHZ_TOKEN_IAT_AFTER');
    if (!/^\d+$/.test(cutoff) || !Number.isSafeInteger(Number(cutoff))) throw new Error();
    const maintenanceValue = required('AUTHZ_MAINTENANCE');
    if (!['true', 'false'].includes(maintenanceValue)) throw new Error();
    const maintenance = maintenanceValue === 'true';
    const portValue = required('PORT');
    const port = Number(portValue);
    if (!/^\d+$/.test(portValue) || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error();
    const host = env.HOST ?? '0.0.0.0';
    if (!['0.0.0.0', '127.0.0.1', '::', '::1'].includes(host)) throw new Error();
    const adminSocketPath = env.AUTHZ_ADMIN_SOCKET ?? '/tmp/mpd-identity/admin.sock';
    if (!isAbsolute(adminSocketPath) || adminSocketPath.length > 100 || /[\x00-\x20\x7f]/.test(adminSocketPath)) throw new Error();
    return Object.freeze({
      auth: Object.freeze({ issuer, jwksUri, resource, allowedClientIds: Object.freeze([...new Set(allowedClientIds)]), requiredScopes: Object.freeze(['identity:read']) }),
      database: Object.freeze({ connectionString, transportMode, ...(ca ? { ca } : {}), expectedStoreId, deploymentEpoch, tokenIatAfter: Number(cutoff), maintenance }),
      externalOrigin, allowedOrigins: Object.freeze([...new Set(allowedOrigins)]), host, port, maintenance, adminSocketPath,
    });
  } catch { throw new Error('INVALID_IDENTITY_CONFIG'); }
}
