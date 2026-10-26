import { useInView } from './hooks';
import { Term } from './ui';

// Why the bank never matches an order, in two short scenes that play once when seen (CSS, transform and opacity;
// the connectors draw with stroke-dashoffset). 1: a ₹1,000 order splits into what reaches the bank and what Razorpay
// keeps. 2: several orders, each already net of fees, arrive as ONE bank line two business days later. Figures are
// illustrative (2% fee, 18% GST on the fee) and add up to the paisa; reduced motion shows the last frame.

const ORDERS = [
  { ref: 'ORD-1001', net: '₹976.40' },
  { ref: 'ORD-1002', net: '₹2,392.18' },
  { ref: 'ORD-1003', net: '₹585.84' },
];

export function MoneyStory() {
  const [ref, seen] = useInView<HTMLElement>();
  return (
    <figure ref={ref} className={`card money-story ${seen ? 'in' : ''}`}>
      <div className="ms-scene ms-split">
        <p className="ms-step">1 · One order</p>
        <div className="ms-row">
          <span>Your customer pays</span>
          <b>₹1,000.00</b>
        </div>
        <div
          className="ms-bar"
          role="img"
          aria-label="₹1,000.00 splits: ₹976.40 reaches your bank, ₹23.60 is Razorpay's fee and the GST on it"
        >
          <span className="ms-net" />
          <span className="ms-fee" />
        </div>
        <div className="ms-legend">
          <span className="ms-l net">
            <i /> To your bank <b>₹976.40</b>
          </span>
          <span className="ms-l fee">
            <i /> <Term k="fee">Fee</Term> ₹20.00 + <Term k="gstOnFee">GST on fee</Term> ₹3.60{' '}
            <b>₹23.60</b>
          </span>
        </div>
      </div>

      <div className="ms-scene ms-merge">
        <p className="ms-step">2 · Many orders, one bank line</p>
        <div className="ms-merge-grid">
          <ul className="ms-orders">
            {ORDERS.map((o, i) => (
              <li key={o.ref} style={{ transitionDelay: `${1300 + i * 120}ms` }}>
                <span>{o.ref}</span>
                <b>{o.net}</b>
              </li>
            ))}
          </ul>
          <svg
            className="ms-lines"
            viewBox="0 0 60 120"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path d="M0 20 C 30 20, 30 60, 60 60" />
            <path d="M0 60 L 60 60" />
            <path d="M0 100 C 30 100, 30 60, 60 60" />
          </svg>
          <div className="ms-bank">
            <span className="ms-day">
              <Term k="t2">T+2</Term>
            </span>
            <b>₹3,954.42</b>
            <span>
              NEFT · <Term k="utr">UTR</Term> AXISN26102800417
            </span>
          </div>
        </div>
      </div>
      <figcaption>
        Illustrative: 2% fee plus 18% GST on the fee. Real rates depend on the plan.
      </figcaption>
    </figure>
  );
}
