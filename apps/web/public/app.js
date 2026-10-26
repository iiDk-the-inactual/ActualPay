// ActualPay dashboard. A dependency-free single-page app over the JSON API.
// Rules: build DOM with el() only (no HTML strings); every state-changing call goes
// through api() so the CSRF header is attached; the server stays the authority,
// the UI only hides what a role cannot do.
import { ApiError, api, badge, clear, el, fmtDate, fmtMoney, setCsrf } from '/app/assets/lib.js';

const root = document.getElementById('root');
const state = { me: null, mfa: null, orgs: [], org: null, access: null };
const ROLES = ['owner', 'admin', 'finance', 'developer', 'viewer'];
const SCOPES = [
  'org:read',
  'member:read',
  'invoice:read',
  'invoice:create',
  'invoice:cancel',
  'payment:read',
  'wallet:read',
  'ledger:read',
  'withdrawal:read',
  'withdrawal:create',
  'webhook:read',
  'webhook:manage',
];
const ASSETS = ['btc', 'ltc', 'eth', 'usdt-erc20', 'usdt-trc20', 'trx', 'xrp'];

// ---------------------------------------------------------------- helpers
function remember(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage may be blocked */
  }
}
function recall(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

const noticeBox = () => el('div', { 'aria-live': 'polite' });
function show(box, kind, message) {
  clear(box);
  if (message) box.append(el('div', { class: `notice ${kind}`, text: message }));
}

/** Run an async action; show failures in `box`; return undefined on failure. */
async function attempt(box, fn) {
  try {
    show(box, 'ok', '');
    return await fn();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && state.me) {
      state.me = null;
      go('#/login');
      return undefined;
    }
    show(box, 'error', e instanceof Error ? e.message : 'Something went wrong.');
    return undefined;
  }
}

function formData(form) {
  const out = {};
  for (const [k, v] of new FormData(form).entries()) if (typeof v === 'string') out[k] = v.trim();
  return out;
}

function field(label, name, opts = {}) {
  const input = opts.options
    ? el(
        'select',
        { name, required: opts.required },
        opts.options.map((o) => el('option', { value: o, text: o })),
      )
    : el('input', {
        name,
        type: opts.type ?? 'text',
        required: opts.required,
        autocomplete: opts.autocomplete ?? 'off',
        placeholder: opts.placeholder,
        inputmode: opts.inputmode,
        value: opts.value,
      });
  return el('label', { text: label }, input);
}

function table(columns, rows, empty = 'Nothing here yet.') {
  if (rows.length === 0) return el('p', { class: 'muted', text: empty });
  return el(
    'table',
    {},
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        columns.map((c) => el('th', { text: c.title })),
      ),
    ),
    el(
      'tbody',
      {},
      rows.map((r) =>
        el(
          'tr',
          {},
          columns.map((c) => el('td', { class: c.mono ? 'mono' : '' }, c.cell(r))),
        ),
      ),
    ),
  );
}

function secretNotice(title, value) {
  return el(
    'div',
    { class: 'notice secret' },
    el('strong', { text: title }),
    el('div', { class: 'mono', text: value }),
    el('div', { class: 'muted', text: 'Shown once. Copy it now.' }),
  );
}

const can = (permission) => state.access?.permissions.includes(permission) ?? false;
const orgPath = (suffix) => `/v1/organizations/${state.org.id}${suffix}`;
const isAdmin = () => state.me?.user.isPlatformAdmin === true;

function go(hash) {
  if (location.hash === hash) void route();
  else location.hash = hash;
}

// ------------------------------------------------------------------ shell
function shell(title, ...content) {
  clear(root);
  const links = [
    ['#/', 'Overview'],
    ['#/invoices', 'Invoices'],
    ['#/payments', 'Payments'],
    ['#/wallets', 'Wallets'],
    ['#/webhooks', 'Webhooks'],
    ['#/withdrawals', 'Withdrawals'],
    ['#/team', 'Team'],
    ['#/keys', 'API keys'],
    ['#/audit', 'Audit log'],
    ['#/security', 'Security'],
  ];
  if (isAdmin()) links.push(['#/admin', 'Admin']);
  const current = location.hash.split('?')[0] || '#/';
  const orgSelect = el(
    'select',
    { 'aria-label': 'Organization', onchange: (e) => void chooseOrg(e.target.value) },
    state.orgs.map((o) =>
      el('option', { value: o.id, text: o.name, selected: o.id === state.org?.id }),
    ),
  );
  root.append(
    el(
      'header',
      { class: 'top' },
      el('strong', { text: 'ActualPay' }),
      state.orgs.length ? orgSelect : null,
      el(
        'nav',
        {},
        links.map(([href, text]) =>
          el('a', {
            href,
            text,
            'aria-current':
              current === href || (href !== '#/' && current.startsWith(`${href}/`)) ? 'page' : null,
          }),
        ),
      ),
      el('span', { class: 'spacer' }),
      el('span', { class: 'muted', text: state.me?.user.email ?? '' }),
      el('button', { class: 'secondary', text: 'Sign out', onclick: () => void signOut() }),
    ),
    el('main', {}, el('h1', { text: title }), ...content),
  );
}

async function chooseOrg(id) {
  const org = state.orgs.find((o) => o.id === id);
  if (!org) return;
  state.org = org;
  remember('ap_org', org.id);
  state.access = await api('GET', orgPath('/access'));
  await route();
}

async function signOut() {
  try {
    await api('POST', '/v1/auth/logout');
  } catch {
    /* already signed out */
  }
  state.me = null;
  setCsrf(null);
  go('#/login');
}

// ------------------------------------------------------------ public views
function authCard(title, ...content) {
  clear(root);
  root.append(
    el('main', {}, el('div', { class: 'card narrow' }, el('h1', { text: title }), ...content)),
  );
}

function tokenFromHash() {
  const query = location.hash.split('?')[1] ?? '';
  return new URLSearchParams(query).get('token') ?? '';
}

