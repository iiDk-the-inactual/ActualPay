// Hosted checkout for one invoice (/pay/:publicId) or payment link (/pay/link/:publicId).
import { api, clear, el, fmtDate, badge } from '/app/assets/lib.js';

const root = document.getElementById('root');
const parts = location.pathname.split('/').filter(Boolean); // pay, [link], id
const isLink = parts[1] === 'link';
const publicId = parts[isLink ? 2 : 1] ?? '';
let timer = null;

function row(label, value, mono) {
  return el(
    'tr',
    {},
    el('th', { text: label }),
    el('td', { class: mono ? 'mono' : '', text: value }),
  );
}

function renderInvoice(inv) {
  clear(root);
  const done = inv.status === 'paid';
  const open = ['open', 'partially_paid', 'processing'].includes(inv.status);
  root.append(
    el(
      'div',
      { class: 'card' },
      el('p', { class: 'muted', text: inv.merchant }),
      el('div', {
        class: 'big',
        text: `${inv.amountDue.amount} ${inv.amountDue.asset.toUpperCase()}`,
      }),
      el('p', {}, badge(inv.status), ' ', inv.description ?? ''),
    ),
  );
  if (done) {
    root.append(el('div', { class: 'notice ok', text: 'Payment received. Thank you.' }));
  } else if (inv.status === 'expired' || inv.status === 'cancelled') {
    root.append(
      el('div', {
        class: 'notice error',
        text: `This invoice is ${inv.status}. Do not send funds to it.`,
      }),
    );
  }
  if (open) {
    root.append(
      el('div', {
        class: 'notice',
        text: `Send exactly the amount shown, on the ${inv.deposit.chain} network (${inv.deposit.network}). Payments are confirmed on chain and can take a few minutes.`,
      }),
      el(
        'div',
        { class: 'card' },
        el(
          'table',
          {},
          row('Address', inv.deposit.address, true),
          inv.deposit.destinationTag === null
            ? null
            : row('Destination tag (required)', String(inv.deposit.destinationTag), true),
          row('Pending', `${inv.amountPending.amount} ${inv.amountPending.asset.toUpperCase()}`),
          row(
            'Confirmed',
            `${inv.amountConfirmed.amount} ${inv.amountConfirmed.asset.toUpperCase()}`,
          ),
          row('Expires', fmtDate(inv.expiresAt)),
        ),
        inv.deposit.paymentUri
          ? el('p', {}, el('a', { href: inv.deposit.paymentUri, text: 'Open in wallet app' }))
          : null,
      ),
    );
  }
  if (done || inv.status === 'expired' || inv.status === 'cancelled') stop();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function fail(message) {
  stop();
  clear(root);
  root.append(el('div', { class: 'notice error', text: message }));
}

async function loadInvoice(id) {
  try {
    renderInvoice(await api('GET', `/v1/public/invoices/${encodeURIComponent(id)}`));
  } catch (e) {
    fail(e.status === 404 ? 'Invoice not found.' : e.message);
  }
}

async function loadLink() {
  try {
    const link = await api('GET', `/v1/public/payment-links/${encodeURIComponent(publicId)}`);
    clear(root);
    root.append(
      el(
        'div',
        { class: 'card' },
        el('p', { class: 'muted', text: link.merchant }),
        el('h1', { text: link.title }),
        el('p', { text: link.description ?? '' }),
        el('p', { class: 'big', text: `${link.amount.amount} ${link.amount.asset.toUpperCase()}` }),
        el('button', {
          type: 'button',
          text: 'Continue to payment',
          onclick: async () => {
            try {
              const created = await api(
                'POST',
                `/v1/public/payment-links/${encodeURIComponent(publicId)}/invoices`,
                {},
              );
              location.assign(`/pay/${encodeURIComponent(created.publicId)}`);
            } catch (e) {
              fail(e.message);
            }
          },
        }),
      ),
    );
  } catch (e) {
    fail(e.status === 404 ? 'Payment link not found.' : e.message);
  }
}

if (!publicId) fail('Invoice not found.');
else if (isLink) await loadLink();
else {
  await loadInvoice(publicId);
  timer = setInterval(() => void loadInvoice(publicId), 8000);
}
