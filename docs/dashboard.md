# Dashboards and hosted checkout

Phase 9. A merchant dashboard, a platform-administrator view and the hosted pay
page, all as one small static web app in `apps/web/public/`. There is no build
step and no third-party code: plain HTML, one stylesheet and ES modules.

| URL                   | What                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `/app/`               | Dashboard (sign-in, invoices, wallets, webhooks, withdrawals, team, API keys, audit log, security, platform admin) |
| `/pay/:publicId`      | Hosted checkout for one invoice; polls its status                                                                  |
| `/pay/link/:publicId` | Hosted payment link; "Continue" creates an invoice and redirects                                                   |

The API process serves these files (`apps/api/src/routes/web.ts`), so the
dashboard is same-origin with the API: session cookies stay `SameSite=Strict`
and `HttpOnly`, and no CORS is involved. The dashboard talks to the same public
JSON API as any integration; it has no private endpoints.

## Security properties

- **No markup injection.** The code builds DOM with `createElement` and
  `textContent` only. `tests/integration/web.test.ts` fails the build if any web
  source contains `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`,
  `eval`, `new Function`, or string timers. The browser smoke test creates an
  invoice whose description is an `<img onerror>` payload and checks it renders
  as text.
- **Strict CSP** on every page: scripts and styles only from this origin, no inline
  code, no `eval`, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`.
- **Allowlisted files.** Only four asset names are served, read once at startup.
  No request path reaches the file system.
- **CSRF** header is attached to every state-changing request; the server verifies it.
- **The UI is not the authority.** It hides buttons a role cannot use, but every
  action is authorised again on the server (permissions, MFA, four-eyes).
- **Secrets** (API keys, webhook secrets, recovery codes) are shown once in the
  page and are never stored in `localStorage`; only the selected organization id is.
- Third-party analytics, fonts or CDNs are deliberately absent.

## What the dashboard does not do

- It does not show balances or ledger entries (no ledger read endpoint yet).
- It does not create payment links (API only) — the hosted link page works.
- No i18n, no client-side QR code (the pay page shows the address and a wallet
  URI link; a QR needs either a vetted library or a server-side image).
- No fiat prices.

## Browser smoke test

`scripts/web-smoke.mjs` drives headless Chromium through registration, email
verification, sign-in, organization creation, invoice creation, every dashboard
page and the pay page. It needs Playwright (not a project dependency) and
**wipes the test database**:

```sh
npm i --no-save playwright && npx playwright install chromium
node --env-file=.env --import tsx scripts/web-smoke.mjs
```