function loginView() {
  const box = noticeBox();
  const form = el(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        const data = formData(form);
        const result = await attempt(box, () => api('POST', '/v1/auth/login', data));
        if (!result) return;
        if (result.status === 'mfa_required') return mfaStep(result.mfaToken);
        setCsrf(result.csrfToken);
        await boot();
      },
    },
    field('Email', 'email', { type: 'email', required: true, autocomplete: 'username' }),
    field('Password', 'password', {
      type: 'password',
      required: true,
      autocomplete: 'current-password',
    }),
    el('button', { type: 'submit', text: 'Sign in' }),
  );
  authCard(
    'Sign in',
    box,
    form,
    el(
      'p',
      {},
      el('a', { href: '#/register', text: 'Create an account' }),
      ' · ',
      el('a', { href: '#/forgot', text: 'Forgot password' }),
    ),
  );
}

function mfaStep(mfaToken) {
  const box = noticeBox();
  const form = el(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        const result = await attempt(box, () =>
          api('POST', '/v1/auth/login/mfa', { mfaToken, code: formData(form).code }),
        );
        if (!result) return;
        setCsrf(result.csrfToken);
        await boot();
      },
    },
    field('Authenticator or recovery code', 'code', {
      required: true,
      autocomplete: 'one-time-code',
      inputmode: 'numeric',
    }),
    el('button', { type: 'submit', text: 'Verify' }),
  );
  authCard('Two-factor authentication', box, form);
}

function registerView() {
  const box = noticeBox();
  const form = el(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        if (await attempt(box, () => api('POST', '/v1/auth/register', formData(form)))) {
          show(box, 'ok', 'Check your email for a verification link.');
          form.reset();
        }
      },
    },
    field('Name', 'displayName', { required: true, autocomplete: 'name' }),
    field('Email', 'email', { type: 'email', required: true, autocomplete: 'username' }),
    field('Password (at least 12 characters)', 'password', {
      type: 'password',
      required: true,
      autocomplete: 'new-password',
    }),
    el('button', { type: 'submit', text: 'Create account' }),
  );
  authCard(
    'Create account',
    box,
    form,
    el('p', {}, el('a', { href: '#/login', text: 'Back to sign in' })),
  );
}

function forgotView() {
  const box = noticeBox();
  const form = el(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        if (
          (await attempt(box, () => api('POST', '/v1/auth/password/forgot', formData(form)))) !==
          undefined
        )
          show(box, 'ok', 'If that address has an account, a reset link is on its way.');
      },
    },
    field('Email', 'email', { type: 'email', required: true, autocomplete: 'username' }),
    el('button', { type: 'submit', text: 'Send reset link' }),
  );
  authCard(
    'Reset password',
    box,
    form,
    el('p', {}, el('a', { href: '#/login', text: 'Back to sign in' })),
  );
}

function resetView() {
  const box = noticeBox();
  const token = tokenFromHash();
  const form = el(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        const r = await attempt(box, () =>
          api('POST', '/v1/auth/password/reset', {
            token,
            newPassword: formData(form).newPassword,
          }),
        );
        if (r !== undefined) go('#/login');
      },
    },
    field('New password', 'newPassword', {
      type: 'password',
      required: true,
      autocomplete: 'new-password',
    }),
    el('button', { type: 'submit', text: 'Set password' }),
  );
  authCard('Choose a new password', box, form);
}

async function verifyView() {
  const box = noticeBox();
  authCard('Verifying email', box, el('p', { class: 'muted', text: 'Working…' }));
  const ok = await attempt(box, () =>
    api('POST', '/v1/auth/verify-email', { token: tokenFromHash() }),
  );
  authCard(
    'Email verification',
    box,
    ok
      ? el('p', {}, 'Your email is verified. ', el('a', { href: '#/login', text: 'Sign in' }))
      : null,
  );
}

async function acceptView() {
  const box = noticeBox();
  authCard(
    'Join organization',
    box,
    el('button', {
      text: 'Accept invitation',
      onclick: async () => {
        if (
          (await attempt(box, () =>
            api('POST', '/v1/invitations/accept', { token: tokenFromHash() }),
          )) !== undefined
        ) {
          await boot();
        }
      },
    }),
  );
}

// ------------------------------------------------------------------ pages
async function overviewPage() {
  const box = noticeBox();
  shell('Overview', box);
  const main = root.querySelector('main');
  if (!state.org) {
    const form = el(
      'form',
      {
        onsubmit: async (event) => {
          event.preventDefault();
          if (await attempt(box, () => api('POST', '/v1/organizations', formData(form))))
            await boot();
        },
      },
      field('Organization name', 'name', { required: true }),
      el('button', { type: 'submit', text: 'Create organization' }),
    );
    main.append(
      el(
        'div',
        { class: 'card' },
        el('p', {
          text: 'You are not in an organization yet. Create one, or open an invitation link.',
        }),
        form,
      ),
    );
    return;
  }
  const [invoices, payments] = await Promise.all([
    attempt(box, () => api('GET', orgPath('/invoices?limit=10'))),
    can('payment:read')
      ? attempt(box, () => api('GET', orgPath('/payments?limit=10')))
      : Promise.resolve({ data: [] }),
  ]);
  main.append(
    el(
      'div',
      { class: 'card' },
      el(
        'p',
        {},
        `Signed in to `,
        el('strong', { text: state.org.name }),
        ` as ${state.access.role ?? 'member'}.`,
      ),
    ),
    el('h2', { text: 'Recent invoices' }),
    el('div', { class: 'card' }, invoiceTable(invoices?.data ?? [])),
    el('h2', { text: 'Recent payments' }),
    el('div', { class: 'card' }, paymentTable(payments?.data ?? [])),
  );
}

const invoiceTable = (rows) =>
  table(
    [
      { title: 'Created', cell: (r) => fmtDate(r.createdAt) },
      { title: 'Status', cell: (r) => badge(r.status) },
      { title: 'Amount', cell: (r) => fmtMoney(r.amountDue) },
      { title: 'Description', cell: (r) => r.description ?? r.externalId ?? '' },
      { title: '', cell: (r) => el('a', { href: `#/invoices/${r.id}`, text: 'Open' }) },
    ],
    rows,
    'No invoices yet.',
  );

const paymentTable = (rows) =>
  table(
    [
      { title: 'Detected', cell: (r) => fmtDate(r.detectedAt) },
      { title: 'Status', cell: (r) => badge(r.status) },
      { title: 'Amount', cell: (r) => fmtMoney(r.amount) },
      { title: 'Confirmations', cell: (r) => r.confirmations },
      { title: 'Transaction', mono: true, cell: (r) => r.txHash },
    ],
    rows,
    'No payments yet.',
  );

