export const VERIFIED_EMAIL_CLAIM = 'https://github.com/Northwestern-MPD/claims/email_verified';

export type PrincipalKey = Readonly<{ issuer: string; subject: string }>;

export type VerifiedPrincipal = PrincipalKey & Readonly<{
  clientId: string;
  scopes: readonly string[];
  /** Unix milliseconds. */
  issuedAt: number;
  /** Unix milliseconds. */
  expiresAt: number;
  emailVerified: true;
}>;

export type AuthConfig = Readonly<{
  issuer: string;
  jwksUri: string;
  resource: string;
  allowedClientIds: readonly string[];
  requiredScopes: readonly string[];
}>;

/** Created at the trusted HTTP boundary for each verified bearer request. */
export type VerifiedRequestAuth = Readonly<{
  principal: VerifiedPrincipal;
  resource: string;
  tokenFingerprint: string;
}>;
