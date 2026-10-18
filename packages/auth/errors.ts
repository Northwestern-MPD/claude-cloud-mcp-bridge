export type AuthErrorCode = 'INVALID_TOKEN' | 'INSUFFICIENT_SCOPE';

/** Public errors deliberately omit tokens, provider diagnostics and raw claims. */
export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode) {
    super(code);
    this.name = 'AuthError';
  }
}
