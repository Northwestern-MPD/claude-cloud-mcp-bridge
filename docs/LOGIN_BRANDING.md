# MPD hosted login branding

Updated October 18, 2026.

The existing Auth0 pilot tenant (`dev-exz4k4zrf6whdd7s.us.auth0.com`) now has an MPD Class Tools Universal Login theme and English text overrides for `login-id` and `login-passwordless-email-code`.

- Primary color: `#4E2A84`; pale background: `#F4F1F8`; white login panel.
- Heading: “MPD Class Tools”.
- Email instructions: “Sign in with your invited northwestern.edu email address.”
- Field label: “Northwestern email address”; code button: “Verify email”.
- The supplied MPD logo is pending explicit approval to publish it to this public repository for HTTPS hosting. The current screen still displays a default icon.

Student provisioning must use explicitly invited northwestern.edu email addresses. This branding change does not implement domain enforcement or grant access based on an email suffix. Existing exact-subject invitation and verified-email authorization remain required. The two explicitly authorized pilot test accounts remain available for the ongoing refresh/revocation tests.

## Verification and recovery

Current settings were fetched before mutation and re-fetched afterward. Protected before/after snapshots and desktop/mobile screenshots are under ignored `work/identity-operator/branding/`. A separate fresh browser context loaded the real hosted authorization page using the configured public Claude client, exact resource and PKCE S256. It rendered the heading, Northwestern instructions, purple button and pale background; the mobile page had no horizontal overflow. No email, code or token was submitted. This is visual verification, not a new native identity/refresh result.

Applied surfaces: basic `branding` colors, the default branding theme and the two merged prompt text overrides. The theme initially did not appear in the browser; basic branding colors were then applied as well and the confirmed capture showed the intended theme. No custom domain, ACUL frontend, login Action, issuer, client registration or access-token lifetime was changed. The reported submit delay/duplicate-click finding remains unresolved.

To revise settings, GET and merge current values before updating; custom-text PUT replaces the whole prompt-language object. Restore protected before snapshots for existing settings; the theme did not exist before this change. Do not revert unrelated subsequent tenant changes. The identity Railway release remains pinned and no app redeployment was performed.
