# Auth0 and private operator setup

Status: local contracts and disposable tests are implemented; hosted acceptance remains pending. The new tenant is `dev-exz4k4zrf6whdd7s.us.auth0.com`. The fixed Action is deployed/bound, and an invited-only email connection plus isolated development client are configured. The operator authorized two test accounts and confirmed Auth0 built-in emails reached both inboxes. No external SMTP service is available. The first account has completed hosted email-code sign-in and an operator-reported native class_identity call. Provider email suppression, the second account and refresh/session checks remain pending. See [the verification record](IDENTITY_VERIFICATION.md) for exact evidence and pending gates.

## Tenant, email and API

1. Create the approved tenant/environment and record its canonical HTTPS issuer, including the trailing slash, and trusted JWKS endpoint. Enable the `email` passwordless connection and select hosted email one-time codes. Enable **Disable Sign Ups** so only pre-provisioned accounts can sign in, and enable this connection only for approved native clients. This restriction applies to the connection across the pilot tenant. [Auth0 email OTP setup](https://auth0.com/docs/authenticate/passwordless/authentication-methods/email-otp).
2. For development, the operator selected Auth0's built-in email provider and explicitly authorized test accounts A and B (addresses remain in protected operator records). Before class rollout, configure a production SMTP provider and a sender/domain the operator is authorized to use. Verify provider delivery, SPF/DKIM and applicable sender approval before invitations. Auth0's built-in email provider is intended for testing. The separate invitation adapter uses Nodemailer with certificate verification and mandatory TLS on port 465 or 587; it sends an invitation without a login code or credential. [Auth0 email providers](https://auth0.com/docs/authenticate/passwordless/authentication-methods/email-otp), [Nodemailer SMTP](https://nodemailer.com/smtp).
3. Create the API using the exact identity service `/mcp` resource URI as its identifier. Use RS256, the Auth0 default access-token profile (`access_token`) and a 600-second API access-token lifetime. Register only `identity:read` for this release. The verifier consumes signed `scope` and `azp`; an optional `client_id` must agree with `azp`. Record these claims from an actual issued token without copying the token into evidence. A different token profile needs a verifier contract review. [Auth0 token profiles](https://auth0.com/docs/secure/tokens/access-tokens/access-token-profiles).
4. Deploy `auth0/actions/verified-email.js` into the tenant's post-login flow, bind it and test it. It sets only `https://github.com/Northwestern-MPD/claims/email_verified` from the strict boolean `event.user.email_verified === true`. Request parameters and editable user metadata never establish verification. Do not manually set an account verified to bypass email authentication.
5. Use Authorization Code with PKCE S256 for public native clients. Configure exact approved callback/logout URLs. Prefer supported static/CIMD registration; record the real client's requirement before considering DCR or client credentials. Enable/test RFC 8707 resource compatibility with that native client. Keep the current ping services available. Provider documentation and SDK tests do not establish native Claude compatibility.

When a native client needs offline access, enable its refresh-token grant and the API's offline-access setting, then verify that client requests and safely stores its own refresh tokens. Enable rotation and automatic reuse detection. Set finite idle and maximum expiration; pilot starting values are 7 days idle and 30 days maximum, subject to operator approval. Choose the smallest measured rotation overlap that permits the client's supported retry behavior; 0 seconds is the starting candidate, not a measured compatibility result. Record actual refresh, expired refresh and reused-token denial outcomes. The service never receives or stores refresh tokens. [Rotation and overlap](https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-rotation), [idle and maximum expiration](https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-expiration).

### Reserved pilot resource

The approved identity resource is exactly `https://class-identity-production.up.railway.app/mcp`. Auth0 API `6ad5153e0cbf88ba082913bd` is registered with RS256, `access_token` profile, 600-second access lifetime for both API/web flows, `identity:read`, and offline access enabled. Configuration was re-fetched after creation. The identity app is deployed and ready; configuration and unauthenticated HTTPS checks are not a successful student sign-in.

Static public client `OUmVGrnlfsCIzS8JG55tBhZIgPKBTCeu` (`MPD - Claude hosted identity pilot`) has type `native`, token authentication `none`, Authorization Code/refresh grants and the exact callback `https://claude.ai/api/mcp/auth_callback`. Refresh rotation is enabled with 7-day idle/30-day maximum expiration and zero overlap; compatibility remains to be observed. The invited-only email connection enables this client and the existing isolated development preflight client. Auth0 automatically enabled Google and password-database connections on the new client; both were disabled for this client only, and re-fetch confirmed email is its sole active login connection. Signups remain disabled and brute-force protection remains enabled.

The tenant already reports `resource_parameter_profile=compatibility` and `authorization_response_iss_parameter_supported=true`. CIMD remains disabled. Static public registration is explicitly supported by Claude: after the service is ready, add its resource URL as a custom connector, choose **Use your own OAuth client** (or Advanced settings), enter the public client ID above and leave the optional secret blank. Claude documents PKCE S256 for this path. Each student authenticates individually with their own invited verified account; the shared public client ID grants no membership. [Claude custom connector authentication](https://claude.com/docs/connectors/custom/add-unlisted#choose-authentication-settings), [authentication requirements and callback](https://claude.com/docs/connectors/building/authentication).

Claude Code cloud inherits configured claude.ai connectors and their proxy authorization; it does not perform the terminal client's loopback OAuth flow. Record this delivery path explicitly during native acceptance. The current project probe entries remain available. [Cloud connector delivery](https://code.claude.com/docs/en/mcp#how-connectors-reach-claude-code).

Passwordless New Universal Login also requires **Identifier First**. Configure `PATCH /api/v2/prompts` with `{"identifier_first":true}`, and re-fetch to verify it alongside `universal_login_experience=new`. The first real Claude attempt reached the correct client/callback/resource/S256 request but failed with `no connections enabled for the client` while this setting was unset. After enabling it, the same diagnostic request reached `/u/login/identifier` with an email input and no connection error. This entry-form check alone is not proof of email verification, token exchange or native MCP success. The operator subsequently completed sign-in and reported a successful native class_identity result for account A; see the verification record. [Auth0 passwordless login-profile requirement](https://support.auth0.com/center/s/article/no-connections-enabled-for-the-client).

Auth0's current API enables a client through `PATCH /api/v2/connections/{id}/clients` with `[{"client_id":"...","status":true}]`. The older `enabled_clients` property on connection PATCH was rejected. Re-fetch the client list through that same `/clients` endpoint and separately verify `disable_signup`; do not infer success from the CLI wrapper's exit status alone.

## Reuse across class MCP servers

Reuse `packages/auth/index.ts` with a separate `AuthConfig` for each service. Share the canonical issuer/JWKS and the stable `(issuer, subject)` identity. Give each server its own exact resource URI, required scopes and approved native-client list; register that resource/API in the same Auth0 tenant. A bridge access token must not authorize a different class API. The second-resource automated tests enforce audience and scope separation.

The package performs verification/discovery only and imports no Postgres, Blender or connector policy. Each server supplies its own current enrollment/revocation checks after token verification. Bridge device credentials, work grants, admin sockets and database credentials are not reusable login credentials. This repository contains the internal module; an npm package has not been published. Real native registration and token-profile compatibility still require the recorded hosted checks.

## Passwordless account creation gate

The production provider adapter defaults to **lookup and exact-subject reconciliation only**. If no account exists, it raises `PROVIDER_CREATE_NOT_VERIFIED` without a Create User request. This is an outstanding live acceptance blocker for automatic onboarding.

Auth0 documents a passwordless limitation in which `verify_email:false` can be ignored and account creation can send a verification email. That would send mail before the local invitation is durable. Its suggested temporary `email_verified:true` workaround is prohibited here because our verified-email claim must represent actual verification. [Auth0 passwordless creation limitation](https://support.auth0.com/center/s/article/verify-email-false-for-passwordless-connection-still-sending-verification-email).

Before enabling creation, the operator must supply authorized test recipients, a production sender, and evidence from the exact new tenant/email connection showing that Create User with `email_verified:false` and `verify_email:false` sends **no provider email**, including welcome/verification/passwordless templates. Evidence must identify tenant/connection, tested configuration, date, authorized recipient reference and observed provider/mailbox result, without credentials or message content. Repeat the check after relevant tenant/template changes. The evidence reference is provided to the operator process as `AUTH0_CREATE_MAIL_SUPPRESSION_EVIDENCE`; it is an explicit operator attestation, not an automatic provider capability discovery. If the tenant cannot provide this behavior, leave the gate unset and keep automatic account creation blocked pending a reviewed onboarding change. Existing exact-subject enrollment can still be prepared deliberately.

The adapter uses only `GET /api/v2/users-by-email`, `GET /api/v2/users/{subject}`, and the gated `POST /api/v2/users`. Its Management API token needs `read:users` and, only when creation is enabled, `create:users`. Use a dedicated operator M2M client and a short-lived Management token from protected configuration. No update/delete scope is required for provisioning. Provider-side blocking/revocation is a separate operator action and must follow the local denial. [Management API permissions](https://auth0.com/docs/manage-users/user-accounts/manage-users-using-the-management-api).

Auth0 email lookup is case sensitive and native account creation can lowercase email. Our roster trims outer whitespace and lowercases only the domain; it preserves local-part case, dots and plus tags. An unexpected provider normalization records the exact returned subject but raises `PROVIDER_RECONCILIATION_REQUIRED`; no local invitation or SMTP mail follows. The operator must review that exact account and add its same `subject` to the protected roster before retrying. Matching email never transfers local ownership between subjects, and provider connection changes require explicit revocation/reconciliation. [Auth0 lookup casing](https://support.auth0.com/center/s/article/Search-user-by-email-with-Auth0-Managment-API-endpoint).

## Private commands and manifests

The serving process receives its app-role database credentials and identity configuration. Management, SMTP, migration and backup credentials are absent from its environment. Run the operator CLI through an authenticated operator shell; `AUTHZ_ADMIN_SOCKET` defaults to `/tmp/mpd-identity/admin.sock`. Its directory is owned by the serving UID with mode 0700 and its Unix socket is 0600. No admin HTTP route or MCP tool is exposed.

Prepare JSON files with mode 0600 under ignored `work/identity-operator/` (directory 0700). Roster rows contain a stable random UUID `id`, exact `email`, configured `issuer`, optional reviewed `subject`, explicit `courseId`, `teamId`, `role` (`student` or `instructor`) and Unix-millisecond `expiresAt` no later than seven days from import. Course/team records must already exist. The operator's recipient authorization must cover every row before any provider write or invitation send. Neither a domain nor an email address grants membership.

After building:

```bash
node dist/apps/operator/main.js admin --file work/identity-operator/command.json
node dist/apps/operator/main.js provision --file work/identity-operator/roster.json
node dist/apps/operator/main.js deny-token --expires-at 1800000600000 --reason operator < /protected/token-input
```

The last expiry is a labeled example in Unix milliseconds, not a current credential. The token is read from protected stdin, fingerprinted in the operator process and never submitted raw or printed. Command JSON supports only `import-invites`, `disable-user`, `remove-membership`, `block-resource`, `deny-token`, `revoke-device`, `maintenance`, `reconcile-roster`, `retention`, and `close-course`; strict validation rejects unknown fields/SQL/provider URLs. A batch is bounded to 100 invitations and 64 KiB. Successful output contains only `{ok:true,affected:number}` or aggregate provisioning counts.

Use `AUTH0_MANAGEMENT_ORIGIN`, `AUTH0_MANAGEMENT_TOKEN` and, after its live evidence gate passes, `AUTH0_CREATE_MAIL_SUPPRESSION_EVIDENCE` only in the provisioning process. SMTP settings are `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` and the public `MCP_RESOURCE_URI`. `IDENTITY_SEND_AUTHORIZED=true` is set only after explicit authorization for the current protected roster. With the flag absent/false, the invitation sender is never invoked and no SMTP configuration is required. The built-in Auth0 provider can support the separately authorized development authentication emails; the operator's SMTP invitation adapter remains unavailable until an external SMTP service is configured. This distinction does not relax the provider-create suppression gate.

Inside the Node container, use a writable operator directory such as `/tmp` as the working directory and invoke `/app/dist/apps/operator/main.js`, so records are under `/tmp/work/identity-operator/`. Keep the authoritative roster and delivery manifests in protected operator storage outside the ephemeral serving container; copy them securely into the operator workspace before a retry and retain the updated manifests afterward. If delivery records are lost, keep sending disabled and reconcile provider evidence before approving any resend.

A private per-invitation manifest records exact subject mapping, roster hash and delivery phase, with mode 0600 and atomic synced writes. Provider success is recorded before local persistence. A retry reconciles that exact subject and idempotently imports the same invitation through the running app's socket; it never opens a second runtime owner. Already confirmed `sent` mail is not resent. `sending` after interruption becomes `uncertain`; inspect provider evidence and reconcile deliberately before any resend. SMTP acceptance does not establish mailbox delivery. A connection loss can make delivery uncertain. The CLI returns status 2 for failed/uncertain delivery and never includes recipient lists or provider diagnostics. Concurrent provisioning is refused by a private `.lock`; inspect an abandoned lock after confirming the prior operator process stopped.

Maintenance uses a private command such as `{"kind":"maintenance","enabled":true}`. The shared runtime coordinator holds its authority fence once through database commit and runtime invalidation. Enabling stored maintenance denies admission, revokes contexts/grants, marks unfinished writes uncertain and closes registered transports before acknowledgement. The socket remains usable. Clearing stored maintenance is permitted only when external `AUTHZ_MAINTENANCE=false`; the external true flag remains a hard deny. Deploy/rollback requires explicit drain/stop/owner-lock release before replacement startup. Delegated device/user/token revocation and restore reconciliation handlers acquire this same fence exactly once; executeAdmin must not wrap a delegated fence. Fingerprint denial preserves the context for other valid tokens and cancels only matching token work.

Disable locally first using the private socket. Confirm next-request denial and context invalidation, then perform provider account/refresh-token blocking through the operator's authorized Auth0 controls. Provider logout or refresh revocation alone does not immediately invalidate an already issued access JWT. Use a subject/resource block to deny both existing and fresh tokens when that is the intended policy.

## Labeled configuration example

All domains, clients and password values below are examples. Replace them with approved nonsecret identifiers and protected runtime secrets. This object is accepted by `readIdentityConfig`; it does not connect to a real database or Auth0 tenant.

```json
{
  "AUTH0_ISSUER":"https://class.example.auth0.com/",
  "AUTH0_JWKS_URI":"https://class.example.auth0.com/.well-known/jwks.json",
  "MCP_RESOURCE_URI":"https://class-identity.example/mcp",
  "MCP_EXTERNAL_ORIGIN":"https://class-identity.example",
  "MCP_ALLOWED_ORIGINS":"https://class-identity.example",
  "AUTH0_ALLOWED_CLIENT_IDS":"approved-native-client",
  "DATABASE_URL":"postgresql://mpd_identity_app:REPLACE_WITH_SECRET@identity-db.railway.internal/identity",
  "DB_TRANSPORT_MODE":"railway-private",
  "AUTHZ_STORE_ID":"89dcbb2b-4e4c-491b-a911-d3448941d173",
  "AUTHZ_DEPLOY_EPOCH":"initial",
  "AUTHZ_TOKEN_IAT_AFTER":"0",
  "AUTHZ_MAINTENANCE":"true",
  "AUTHZ_ADMIN_SOCKET":"/tmp/mpd-identity/admin.sock",
  "PORT":"3000"
}
```

Hosted acceptance still requires the new tenant, native client registration, actual resource/domain, authorized test recipients and roster, verified SMTP delivery, demonstrated create-email suppression, private Railway database/role setup and the required two-account/same-user-session experiments. Keep desktop capabilities disabled until their separate evidence gates pass.
