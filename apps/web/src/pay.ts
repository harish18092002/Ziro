// The payment page: make an order in YOUR Razorpay test account and pay it in Razorpay's own test window.
// Refunds live in the test-account page, which looks at a payment before asking Razorpay to refund it. This is
// a plain page (no framework) so that the one script that must talk to Razorpay's Checkout stays small and
// easy to read. Everything shown from the network is put on the page as text, never as markup.
import './theme.css';
import './base.css';
import './pay.css';
import { rupeesToPaise, showPaise } from './pay-math';

interface Status {
  source: string;
  ready: boolean;
  keyId: string | null;
  importsOpen: boolean;
}
interface Order {
  orderId: string;
  amountPaise: number;
  receipt: string;
  keyId: string | null;
}
interface CheckoutSuccess {
  razorpay_payment_id: string;
}
interface CheckoutInstance {
  open(): void;
  on(event: string, handler: (response: unknown) => void): void;
}
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => CheckoutInstance;
  }
}

const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`#${id} is missing from the page`);
  return found as T;
}

// `?theme=dark` for one visit, like the console. Otherwise the system setting applies through theme.css.
const asked = new URLSearchParams(window.location.search).get('theme');
if (asked === 'light' || asked === 'dark') document.documentElement.dataset['theme'] = asked;

const stateLine = element<HTMLParagraphElement>('state');
const form = element<HTMLFormElement>('form');
const amountInput = element<HTMLInputElement>('amount');
const receiptInput = element<HTMLInputElement>('receipt');
const payButton = element<HTMLButtonElement>('pay');
const problemLine = element<HTMLParagraphElement>('problem');
const madeSection = element<HTMLElement>('made');
const madeList = element<HTMLUListElement>('list');

function say(text: string, tone: 'ok' | 'bad' | 'plain' = 'plain'): void {
  stateLine.textContent = text;
  stateLine.className = `state ${tone}`;
}

function problem(text: string | null): void {
  problemLine.hidden = text === null;
  problemLine.textContent = text ?? '';
}

async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text === '' ? null : JSON.parse(text);
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = (data as { message?: string | string[] } | null)?.message;
    throw new Error(
      Array.isArray(message) ? message.join('; ') : (message ?? `${res.status} ${res.statusText}`),
    );
  }
  return data as T;
}

let checkoutLoading: Promise<void> | null = null;
function loadCheckout(): Promise<void> {
  if (window.Razorpay !== undefined) return Promise.resolve();
  checkoutLoading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CHECKOUT_SRC;
    script.onload = () => resolve();
    script.onerror = () => {
      checkoutLoading = null;
      reject(new Error("Razorpay's payment window could not be loaded. Check your connection."));
    };
    document.head.append(script);
  });
  return checkoutLoading;
}

function addMade(entry: { paymentId: string; receipt: string; amountPaise: number }): void {
  madeSection.hidden = false;
  const item = document.createElement('li');

  const main = document.createElement('span');
  main.className = 'made-main';
  const receipt = document.createElement('b');
  receipt.textContent = entry.receipt;
  main.append(receipt, ` ${showPaise(entry.amountPaise)}`);

  const id = document.createElement('code');
  id.textContent = entry.paymentId;

  item.append(main, id);
  madeList.prepend(item);
}

// Every [data-copy] button copies its value and says so for two seconds.
for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-copy]')) {
  button.addEventListener('click', () => {
    const label = button.textContent;
    navigator.clipboard.writeText(button.dataset['copy'] ?? '').then(
      () => (button.textContent = 'Copied'),
      () => (button.textContent = 'Select and copy'),
    );
    setTimeout(() => (button.textContent = label), 2000);
  });
}

async function payNow(): Promise<void> {
  problem(null);
  const amountPaise = rupeesToPaise(amountInput.value);
  if (amountPaise === null) {
    problem('Enter an amount from 1 to 10,000 rupees, with at most two decimals.');
    return;
  }
  const receipt = receiptInput.value.trim();
  payButton.disabled = true;
  try {
    const order = await api<Order>('POST', '/razorpay/test-orders', {
      amountPaise,
      ...(receipt === '' ? {} : { receipt }),
    });
    if (order.keyId === null) throw new Error('The server did not give a Razorpay test key.');
    await loadCheckout();
    const Checkout = window.Razorpay;
    if (Checkout === undefined) throw new Error("Razorpay's payment window did not start.");

    const window_ = new Checkout({
      key: order.keyId,
      order_id: order.orderId,
      amount: order.amountPaise,
      currency: 'INR',
      name: 'Ziro test payment',
      description: `Order ${order.receipt}`,
      theme: { color: '#256abf' },
      handler: (response: CheckoutSuccess) => {
        addMade({
          paymentId: response.razorpay_payment_id,
          receipt: order.receipt,
          amountPaise: order.amountPaise,
        });
        say(
          `Paid ${showPaise(order.amountPaise)} for ${order.receipt}. It is in your test account now: make another, or go back to see it.`,
          'ok',
        );
        payButton.disabled = false;
      },
      modal: { ondismiss: () => (payButton.disabled = false) },
    });
    window_.on('payment.failed', (response) => {
      const description = (response as { error?: { description?: string } } | null)?.error
        ?.description;
      problem(`The payment failed${description === undefined ? '' : `: ${description}`}.`);
      payButton.disabled = false;
    });
    window_.open();
  } catch (error) {
    problem(error instanceof Error ? error.message : String(error));
    payButton.disabled = false;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void payNow();
});

api<Status>('GET', '/razorpay/status').then(
  (status) => {
    if (!status.ready) {
      say(
        'Test mode is not set up yet. Open "Your test account" (top right) for the two-minute set-up.',
        'bad',
      );
    } else if (!status.importsOpen) {
      say(
        status.ready
          ? 'DEMO_MODE=true switches payments off. Set DEMO_MODE=false in .env and restart the server.'
          : 'This is the public demo: making test payments is switched off here.',
        'bad',
      );
    } else {
      say(`Test mode is on. Key ${status.keyId ?? ''}. Nothing here moves real money.`, 'ok');
      form.hidden = false;
    }
  },
  (error: unknown) => {
    say(
      error instanceof Error && /sign in/i.test(error.message)
        ? 'Sign in on the main page first, then come back here.'
        : `Could not reach the server: ${error instanceof Error ? error.message : String(error)}`,
      'bad',
    );
  },
);
