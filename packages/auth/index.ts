export { VERIFIED_EMAIL_CLAIM } from './types.js';
export type { AuthConfig, PrincipalKey, VerifiedPrincipal, VerifiedRequestAuth } from './types.js';
export { AuthError } from './errors.js';
export type { AuthErrorCode } from './errors.js';
export { requireScopes, verifyAccessToken } from './verifier.js';
export { createJwksResolver } from './jwks.js';
export { authenticationChallenge, metadataPath, protectedResourceMetadata } from './metadata.js';
