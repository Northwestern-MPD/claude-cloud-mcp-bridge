import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import { AuthError } from './errors.js';
import { VERIFIED_EMAIL_CLAIM, type AuthConfig, type VerifiedPrincipal } from './types.js';

const CLOCK_TOLERANCE_SECONDS = 60;
// OAuth scope-token excludes whitespace, double quote and backslash (RFC 6749).
const SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/;

export async function verifyAccessToken(
  token: string,
  config: AuthConfig,
  deps: { resolveKey: JWTVerifyGetKey; now(): number },
): Promise<VerifiedPrincipal> {
  let principal: VerifiedPrincipal;
  try {
    const nowMs = deps.now();
    if (!Number.isFinite(nowMs)) {
      throw new AuthError('INVALID_TOKEN');
    }
    const { payload } = await jwtVerify(token, deps.resolveKey, {
      algorithms: ['RS256'],
      issuer: config.issuer,
      audience: config.resource,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      currentDate: new Date(nowMs),
      requiredClaims: ['exp', 'iat', 'sub', 'azp', 'scope', VERIFIED_EMAIL_CLAIM],
    });
    if (
      typeof payload.sub !== 'string' || payload.sub.trim().length === 0 ||
      typeof payload.azp !== 'string' || payload.azp.trim().length === 0 ||
      !config.allowedClientIds.includes(payload.azp) ||
      (payload.client_id !== undefined && payload.client_id !== payload.azp) ||
      payload[VERIFIED_EMAIL_CLAIM] !== true ||
      typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) ||
      typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) ||
      payload.iat > Math.floor(nowMs / 1000) + CLOCK_TOLERANCE_SECONDS ||
      typeof payload.scope !== 'string' || !SCOPE.test(payload.scope)
    ) {
      throw new AuthError('INVALID_TOKEN');
    }
    principal = Object.freeze({
      issuer: config.issuer,
      subject: payload.sub,
      clientId: payload.azp,
      scopes: Object.freeze([...new Set(payload.scope.split(' '))]),
      issuedAt: payload.iat * 1000,
      expiresAt: payload.exp * 1000,
      emailVerified: true,
    });
  } catch {
    // Do not expose JOSE errors: their details can include untrusted claim values.
    throw new AuthError('INVALID_TOKEN');
  }
  requireScopes(principal, config.requiredScopes);
  return principal;
}

export function requireScopes(principal: VerifiedPrincipal, scopes: readonly string[]): void {
  if (scopes.some(scope => !principal.scopes.includes(scope))) {
    throw new AuthError('INSUFFICIENT_SCOPE');
  }
}