async function invoicesPage() {
  const box = noticeBox();
  shell('Invoices', box);
  const main = root.querySelector('main');
  const list = el('div', { class: 'card' });
  async function load() {
    const res = await attempt(box, () => api('GET', orgPath('/invoices?limit=50')));
    clear(list);
    list.append(invoiceTable(res?.data ?? []));
  }
  if (can('invoice:create')) {
    const form = el(
      'form',
      {
        onsubmit: async (event) => {
          event.preventDefault();
          const d = formData(form);
          const body = { asset: d.asset, amount: d.amount };
          if (d.description) body.description = d.description;
          if (d.externalId) body.externalId = d.externalId;
          const created = await attempt(box, () => api('POST', orgPath('/invoices'), body));
          if (created) go(`#/invoices/${created.id}`);
        },
      },
      el(
        'div',
        { class: 'row' },
        field('Asset', 'asset', { options: ASSETS, required: true }),
        field('Amount', 'amount', { required: true, inputmode: 'decimal', placeholder: '0.01' }),
        field('Description', 'description'),
        field('Your reference', 'externalId'),
        el('button', { type: 'submit', text: 'Create invoice' }),
      ),
    );
    main.append(el('h2', { text: 'New invoice' }), el('div', { class: 'card' }, form));
  }
  main.append(el('h2', { text: 'All invoices' }), list);
  await load();
}

async function invoiceDetail(id) {
  const box = noticeBox();
  shell('Invoice', box);
  const main = root.querySelector('main');
  const inv = await attempt(box, () => api('GET', orgPath(`/invoices/${encodeURIComponent(id)}`)));
  if (!inv) return;
  const kv = (k, v, mono) =>
    el('tr', {}, el('th', { text: k }), el('td', { class: mono ? 'mono' : '', text: v }));
  main.append(
    el(
      'div',
      { class: 'card' },
      el(
        'table',
        {},
        kv('Status', inv.status),
        kv('Amount due', fmtMoney(inv.amountDue)),
        kv('Confirmed', fmtMoney(inv.amountConfirmed)),
        kv('Pending', fmtMoney(inv.amountPending)),
        kv('Address', inv.deposit.address, true),
        inv.deposit.destinationTag === null
          ? null
          : kv('Destination tag', String(inv.deposit.destinationTag)),
        kv('Expires', fmtDate(inv.expiresAt)),
        kv('Paid late', inv.paidLate ? 'yes' : 'no'),
        kv('Customer link', inv.hostedUrl, true),
        kv('Description', inv.description ?? ''),
      ),
    ),
  );
  if (can('invoice:cancel') && ['open', 'partially_paid'].includes(inv.status))
    main.append(
      el('button', {
        class: 'danger',
        text: 'Cancel invoice',
        onclick: async () => {
          if (!confirm('Cancel this invoice? Funds already sent to it are still tracked.')) return;
          if (
            await attempt(box, () =>
              api('POST', orgPath(`/invoices/${encodeURIComponent(id)}/cancel`), {}),
            )
          )
            await route();
        },
      }),
    );
  main.append(
    el('h2', { text: 'Payments' }),
    el('div', { class: 'card' }, paymentTable(inv.payments)),
  );
}

async function paymentsPage() {
  const box = noticeBox();
  shell('Payments', box);
  const res = await attempt(box, () => api('GET', orgPath('/payments?limit=100')));
  root.querySelector('main').append(el('div', { class: 'card' }, paymentTable(res?.data ?? [])));
}

async function walletsPage() {
  const box = noticeBox();
  shell('Wallets', box);
  const main = root.querySelector('main');
  main.append(
    el('div', {
      class: 'notice',
      text: 'ActualPay only ever holds public keys (xpub) for deposits. Never paste a private key or seed phrase.',
    }),
  );
  const list = el('div', { class: 'card' });
  async function load() {
    const res = await attempt(box, () => api('GET', orgPath('/wallets')));
    clear(list);
    list.append(
      table(
        [
          { title: 'Label', cell: (w) => w.label },
          { title: 'Chain', cell: (w) => `${w.chain} (${w.network})` },
          { title: 'Status', cell: (w) => badge(w.status) },
          {
            title: 'Confirmed',
            cell: (w) => (w.confirmed ? badge('confirmed') : badge('unconfirmed')),
          },
          { title: 'Next index', cell: (w) => w.nextIndex },
          {
            title: '',
            cell: (w) =>
              el(
                'div',
                { class: 'actions' },
                can('wallet:manage') && !w.confirmed && w.status === 'active'
                  ? el('button', {
                      class: 'secondary',
                      text: 'Confirm first address',
                      onclick: async () => {
                        const address = prompt(
                          'Paste the FIRST receiving address shown by your own wallet app for this account:',
                        );
                        if (!address) return;
                        if (
                          await attempt(box, () =>
                            api('POST', orgPath(`/wallets/${w.id}/confirm`), {
                              address: address.trim(),
                            }),
                          )
                        )
                          await load();
                      },
                    })
                  : null,
                can('wallet:manage') && w.status === 'active'
                  ? el('button', {
                      class: 'danger',
                      text: 'Archive',
                      onclick: async () => {
                        if (
                          confirm('Archive this wallet? No new invoices will use it.') &&
                          (await attempt(box, () =>
                            api('POST', orgPath(`/wallets/${w.id}/archive`), {}),
                          ))
                        )
                          await load();
                      },
                    })
                  : null,
              ),
          },
        ],
        res?.data ?? [],
        'No wallets yet.',
      ),
    );
  }
  if (can('wallet:manage')) {
    const form = el(
      'form',
      {
        onsubmit: async (event) => {
          event.preventDefault();
          const d = formData(form);
          const body = { chain: d.chain, label: d.label };
          if (d.chain === 'xrpl') body.xrplAddress = d.key;
          else body.accountXpub = d.key;
          if (await attempt(box, () => api('POST', orgPath('/wallets'), body))) {
            form.reset();
            await load();
          }
        },
      },
      el(
        'div',
        { class: 'row' },
        field('Chain', 'chain', {
          options: ['bitcoin', 'litecoin', 'ethereum', 'tron', 'xrpl'],
          required: true,
        }),
        field('Label', 'label', { required: true }),
        field('Account xpub (or XRPL address)', 'key', { required: true }),
        el('button', { type: 'submit', text: 'Add wallet' }),
      ),
    );
    main.append(el('h2', { text: 'Add wallet' }), el('div', { class: 'card' }, form));
  }
  main.append(el('h2', { text: 'Your wallets' }), list);
  await load();
}

