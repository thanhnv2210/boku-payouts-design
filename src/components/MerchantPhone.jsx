import { useEffect, useRef, useState } from 'react'
import { STATUS_KIND } from '../data/scenarios'

// Which statuses generate a visible webhook notification to the merchant
const WEBHOOK_EVENTS = {
  PENDING:                 null,            // just the 202 — no webhook
  PENDING_COMPLIANCE:      null,            // internal — no webhook
  PENDING_MANUAL_REVIEW:   null,            // internal — no webhook
  FUND_PULLING:            null,            // internal — no webhook
  SUBMITTED:               'payout.submitted',
  SUBMITTED_UNCONFIRMED:   null,            // internal — no webhook yet
  SETTLED:                 'payout.settled',
  CANCELLED:               'payout.cancelled',
  REJECTED_COMPLIANCE:     'payout.failed',
  FUND_PULL_FAILED:        'payout.failed',
  FAILED:                  'payout.failed',
  RETURNED:                'payout.returned',
  REFUND_REQUIRED:         null,            // internal — no webhook
  REFUND_PENDING:          null,            // internal — no webhook
  REFUNDED:                'payout.refunded',
  REFUND_FAILED:           'payout.refund_failed',
}

const STATUS_LABEL = {
  PENDING:                 'Processing…',
  PENDING_COMPLIANCE:      'Compliance check',
  PENDING_MANUAL_REVIEW:   'Under review',
  FUND_PULLING:            'Collecting funds',
  SUBMITTED:               'Submitted to bank',
  SUBMITTED_UNCONFIRMED:   'Confirming…',
  SETTLED:                 'Payment sent ✓',
  CANCELLED:               'Cancelled',
  REJECTED_COMPLIANCE:     'Payment blocked',
  FUND_PULL_FAILED:        'Debit failed',
  FAILED:                  'Payment failed',
  RETURNED:                'Returned',
  REFUND_REQUIRED:         'Refund queued',
  REFUND_PENDING:          'Refund in progress',
  REFUNDED:                'Refunded ✓',
  REFUND_FAILED:           'Refund failed',
}

// Merchant-facing description for each webhook event
const EVENT_DESC = {
  'payout.submitted':     'Your payout has been submitted to the payment rail.',
  'payout.settled':       'Funds successfully delivered to your beneficiary.',
  'payout.failed':        'The payout could not be completed.',
  'payout.cancelled':     'Payout was cancelled before processing.',
  'payout.returned':      'Funds were returned by the receiving bank.',
  'payout.refunded':      'Funds have been returned to your account.',
  'payout.refund_failed': 'Refund attempt failed. Our team is investigating.',
}

function PhoneStatusBar() {
  const [time, setTime] = useState(() => {
    const now = new Date()
    return `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`
  })
  return (
    <div className="phone-status-bar">
      <span className="phone-time">{time}</span>
      <span className="phone-icons">▲ WiFi ■</span>
    </div>
  )
}

export default function MerchantPhone({ scenario, currentStep, done, auditRows = [] }) {
  const timelineBottomRef = useRef(null)
  const [toastVisible, setToastVisible] = useState(false)
  const [toastMsg, setToastMsg]         = useState('')
  const [toastKind, setToastKind]       = useState('neutral')
  const prevDoneRef = useRef(false)

  const currentStatus = currentStep >= 0 ? scenario.steps[currentStep].status : null
  const kind = currentStatus ? (STATUS_KIND[currentStatus] || 'neutral') : 'neutral'

  // Collect webhook events from all steps fired so far, with simulated timestamps from auditRows
  const webhookEvents = []
  if (currentStep >= 0) {
    for (let i = 0; i <= currentStep; i++) {
      const s = scenario.steps[i]
      const event = WEBHOOK_EVENTS[s.status]
      if (event) {
        const at = auditRows[i]?.at ?? null
        webhookEvents.push({ event, status: s.status, step: i, at })
      }
    }
  }

  // Show toast on terminal state
  useEffect(() => {
    if (done && !prevDoneRef.current) {
      const last = scenario.steps[scenario.steps.length - 1]
      const event = WEBHOOK_EVENTS[last.status]
      if (event) {
        setToastMsg(EVENT_DESC[event] || event)
        setToastKind(STATUS_KIND[last.status] || 'neutral')
        setToastVisible(true)
        const t = setTimeout(() => setToastVisible(false), 4000)
        return () => clearTimeout(t)
      }
    }
    prevDoneRef.current = done
  }, [done, scenario])

  // Reset toast on scenario change / reset
  useEffect(() => {
    setToastVisible(false)
    prevDoneRef.current = false
  }, [scenario])

  useEffect(() => {
    if (timelineBottomRef.current) {
      timelineBottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [webhookEvents.length])

  // Amount / beneficiary from scenario id — fixed demo values
  const amount = 'USD 1,250.00'
  const beneficiary = 'Maria Santos'
  const payoutId = `pyo_DEMO_${scenario.id.slice(0, 4).toUpperCase()}`

  return (
    <div className="phone-wrap">
      <div className="phone-label">Merchant App</div>
      <div className="phone-frame">
        {/* Notch */}
        <div className="phone-notch" />

        <div className="phone-screen">
          <PhoneStatusBar />

          {/* App header */}
          <div className="phone-app-header">
            <span className="phone-app-back">←</span>
            <span className="phone-app-title">Payout Detail</span>
            <span />
          </div>

          {/* Status card */}
          <div className={`phone-card phone-card--${kind}`}>
            <div className="phone-card-amount">{amount}</div>
            <div className="phone-card-to">To: {beneficiary}</div>
            <div className={`phone-card-status phone-badge--${kind}`}>
              {currentStatus ? STATUS_LABEL[currentStatus] : 'Initialising…'}
            </div>
            <div className="phone-card-id">{payoutId}</div>
          </div>

          {/* Webhook timeline */}
          <div className="phone-section-label">Notifications</div>
          <div className="phone-timeline">
            {webhookEvents.length === 0 && (
              <div className="phone-timeline-empty">No notifications yet</div>
            )}
            {webhookEvents.map((ev, i) => (
              <div
                key={`${ev.step}-${ev.event}`}
                className={`phone-event phone-event--${STATUS_KIND[ev.status] || 'neutral'} ${i === webhookEvents.length - 1 ? 'phone-event--new' : ''}`}
              >
                <span className="phone-event-dot" />
                <div className="phone-event-body">
                  <div className="phone-event-name">{ev.event}</div>
                  <div className="phone-event-desc">{EVENT_DESC[ev.event]}</div>
                  {ev.at && <div className="phone-event-at">{ev.at}</div>}
                </div>
              </div>
            ))}
            <div ref={timelineBottomRef} />
          </div>
        </div>

        {/* Home indicator */}
        <div className="phone-home-bar" />
      </div>

      {/* Toast overlay — rendered outside phone-frame so it floats above */}
      {toastVisible && (
        <div className={`phone-toast phone-toast--${toastKind}`}>
          {toastMsg}
        </div>
      )}
    </div>
  )
}
