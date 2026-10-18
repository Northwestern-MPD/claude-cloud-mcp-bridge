import { exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import type { AuthConfig } from '../../packages/auth/types.js';

const verifiedEmailClaim = 'https://github.com/Northwestern-MPD/claims/email_verified';
const signingKeys = generateKeyPair('RS256');

/** Real local keys and a fixed clock; never imported by production code. */
export async function signingFixture(nowMs: number) {
  const { privateKey, publicKey } = await signingKeys;
  const config: AuthConfig = {
    issuer: 'https://class.example.auth0.com/',
    jwksUri: 'https://class.example.auth0.com/.well-known/jwks.json',
    resource: 'https://bridge.example/mcp',
    allowedClientIds: ['claude-client'],
    requiredScopes: ['identity:read'],
  };
  const publicJwk = { ...await exportJWK(publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
  const resolveKey: JWTVerifyGetKey = async () => publicKey;
  return {
    config,
    now: () => nowMs,
    publicJwk,
    resolveKey,
    async mint(overrides: Record<string, unknown> = {}, protectedHeaderOverrides: Record<string, unknown> = {}) {
      const claims: Record<string, unknown> = {
        iss: config.issuer,
        aud: config.resource,
        sub: 'auth0|student-1',
        azp: 'claude-client',
        scope: 'identity:read',
        iat: Math.floor(nowMs / 1000),
        exp: Math.floor(nowMs / 1000) + 600,
        [verifiedEmailClaim]: true,
        ...overrides,
      };
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key', ...protectedHeaderOverrides })
        .sign(privateKey);
    },
  };
}
