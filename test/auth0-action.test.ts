import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const claim = 'https://github.com/Northwestern-MPD/claims/email_verified';
async function action() {
  const exports: { onExecutePostLogin?: (event: unknown, api: unknown) => Promise<void> } = {};
  runInNewContext(await readFile(new URL('../auth0/actions/verified-email.js', import.meta.url), 'utf8'), { exports });
  assert.equal(typeof exports.onExecutePostLogin, 'function');
  return exports.onExecutePostLogin!;
}

test('Auth0 Action issues verification evidence only from the trusted boolean user state', async () => {
  const onLogin = await action();
  for (const verified of [true, false, undefined, null, 'true', 1]) {
    const claims: Array<[string, unknown]> = [];
    await onLogin({
      user: { email_verified: verified, user_metadata: { email_verified: true } },
      request: { query: { email_verified: true }, body: { email_verified: true } },
    }, { accessToken: { setCustomClaim: (name: string, value: unknown) => claims.push([name, value]) } });
    assert.deepEqual(claims, [[claim, verified === true]]);
  }
});

test('missing Auth0 user evidence produces a false claim rather than trusting alternate input', async () => {
  const onLogin = await action();
  const claims: Array<[string, unknown]> = [];
  await onLogin({ request: { body: { email_verified: true } } }, {
    accessToken: { setCustomClaim: (name: string, value: unknown) => claims.push([name, value]) },
  });
  assert.deepEqual(claims, [[claim, false]]);
});
