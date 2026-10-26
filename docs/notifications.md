# Email notifications, alerts and forwarding

Phase 10. Email tells people when something needs them; it is never on a money
path (a mail outage cannot delay a payment, withdrawal or webhook).

> "Optional forwarding" in the roadmap is implemented as **notification
> forwarding**: an organization may send its notices to an outside address
> (accounting inbox, shared mailbox). Inbound mail handling is out of scope.
> ActualPay does not forward customer payments anywhere: in merchant mode funds
> already go straight to the merchant's own wallet.

## What gets sent

| Kind               | Triggered by                                                                                             | Who (role)              | Default |
| ------------------ | -------------------------------------------------------------------------------------------------------- | ----------------------- | ------- |
| `payments`         | invoice paid                                                                                             | owner, admin, finance   | off     |
| `payment_problems` | payment reversed by a chain reorganization                                                               | owner, admin, finance   | on      |
| `withdrawals`      | requested (needs approval), approved, completed, failed, cancelled, needs review                         | owner, admin, finance   | on      |
| `security`         | withdrawal limits changed, destination added or revoked, API key created or rotated, member role changed | owner, admin            | on      |
| `webhooks`         | an endpoint was auto-disabled after repeated failures                                                    | owner, admin, developer | on      |

Each member can turn kinds on or off for themselves (Dashboard → Notifications).
Unverified or disabled accounts are never mailed. Routine payment chatter is off
by default because webhooks are the right channel for it.

**Operator alerts.** Set `OPERATOR_ALERT_EMAIL` (needs SMTP) to receive one email
for every new _critical_ reconciliation issue (for example a withdrawal that
needs a human, or a reversal the books cannot absorb). One mail per issue; the
admin view keeps showing it until resolved. This is not a pager: monitor
`/v1/admin/status` and `/v1/admin/issues` as well.

## How it works

1. The worker reads new `domain_events` and `audit_log` rows past a cursor
   (`notification_cursor`), queues one `email_outbox` row per recipient and moves
   the cursor in the same transaction. Rows are idempotent by `dedupe_key`
   (`event:<id>:<address>`), so a crash, a second worker or a rewound cursor
   never sends twice. At migration time the cursor starts at the newest existing
   row: old history is not mailed.
2. `sendDue` claims rows with `FOR UPDATE SKIP LOCKED`, sends, and retries with
   backoff (1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h) up to 8 attempts. Only a fixed
   error phrase is stored; provider error text can echo addresses.
3. A per-organization cap (300 mails per rolling day) limits a flood.

## Safety properties

- **Plain text only.** No HTML, so nothing to inject into and nothing to phish with.
- **Subjects are fixed phrases** with no user-controlled text; a CHECK constraint
  also refuses CR/LF in subjects. Organization names and references appear in
  bodies on their own line with line breaks stripped.
- **Links point only at your deployment's dashboard**, never at user-supplied URLs.
- **No secrets in the outbox.** One-time links (verify email, reset password,
  confirm forwarding) are sent directly and never stored there.
- **Forwarding needs the address owner's consent.** A new forward is _pending_ and
  receives nothing until its owner clicks the emailed link. Tokens are 256-bit
  random, stored only as a SHA-256 hash, expire in 48 hours and work once.
  Creating one needs MFA and the `settings:manage` permission, is rate limited, and
  is audited; at most 5 per organization.
- Notices say what happened and where to look; they never include API keys,
  signing secrets or full approval links.

## Operating it

- Configure SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, optional credentials);
  port 587 uses STARTTLS and 465 implicit TLS, with certificate verification on.
- On the sending domain set up SPF, DKIM and DMARC, or messages land in spam.
- Without SMTP, development logs mail to the console (never allowed in production).
- Check `select status, count(*) from email_outbox group by 1`: a growing
  `pending` count means the mail server is down; `failed` rows were given up on.
- Old outbox rows are not purged automatically.

## Known limitations

- No digest mode, no per-asset or per-amount thresholds, no SMS/push/chat.
- Bounces are not processed. A bad forward address just fails and is abandoned.
- Email is not authenticated by the recipient's mail system beyond SPF/DKIM:
  do not approve withdrawals from an email link (there are none); always use the dashboard.