async function webhooksPage() {
  const box = noticeBox();
  shell('Webhooks', box);
  const main = root.querySelector('main');
  const secrets = el('div');
  const list = el('div', { class: 'card' });
  async function load() {
    const res = await attempt(box, () => api('GET', orgPath('/webhooks')));
    clear(list);
    list.append(
      table(
        [
          { title: 'URL', mono: true, cell: (w) => w.url },
          { title: 'Status', cell: (w) => badge(w.status) },
          { title: 'Failures', cell: (w) => String(w.consecutiveFailures) },
          {
            title: '',
            cell: (w) =>
              el(
                'div',
                { class: 'actions' },
                el('a', { href: `#/webhooks/${w.id}`, text: 'Deliveries' }),
                can('webhook:manage')
                  ? el('button', {
                      class: 'secondary',
                      text: 'Send test',
                      onclick: async () => {
                        if (
                          await attempt(box, () =>
                            api('POST', orgPath(`/webhooks/${w.id}/test`), {}),
                          )
                        )
                          show(box, 'ok', 'Test event queued.');
                      },
                    })
                  : null,
                can('webhook:manage')
                  ? el('button', {
                      class: 'secondary',
                      text: 'Rotate secret',
                      onclick: async () => {
                        const r = await attempt(box, () =>
                          api('POST', orgPath(`/webhooks/${w.id}/rotate-secret`), {}),
                        );
                        if (r) {
                          clear(secrets);
                          secrets.append(secretNotice('New signing secret', r.secret));
                          await load();
                        }
                      },
                    })
                  : null,
                can('webhook:manage')
                  ? el('button', {
                      class: 'danger',
                      text: 'Delete',
                      onclick: async () => {
                        if (
                          confirm('Delete this endpoint?') &&
                          (await attempt(box, () =>
                            api('DELETE', orgPath(`/webhooks/${w.id}`)),
                          )) !== undefined
                        )
                          await load();
                      },
                    })
                  : null,
              ),
          },
        ],
        res?.data ?? [],
        'No endpoints yet.',
      ),
    );
  }
  if (can('webhook:manage')) {
    const form = el(
      'form',
      {
        onsubmit: async (event) => {
          event.preventDefault();
          const d = formData(form);
          const r = await attempt(box, () =>
            api('POST', orgPath('/webhooks'), {
              url: d.url,
              ...(d.description ? { description: d.description } : {}),
            }),
          );
          if (r) {
            clear(secrets);
            secrets.append(secretNotice('Signing secret', r.secret));
            form.reset();
            await load();
          }
        },
      },
      el(
        'div',
        { class: 'row' },
        field('HTTPS URL', 'url', { type: 'url', required: true }),
        field('Description', 'description'),
        el('button', { type: 'submit', text: 'Add endpoint' }),
      ),
    );
    main.append(el('h2', { text: 'Add endpoint' }), el('div', { class: 'card' }, form));
  }
  main.append(secrets, el('h2', { text: 'Endpoints' }), list);
  await load();
}

async function deliveriesPage(id) {
  const box = noticeBox();
  shell('Webhook deliveries', box);
  const res = await attempt(box, () =>
    api('GET', orgPath(`/webhooks/${encodeURIComponent(id)}/deliveries?limit=50`)),
  );
  root.querySelector('main').append(
    el(
      'div',
      { class: 'card' },
      table(
        [
          { title: 'Event', cell: (d) => d.eventType },
          { title: 'Status', cell: (d) => badge(d.status) },
          { title: 'Attempts', cell: (d) => String(d.attempts ?? '') },
          { title: 'Last error', cell: (d) => d.lastError ?? '' },
          {
            title: '',
            cell: (d) =>
              can('webhook:manage')
                ? el('button', {
                    class: 'secondary',
                    text: 'Redeliver',
                    onclick: async () => {
                      if (
                        await attempt(box, () =>
                          api('POST', orgPath(`/webhook-deliveries/${d.id}/redeliver`), {}),
                        )
                      )
                        show(box, 'ok', 'Queued.');
                    },
                  })
                : null,
          },
        ],
        res?.data ?? [],
        'No deliveries yet.',
      ),
    ),
  );
}

