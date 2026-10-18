/** Stable public denial codes; database/provider diagnostics stay out of responses. */
export class PolicyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PolicyError';
  }
}

export function policyError(error: unknown): PolicyError {
  if (error instanceof PolicyError) return error;
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && ['23505', '40001', '40P01', '55P03'].includes(code)) {
    return new PolicyError('AUTHORIZATION_CONFLICT');
  }
  return new PolicyError('STORE_UNAVAILABLE');
}
