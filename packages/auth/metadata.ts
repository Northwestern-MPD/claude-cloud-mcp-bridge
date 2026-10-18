import { AuthError } from './errors.js';
import type { AuthConfig } from './types.js';

const WELL_KNOWN_PATH = '/.well-known/oauth-protected-resource';

/** RFC 9728 metadata describes the resource, never the authorization server's keys. */
export function protectedResourceMetadata(config: AuthConfig): object {
  resourceUrl(config.resource);
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    ...(config.requiredScopes.length ? { scopes_supported: [...config.requiredScopes] } : {}),
    bearer_methods_supported: ['header'],
  };
}

export function metadataPath(resource: string): string {
  const url = resourceUrl(resource);
  return WELL_KNOWN_PATH + (url.pathname === '/' ? '' : url.pathname) + url.search;
}

/** The caller maps insufficient_scope to HTTP 403 and invalid_token to HTTP 401. */
export function authenticationChallenge(config: AuthConfig, error: 'invalid_token' | 'insufficient_scope', scopes: readonly string[] = config.requiredScopes): string {
  const url = resourceUrl(config.resource);
  const metadata = `${url.origin}${metadataPath(config.resource)}`;
  if (error !== 'invalid_token' && error !== 'insufficient_scope') throw new AuthError('INVALID_TOKEN');
  let challenge = `Bearer resource_metadata="${metadata}", error="${error}"`;
  if (error === 'insufficient_scope' && scopes.length) {
    // OAuth scope-token excludes quotes, backslashes, whitespace and control bytes.
    if (scopes.some((scope) => !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope))) throw new AuthError('INVALID_TOKEN');
    challenge += `, scope="${[...new Set(scopes)].join(' ')}"`;
  }
  return challenge;
}

function resourceUrl(resource: string): URL {
  try {
    const url = new URL(resource);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || /[\x00-\x20\x7F"\\]/.test(resource)) {
      throw new AuthError('INVALID_TOKEN');
    }
    return url;
  } catch {
    throw new AuthError('INVALID_TOKEN');
  }
}