async function withdrawalsPage() {
  const box = noticeBox();
  shell('Withdrawals', box);
  const main = root.querySelector('main');
  const first = await attempt(box, () => api('GET', orgPath('/withdrawals?limit=50')));
  if (!first) {
    main.append(
      el('p', {
        class: 'muted',
        text: 'Withdrawals are available only when the operator runs platform custody mode.',
      }),
    );
    return;
  }
  const destBox = el('div', { class: 'card' });
  const polBox = el('div', { class: 'card' });
  const wdBox = el('div', { class: 'card' });
  let destinations = [];
  async function load() {
    const [w, d, p] = await Promise.all([
      attempt(box, () => api('GET', orgPath('/withdrawals?limit=50'))),
      attempt(box, () => api('GET', orgPath('/withdrawal-destinations'))),
      attempt(box, () => api('GET', orgPath('/withdrawal-policies'))),
    ]);
    destinations = d?.data ?? [];
    clear(wdBox);
    clear(destBox);
    clear(polBox);
    wdBox.append(
      table(
        [
          { title: 'Created', cell: (r) => fmtDate(r.createdAt) },
          { title: 'Status', cell: (r) => badge(r.status) },
          { title: 'Amount', cell: (r) => fmtMoney(r.amount) },
          { title: 'To', mono: true, cell: (r) => r.destination.address },
          { title: 'Transaction', mono: true, cell: (r) => r.txid ?? '' },
          {
            title: '',
            cell: (r) =>
              el(
                'div',
                { class: 'actions' },
                can('withdrawal:approve') && r.status === 'pending_approval'
                  ? el('button', {
                      text: 'Approve',
                      onclick: async () => {
                        if (
                          confirm(
                            `Approve sending ${fmtMoney(r.amount)} to ${r.destination.address}?`,
                          ) &&
                          (await attempt(box, () =>
                            api('POST', orgPath(`/withdrawals/${r.id}/approve`), {}),
                          ))
                        )
                          await load();
                      },
                    })
                  : null,
                can('withdrawal:approve') && r.status === 'pending_approval'
                  ? el('button', {
                      class: 'danger',
                      text: 'Reject',
                      onclick: async () => {
                        const reason = prompt('Reason for rejecting:');
                        if (
                          reason &&
                          (await attempt(box, () =>
                            api('POST', orgPath(`/withdrawals/${r.id}/reject`), { reason }),
                          ))
                        )
                          await load();
                      },
                    })
                  : null,
                can('withdrawal:create') && ['pending_approval', 'approved'].includes(r.status)
                  ? el('button', {
                      class: 'secondary',
                      text: 'Cancel',
                      onclick: async () => {
                        if (
                          await attempt(box, () =>
                            api('POST', orgPath(`/withdrawals/${r.id}/cancel`), {}),
                          )
                        )
                          await load();
                      },
                    })
                  : null,
              ),
          },
        ],
        w?.data ?? [],
        'No withdrawals yet.',
      ),
    );
    destBox.append(
      table(
        [
          { title: 'Label', cell: (r) => r.label },
          { title: 'Chain', cell: (r) => r.chain },
          { title: 'Address', mono: true, cell: (r) => r.address },
          {
            title: 'Usable',
            cell: (r) =>
              r.revokedAt
                ? badge('revoked')
                : r.usable
                  ? badge('active')
                  : el('span', { class: 'muted', text: `after ${fmtDate(r.activeAt)}` }),
          },
          {
            title: '',
            cell: (r) =>
              can('settings:manage') && !r.revokedAt
                ? el('button', {
                    class: 'danger',
                    text: 'Revoke',
                    onclick: async () => {
                      if (
                        await attempt(box, () =>
                          api('POST', orgPath(`/withdrawal-destinations/${r.id}/revoke`), {}),
                        )
                      )
                        await load();
                    },
                  })
                : null,
          },
        ],
        destinations,
        'No destinations yet. Withdrawals can only go to registered addresses.',
      ),
    );
    polBox.append(
      table(
        [
          { title: 'Asset', cell: (r) => r.asset ?? r.assetId ?? '' },
          { title: 'Enabled', cell: (r) => (r.enabled ? 'yes' : 'no') },
          { title: 'Min', cell: (r) => fmtMoney(r.minAmount) },
          { title: 'Per withdrawal', cell: (r) => fmtMoney(r.maxPerWithdrawal) },
          { title: 'Per day', cell: (r) => fmtMoney(r.maxPerDay) },
          { title: 'Effective', cell: (r) => (r.inEffect ? 'now' : fmtDate(r.effectiveAt)) },
        ],
        p?.data ?? [],
        'No limits set: withdrawals are disabled for every asset.',
      ),
    );
  }
  if (can('withdrawal:create')) {
    const form = el(
      'form',
      {
        onsubmit: async (event) => {
          event.preventDefault();
          const d = formData(form);
          if (
            await attempt(box, () =>
              api('POST', orgPath('/withdrawals'), {
                asset: d.asset,
                amount: d.amount,
                destinationId: d.destinationId,
              }),
            )
          ) {
            form.reset();
            await load();
          }
        },
      },
      el(
        'div',
        { class: 'row' },
        field('Asset', 'asset', { options: ['btc', 'ltc', 'eth', 'usdt-erc20'], required: true }),
        field('Amount', 'amount', { required: true, inputmode: 'decimal' }),
        field('Destination id', 'destinationId', { required: true }),
        el('button', { type: 'submit', text: 'Request withdrawal' }),
      ),
      el('p', {
        class: 'muted',
        text: 'Funds are held immediately; a different person with two-factor authentication must approve.',
      }),
    );
    main.append(el('h2', { text: 'Request' }), el('div', { class: 'card' }, form));
  }
  main.append(
    el('h2', { text: 'Withdrawals' }),
    wdBox,
    el('h2', { text: 'Destinations' }),
    destBox,
  );
  if (can('settings:manage')) {
    const dform = el(
      'form',
      {
        onsubmit: async (event) => {
          event.preventDefault();
          if (
            await attempt(box, () =>
              api('POST', orgPath('/withdrawal-destinations'), formData(dform)),
            )
          ) {
            dform.reset();
            await load();
          }
        },
      },
      el(
        'div',
        { class: 'row' },
        field('Chain', 'chain', { options: ['bitcoin', 'litecoin', 'ethereum'], required: true }),
        field('Address', 'address', { required: true }),
        field('Label', 'label', { required: true }),
        el('button', { type: 'submit', text: 'Add destination' }),
      ),
    );
    const pform = el(
      'form',
      {
        onsubmit: async (event) => {
          event.preventDefault();
          const d = formData(pform);
          const r = await attempt(box, () =>
            api('PUT', orgPath(`/withdrawal-policies/${d.asset}`), {
              enabled: d.enabled === 'true',
              minAmount: d.minAmount,
              maxPerWithdrawal: d.maxPerWithdrawal,
              maxPerDay: d.maxPerDay,
            }),
          );
          if (r) {
            show(
              box,
              'ok',
              r.inEffect
                ? 'Limits updated.'
                : `Higher limits take effect ${fmtDate(r.effectiveAt)}.`,
            );
            await load();
          }
        },
      },
      el(
        'div',
        { class: 'row' },
        field('Asset', 'asset', { options: ['btc', 'ltc', 'eth', 'usdt-erc20'], required: true }),
        field('Enabled', 'enabled', { options: ['true', 'false'] }),
        field('Minimum', 'minAmount', { required: true }),
        field('Per withdrawal', 'maxPerWithdrawal', { required: true }),
        field('Per day', 'maxPerDay', { required: true }),
        el('button', { type: 'submit', text: 'Save limits' }),
      ),
    );
    main.append(el('div', { class: 'card' }, dform));
    main.append(el('h2', { text: 'Limits' }), polBox, el('div', { class: 'card' }, pform));
  } else main.append(el('h2', { text: 'Limits' }), polBox);
  await load();
}

