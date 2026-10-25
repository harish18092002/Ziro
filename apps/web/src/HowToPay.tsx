import { CopyChip } from './CopyBlock';
import { Icon } from './Icons';

/**
 * The instructions for making a test payment, written for someone who has never opened Razorpay's test
 * window. The values come from Razorpay's own test-card and test-UPI pages.
 */
export function HowToPay() {
  return (
    <div className="howto">
      <ol className="guide-steps">
        <li>
          <b>Open the payment page.</b> It opens in a new tab, so you keep your place here.
          <div className="actions">
            <a className="button primary" href="/pay.html" target="_blank" rel="noreferrer">
              <Icon name="rupee" size={16} /> Make a test payment
            </a>
          </div>
        </li>
        <li>
          <b>Enter an amount</b> from ₹1 to ₹10,000. Leave the order number empty and Ziro makes one
          up (like <code>ORD-261026-9F3A</code>).
        </li>
        <li>
          <b>Pay in Razorpay’s window</b> with the test details on the right: pick <b>UPI</b>, type
          the ID and press <b>Pay</b>.
        </li>
        <li>
          <b>Come back to this tab.</b> The payment appears in the list below. Make three or four,
          with different amounts.
        </li>
      </ol>

      <aside className="testdata" aria-label="Test details to type in Razorpay’s window">
        <h4>Test details</h4>
        <dl>
          <div>
            <dt>UPI that succeeds</dt>
            <dd>
              <CopyChip text="success@razorpay" label="the success UPI ID" />
            </dd>
          </div>
          <div>
            <dt>UPI that fails</dt>
            <dd>
              <CopyChip text="failure@razorpay" label="the failure UPI ID" />
              <span className="muted"> to see a failed payment</span>
            </dd>
          </div>
          <div>
            <dt>Card that succeeds</dt>
            <dd>
              <CopyChip text="4100 2800 0000 1007" label="the test card number" />
              <span className="muted"> any future expiry, any CVV, then any 4 to 10 digit OTP</span>
            </dd>
          </div>
        </dl>
        <p className="muted">From Razorpay’s test-payment pages. Nothing here moves real money.</p>
      </aside>
    </div>
  );
}
