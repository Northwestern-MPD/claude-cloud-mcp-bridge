/** Implementations must use macOS Keychain or Windows Credential Manager. */
export interface CredentialStore {
  save(deviceId: string, secret: string): Promise<void>;
  load(deviceId: string): Promise<string | null>;
  remove(deviceId: string): Promise<void>;
}

/** Milestone 2 has no OS adapter; callers must explicitly inject a secure implementation. */
export function unavailableCredentialStore(): CredentialStore {
  const unavailable = async (): Promise<never> => { throw new Error('KEYCHAIN_UNAVAILABLE'); };
  return Object.freeze({ save: unavailable, load: unavailable, remove: unavailable });
}