async function teamPage() {
  const box = noticeBox();
  shell('Team', box);
  const main = root.querySelector('main');
  const members = el('div', { class: 'card' });
  const invites = el('div', { class: 'card' });
  async function load() {
    const [m, i] = await Promise.all([
      attempt(box, () => api('GET', orgPath('/members'))),
      can('member:manage')
        ? attempt(box, () => api('GET', orgPath('/invitations')))
        : Promise.resolve({ data: [] }),
    ]);
    clear(members);
    clear(invites);
    members.append(
      table(
        [
          { title: 'Name', cell: (r) => r.displayName },
          { title: 'Email', cell: (r) => r.email },
          { title: 'Role', cell: (r) => r.role },
          {
            title: '',
            cell: (r) =>
              can('member:manage') && r.userId !== state.me.user.id
                ? el('button', {
                    class: 'danger',
                    text: 'Remove',
                    onclick: async () => {
                      if (
                        confirm(`Remove ${r.email}?`) &&
                        (await attempt(box, () =>
                          api('DELETE', orgPath(`/members/${r.userId}`)),
                        )) !== undefined
                      )
                        await load();
                    },
                  })
                : null,
          },
        ],
        m?.data ?? [],
      ),
    );
    invites.append(
      table(
        [
          { title: 'Email', cell: (r) => r.email },
          { title: 'Role', cell: (r) => r.role },
          { title: 'Expires', cell: (r) => fmtDate(r.expiresAt) },
          {
            title: '',
            cell: (r) =>
              el('button', {
                class: 'secondary',
                text: 'Revoke',
                onclick: async () => {
                  if (
                    (await attempt(box, () => api('DELETE', orgPath(`/invitations/${r.id}`)))) !==
                    undefined
                  )
                    await load();
                },
              }),
          },
        ],
        i?.data ?? [],
        'No pending invitations.',
      ),
    );
  }
  main.append(el('h2', { text: 'Members' }), members);
  if (can('member:manage')) {
    const form = el(
      'form',
      {
        onsubmit: async (event) => {
          event.preventDefault();
          if (await attempt(box, () => api('POST', orgPath('/invitations'), formData(form)))) {
            show(box, 'ok', 'Invitation sent.');
            form.reset();
            await load();
          }
        },
      },
      el(
        'div',
        { class: 'row' },
        field('Email', 'email', { type: 'email', required: true }),
        field('Role', 'role', { options: ROLES, required: true }),
        el('button', { type: 'submit', text: 'Invite' }),
      ),
    );
    main.append(
      el('h2', { text: 'Invite' }),
      el('div', { class: 'card' }, form),
      el('h2', { text: 'Pending invitations' }),
      invites,
    );
  }
  await load();
}

async function keysPage() {
  const box = noticeBox();
  shell('API keys', box);
  const main = root.querySelector('main');
  const secrets = el('div');
  const list = el('div', { class: 'card' });
  async function load() {
    const res = await attempt(box, () => api('GET', orgPath('/api-keys')));
    clear(list);
    list.append(
      table(
        [
          { title: 'Name', cell: (k) => k.name },
          { title: 'Prefix', mono: true, cell: (k) => k.prefix },
          { title: 'Scopes', cell: (k) => k.scopes.join(', ') },
          { title: 'Last used', cell: (k) => fmtDate(k.lastUsedAt) },
          { title: 'Status', cell: (k) => badge(k.revokedAt ? 'revoked' : 'active') },
          {
            title: '',
            cell: (k) =>
              can('apikey:manage') && !k.revokedAt
                ? el(
                    'div',
                    { class: 'actions' },
                    el('button', {
                      class: 'secondary',
                      text: 'Rotate',
                      onclick: async () => {
                        const r = await attempt(box, () =>
                          api('POST', orgPath(`/api-keys/${k.id}/rotate`), {}),
                        );
                        if (r) {
                          clear(secrets);
                          secrets.append(secretNotice('New API key', r.key ?? r.secret ?? ''));
                          await load();
                        }
                      },
                    }),
                    el('button', {
                      class: 'danger',
                      text: 'Revoke',
                      onclick: async () => {
                        if (
                          confirm('Revoke this key? Integrations using it stop working.') &&
                          (await attempt(box, () =>
                            api('DELETE', orgPath(`/api-keys/${k.id}`)),
                          )) !== undefined
                        )
                          await load();
                      },
                    }),
                  )
                : null,
          },
        ],
        res?.data ?? [],
        'No API keys.',
      ),
    );
  }
  if (can('apikey:manage')) {
    const checks = SCOPES.map((s) =>
      el(
        'label',
        { class: 'check' },
        el('input', { type: 'checkbox', name: 'scope', value: s, checked: s.endsWith(':read') }),
        s,
      ),
    );
    const form = el(
      'form',
      {
        onsubmit: async (event) => {
          event.preventDefault();
          const scopes = [...form.querySelectorAll('input[name=scope]:checked')].map(
            (i) => i.value,
          );
          const r = await attempt(box, () =>
            api('POST', orgPath('/api-keys'), { name: formData(form).name, scopes }),
          );
          if (r) {
            clear(secrets);
            secrets.append(secretNotice('API key', r.key ?? r.secret ?? ''));
            form.reset();
            await load();
          }
        },
      },
      field('Name', 'name', { required: true }),
      el('div', { class: 'row' }, checks),
      el('button', { type: 'submit', text: 'Create key' }),
    );
    main.append(el('h2', { text: 'New key' }), el('div', { class: 'card' }, form));
  }
  main.append(secrets, el('h2', { text: 'Keys' }), list);
  await load();
}

async function auditPage() {
  const box = noticeBox();
  shell('Audit log', box);
  const res = await attempt(box, () => api('GET', orgPath('/audit-log?limit=100')));
  root.querySelector('main').append(
    el(
      'div',
      { class: 'card' },
      table(
        [
          { title: 'When', cell: (r) => fmtDate(r.occurredAt) },
          { title: 'Actor', cell: (r) => r.actorType },
          { title: 'Action', cell: (r) => r.action },
          {
            title: 'Target',
            mono: true,
            cell: (r) => (r.targetType ? `${r.targetType}:${r.targetId ?? ''}` : ''),
          },
          { title: 'IP', cell: (r) => r.ipAddress ?? '' },
        ],
        res?.data ?? [],
        'No entries (or you lack permission).',
      ),
    ),
  );
}

async function securityPage() {
  const box = noticeBox();
  shell('Security', box);
  const main = root.querySelector('main');
  const out = el('div');
  const mfa = el('div', { class: 'card' });
  function mfaView() {
    clear(mfa);
    if (state.mfa.enabled) {
      mfa.append(
        el(
          'p',
          {},
          'Two-factor authentication is ',
          badge('active'),
          ` (${state.mfa.remaining} recovery codes left).`,
        ),
      );
      const form = el(
        'form',
        {
          onsubmit: async (event) => {
            event.preventDefault();
            const r = await attempt(box, () =>
              api('POST', '/v1/me/mfa/recovery-codes', { code: formData(form).code }),
            );
            if (r) {
              clear(out);
              out.append(secretNotice('New recovery codes', r.recoveryCodes.join('  ')));
              await refreshMe();
              mfaView();
            }
          },
        },
        el(
          'div',
          { class: 'row' },
          field('Authenticator code', 'code', { required: true, inputmode: 'numeric' }),
          el('button', { class: 'secondary', type: 'submit', text: 'Replace recovery codes' }),
        ),
      );
      mfa.append(form);
    } else {
      mfa.append(
        el('p', {
          text: 'Not enabled. Withdrawals, wallets, platform administration and several settings require it.',
        }),
        el('button', {
          text: 'Set up authenticator app',
          onclick: async () => {
            const s = await attempt(box, () => api('POST', '/v1/me/mfa/totp/setup', {}));
            if (!s) return;
            clear(out);
            const form = el(
              'form',
              {
                onsubmit: async (event) => {
                  event.preventDefault();
                  const r = await attempt(box, () =>
                    api('POST', '/v1/me/mfa/totp/confirm', { code: formData(form).code }),
                  );
                  if (r) {
                    clear(out);
                    out.append(secretNotice('Recovery codes', r.recoveryCodes.join('  ')));
                    await refreshMe();
                    mfaView();
                  }
                },
              },
              field('Code from your app', 'code', { required: true, inputmode: 'numeric' }),
              el('button', { type: 'submit', text: 'Confirm' }),
            );
            out.append(
              el(
                'div',
                { class: 'card' },
                el('p', {
                  text: 'Add this key to your authenticator app (or open the link on a device that has one), then enter a code.',
                }),
                el('p', { class: 'mono', text: s.secret }),
                el('p', {}, el('a', { href: s.otpauthUri, text: 'Open in authenticator' })),
                form,
              ),
            );
          },
        }),
      );
    }
  }
  mfaView();
  const sessions = el('div', { class: 'card' });
  async function loadSessions() {
    const res = await attempt(box, () => api('GET', '/v1/me/sessions'));
    clear(sessions);
    sessions.append(
      table(
        [
          { title: 'Started', cell: (s) => fmtDate(s.createdAt) },
          { title: 'Last seen', cell: (s) => fmtDate(s.lastSeenAt) },
          { title: 'IP', cell: (s) => s.ipAddress ?? '' },
          { title: 'Device', cell: (s) => s.userAgent ?? '' },
          {
            title: '',
            cell: (s) =>
              s.current
                ? badge('this session')
                : el('button', {
                    class: 'danger',
                    text: 'Sign out',
                    onclick: async () => {
                      if (
                        (await attempt(box, () => api('DELETE', `/v1/me/sessions/${s.id}`))) !==
                        undefined
                      )
                        await loadSessions();
                    },
                  }),
          },
        ],
        res?.data ?? [],
      ),
    );
  }
  const pw = el(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        if (
          (await attempt(box, () => api('POST', '/v1/me/password', formData(pw)))) !== undefined
        ) {
          show(box, 'ok', 'Password changed. Other sessions were signed out.');
          pw.reset();
          await loadSessions();
        }
      },
    },
    el(
      'div',
      { class: 'row' },
      field('Current password', 'currentPassword', {
        type: 'password',
        required: true,
        autocomplete: 'current-password',
      }),
      field('New password', 'newPassword', {
        type: 'password',
        required: true,
        autocomplete: 'new-password',
      }),
      el('button', { type: 'submit', text: 'Change password' }),
    ),
  );
  main.append(
    el('h2', { text: 'Two-factor authentication' }),
    mfa,
    out,
    el('h2', { text: 'Password' }),
    el('div', { class: 'card' }, pw),
    el('h2', { text: 'Sessions' }),
    sessions,
  );
  await loadSessions();
}

async function adminPage() {
  const box = noticeBox();
  shell('Platform administration', box);
  const main = root.querySelector('main');
  if (!isAdmin()) {
    main.append(el('p', { text: 'Platform administrators only.' }));
    return;
  }
  const status = el('div', { class: 'card' });
  const hot = el('div', { class: 'card' });
  const issues = el('div', { class: 'card' });
  async function load() {
    const [s, h, i] = await Promise.all([
      attempt(box, () => api('GET', '/v1/admin/status')),
      attempt(box, () => api('GET', '/v1/admin/hot-wallets')),
      attempt(box, () => api('GET', '/v1/admin/issues?status=open')),
    ]);
    clear(status);
    clear(hot);
    clear(issues);
    if (s) {
      status.append(
        el(
          'p',
          {},
          `Custody mode: `,
          el('strong', { text: s.custodyMode }),
          ` · network: ${s.network} · withdrawals: `,
          s.withdrawalsPaused
            ? el('span', {
                class: 'badge bad',
                text: `PAUSED${s.pauseReason ? `: ${s.pauseReason}` : ''}`,
              })
            : badge('active'),
        ),
        el(
          'p',
          {},
          `Open issues: ${s.openIssues.critical} critical, ${s.openIssues.warning} warning`,
        ),
        table(
          [
            { title: 'Chain', cell: (c) => c.chain },
            { title: 'Synced', cell: (c) => (c.synced ? badge('active') : badge('failed')) },
            { title: 'Tip', cell: (c) => String(c.tipHeight ?? '') },
            { title: 'Scanned', cell: (c) => fmtDate(c.scannedAt) },
            { title: 'Error', cell: (c) => c.lastError ?? '' },
          ],
          s.chains,
          'No chain cursors yet.',
        ),
        s.withdrawalsPaused
          ? el('button', {
              text: 'Resume withdrawals',
              onclick: async () => {
                if (await attempt(box, () => api('POST', '/v1/admin/withdrawals/resume', {})))
                  await load();
              },
            })
          : el('button', {
              class: 'danger',
              text: 'Pause all withdrawals',
              onclick: async () => {
                const reason = prompt('Why are you pausing withdrawals?');
                if (
                  reason &&
                  (await attempt(box, () => api('POST', '/v1/admin/withdrawals/pause', { reason })))
                )
                  await load();
              },
            }),
      );
    }
    hot.append(
      table(
        [
          { title: 'Chain', cell: (r) => r.chain },
          { title: 'Address', mono: true, cell: (r) => r.address },
          { title: 'Label', cell: (r) => r.label },
          { title: 'Status', cell: (r) => badge(r.status) },
          {
            title: '',
            cell: (r) =>
              r.status === 'active'
                ? el('button', {
                    class: 'danger',
                    text: 'Retire',
                    onclick: async () => {
                      if (
                        confirm('Stop the signer paying from this wallet?') &&
                        (await attempt(box, () =>
                          api('POST', `/v1/admin/hot-wallets/${r.id}/retire`, {}),
                        ))
                      )
                        await load();
                    },
                  })
                : null,
          },
        ],
        h?.data ?? [],
        'No hot wallets registered.',
      ),
    );
    issues.append(
      table(
        [
          {
            title: 'Severity',
            cell: (r) => badge(r.severity === 'critical' ? 'failed' : 'pending'),
          },
          { title: 'Kind', cell: (r) => r.kind },
          { title: 'Summary', cell: (r) => r.summary },
          { title: 'Last seen', cell: (r) => fmtDate(r.lastSeenAt) },
          {
            title: '',
            cell: (r) =>
              el('button', {
                class: 'secondary',
                text: 'Resolve',
                onclick: async () => {
                  const note = prompt('What did you check and decide?');
                  if (
                    note &&
                    (await attempt(box, () =>
                      api('POST', `/v1/admin/issues/${r.id}/resolve`, { note }),
                    ))
                  )
                    await load();
                },
              }),
          },
        ],
        i?.data ?? [],
        'No open issues.',
      ),
    );
  }
  const hform = el(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        if (await attempt(box, () => api('POST', '/v1/admin/hot-wallets', formData(hform)))) {
          hform.reset();
          await load();
        }
      },
    },
    el(
      'div',
      { class: 'row' },
      field('Chain', 'chain', { options: ['bitcoin', 'litecoin', 'ethereum'], required: true }),
      field('Address printed by signer:init', 'address', { required: true }),
      field('Label', 'label', { required: true }),
      el('button', { type: 'submit', text: 'Register hot wallet' }),
    ),
  );
  const fform = el(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        const d = formData(fform);
        if (
          await attempt(box, () =>
            api('POST', '/v1/admin/platform-funding', {
              asset: d.asset,
              amount: d.amount,
              reference: d.reference,
            }),
          )
        ) {
          show(box, 'ok', 'Recorded.');
          fform.reset();
        }
      },
    },
    el(
      'div',
      { class: 'row' },
      field('Asset', 'asset', { options: ['btc', 'ltc', 'eth', 'usdt-erc20'], required: true }),
      field('Amount you added', 'amount', { required: true }),
      field('Reference (tx hash)', 'reference', { required: true }),
      el('button', { type: 'submit', text: 'Record funding' }),
    ),
  );
  main.append(
    el('h2', { text: 'Status' }),
    status,
    el('h2', { text: 'Hot wallets' }),
    hot,
    el('div', { class: 'card' }, hform),
    el('h2', { text: 'Record gas / fee funding' }),
    el(
      'div',
      { class: 'card' },
      fform,
      el('p', {
        class: 'muted',
        text: 'Only record coins you actually sent to the hot wallet. This tells the books the platform can absorb network fees.',
      }),
    ),
    el('h2', { text: 'Open issues' }),
    issues,
  );
  await load();
}

// ---------------------------------------------------------------- routing
async function refreshMe() {
  const me = await api('GET', '/v1/me');
  state.me = me;
  state.mfa = { enabled: me.mfaEnabled, remaining: me.recoveryCodesRemaining };
  setCsrf(me.csrfToken);
}

async function boot() {
  try {
    await refreshMe();
  } catch {
    state.me = null;
    return route();
  }
  const orgs = await api('GET', '/v1/me/organizations');
  state.orgs = orgs.data;
  const saved = recall('ap_org');
  state.org = state.orgs.find((o) => o.id === saved) ?? state.orgs[0] ?? null;
  state.access = state.org ? await api('GET', orgPath('/access')) : null;
  if (
    !location.hash ||
    location.hash.startsWith('#/login') ||
    location.hash.startsWith('#/register')
  )
    location.hash = '#/';
  return route();
}

const PUBLIC = {
  '#/login': loginView,
  '#/register': registerView,
  '#/forgot': forgotView,
  '#/reset': resetView,
  '#/verify': verifyView,
  '#/accept': acceptView,
};

async function route() {
  const hash = location.hash || '#/';
  const path = hash.split('?')[0];
  if (PUBLIC[path] && (!state.me || path === '#/verify' || path === '#/reset'))
    return void (await PUBLIC[path]());
  if (!state.me) return void loginView();
  if (path === '#/accept') return void (await acceptView());
  const needsOrg = !['#/', '#/security', '#/admin'].includes(path);
  if (needsOrg && !state.org) return void (await overviewPage());
  const segments = path.split('/').filter(Boolean); // ['#', page, id]
  const id = segments[2];
  switch (segments[1] ?? '') {
    case '':
      return void (await overviewPage());
    case 'invoices':
      return void (id ? await invoiceDetail(id) : await invoicesPage());
    case 'payments':
      return void (await paymentsPage());
    case 'wallets':
      return void (await walletsPage());
    case 'webhooks':
      return void (id ? await deliveriesPage(id) : await webhooksPage());
    case 'withdrawals':
      return void (await withdrawalsPage());
    case 'team':
      return void (await teamPage());
    case 'keys':
      return void (await keysPage());
    case 'audit':
      return void (await auditPage());
    case 'security':
      return void (await securityPage());
    case 'admin':
      return void (await adminPage());
    default:
      return void (await overviewPage());
  }
}

window.addEventListener('hashchange', () => void route());
await boot();
