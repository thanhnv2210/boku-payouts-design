// Status colour categories — used by SimulationViewer to colour-code states
export const STATUS_KIND = {
  PENDING:                 'neutral',
  PENDING_COMPLIANCE:      'warn',
  PENDING_MANUAL_REVIEW:   'warn',
  FUND_PULLING:            'warn',
  SUBMITTED:               'neutral',
  SUBMITTED_UNCONFIRMED:   'warn',
  SETTLED:                 'success',
  CANCELLED:               'neutral',
  REJECTED_COMPLIANCE:     'danger',
  FUND_PULL_FAILED:        'danger',
  FAILED:                  'danger',
  RETURNED:                'danger',
  REFUND_REQUIRED:         'warn',
  REFUND_PENDING:          'warn',
  REFUNDED:                'success',
  REFUND_FAILED:           'danger',
}

// Each step: { status, triggeredBy, delayMs, note }
// delayMs = simulated pause before this step fires (mimics real async timing)
export const SCENARIOS = [
  {
    id: 'happy-path',
    title: 'Happy Path — Pull-and-Pay',
    description: 'Compliance passes, fund pull succeeds, disbursement settles. Full production flow.',
    steps: [
      { status: 'PENDING',            triggeredBy: 'api',                  delayMs: 0,    note: '202 Accepted — DB insert + Kafka publish in <50ms' },
      { status: 'PENDING_COMPLIANCE', triggeredBy: 'compliance-service',   delayMs: 600,  note: 'Fraud screening + AML scan running. No funds moved.' },
      { status: 'FUND_PULLING',       triggeredBy: 'compliance-service',   delayMs: 2200, note: 'Compliance passed. Fund Pull Worker debiting caller account.' },
      { status: 'SUBMITTED',          triggeredBy: 'fund-pull-worker',     delayMs: 2400, note: 'Funds are with Boku. Disbursement Worker calling partner rail.' },
      { status: 'SETTLED',            triggeredBy: 'disbursement-worker',  delayMs: 4200, note: 'Partner rail confirmed. Funds delivered to beneficiary. ✓' },
    ],
  },
  {
    id: 'compliance-rejected',
    title: 'Compliance Rejected — Hard AML Hit',
    description: 'Sanctions match found during AML scan. Payout blocked before any funds move.',
    steps: [
      { status: 'PENDING',               triggeredBy: 'api',               delayMs: 0,    note: '202 Accepted' },
      { status: 'PENDING_COMPLIANCE',    triggeredBy: 'compliance-service', delayMs: 600, note: 'Fraud check passes. AML/sanctions scan running.' },
      { status: 'REJECTED_COMPLIANCE',   triggeredBy: 'compliance-service', delayMs: 3100, note: 'Hard hit: SANCTIONS_MATCH. Terminal — no funds moved, no refund needed. May trigger regulatory reporting.' },
    ],
  },
  {
    id: 'manual-review',
    title: 'Manual Review — Soft AML Hit → Approved',
    description: 'Partial name match triggers human review. Reviewer approves; flow resumes.',
    steps: [
      { status: 'PENDING',               triggeredBy: 'api',                delayMs: 0,    note: '202 Accepted' },
      { status: 'PENDING_COMPLIANCE',    triggeredBy: 'compliance-service', delayMs: 600,  note: 'Fraud check passes. AML scan running.' },
      { status: 'PENDING_MANUAL_REVIEW', triggeredBy: 'compliance-service', delayMs: 2800, note: 'Soft hit: PARTIAL_MATCH. Queued for human review. Auto-reject at 24h if no decision.' },
      { status: 'FUND_PULLING',          triggeredBy: 'manual-review',      delayMs: 3000, note: 'Reviewer approved. Flow resumes — Fund Pull Worker debiting caller.' },
      { status: 'SUBMITTED',             triggeredBy: 'fund-pull-worker',   delayMs: 2400, note: 'Funds with Boku. Disbursement Worker submitting to rail.' },
      { status: 'SETTLED',               triggeredBy: 'disbursement-worker',delayMs: 4000, note: 'Settled. ✓' },
    ],
  },
  {
    id: 'fund-pull-failed',
    title: 'Fund Pull Failed',
    description: 'Compliance passes but the caller\'s account debit fails. No funds moved — no refund needed.',
    steps: [
      { status: 'PENDING',            triggeredBy: 'api',                  delayMs: 0,    note: '202 Accepted' },
      { status: 'PENDING_COMPLIANCE', triggeredBy: 'compliance-service',   delayMs: 600,  note: 'Compliance passes.' },
      { status: 'FUND_PULLING',       triggeredBy: 'compliance-service',   delayMs: 2200, note: 'Fund Pull Worker debiting caller account.' },
      { status: 'FUND_PULL_FAILED',   triggeredBy: 'fund-pull-worker',     delayMs: 3500, note: 'INSUFFICIENT_FUNDS — caller account debit failed. Terminal. No funds moved — no refund required.' },
    ],
  },
  {
    id: 'failed-refund-batch',
    title: 'Failed Disbursement → Batch Refund',
    description: 'Rail rejects after SUBMITTED. REFUND_REQUIRED flagged; Refund Batch Job executes safely.',
    steps: [
      { status: 'PENDING',            triggeredBy: 'api',                  delayMs: 0,    note: '202 Accepted' },
      { status: 'PENDING_COMPLIANCE', triggeredBy: 'compliance-service',   delayMs: 600,  note: 'Compliance passes.' },
      { status: 'FUND_PULLING',       triggeredBy: 'compliance-service',   delayMs: 2200, note: 'Funds pulled from caller.' },
      { status: 'SUBMITTED',          triggeredBy: 'fund-pull-worker',     delayMs: 2400, note: 'Funds with Boku. Disbursement Worker submitting.' },
      { status: 'FAILED',             triggeredBy: 'disbursement-worker',  delayMs: 5000, note: 'BENEFICIARY_ACCOUNT_INVALID — rail rejected. Funds still with Boku.' },
      { status: 'REFUND_REQUIRED',    triggeredBy: 'disbursement-worker',  delayMs: 200,  note: 'Flagged for batch refund. Decouples failure detection from execution.' },
      { status: 'REFUND_PENDING',     triggeredBy: 'refund-batch-job',     delayMs: 4000, note: 'Refund Batch Job picked up via SELECT FOR UPDATE SKIP LOCKED. Calling payment rail.' },
      { status: 'REFUNDED',           triggeredBy: 'refund-batch-job',     delayMs: 3800, note: 'Refund settled. Caller funds returned. Audit trail: pulled → failed → refunded. ✓' },
    ],
  },
  {
    id: 'unconfirmed-resolved',
    title: 'SUBMITTED_UNCONFIRMED → Resolved',
    description: 'Connection drops mid-rail-call. Partner-reference lookup resolves outcome safely.',
    steps: [
      { status: 'PENDING',                 triggeredBy: 'api',                 delayMs: 0,    note: '202 Accepted' },
      { status: 'PENDING_COMPLIANCE',      triggeredBy: 'compliance-service',  delayMs: 600,  note: 'Compliance passes.' },
      { status: 'FUND_PULLING',            triggeredBy: 'compliance-service',  delayMs: 2200, note: 'Funds pulled.' },
      { status: 'SUBMITTED',               triggeredBy: 'fund-pull-worker',    delayMs: 2400, note: 'Disbursement Worker calling partner rail.' },
      { status: 'SUBMITTED_UNCONFIRMED',   triggeredBy: 'disbursement-worker', delayMs: 5000, note: 'Connection dropped — outcome unknown. Do NOT refund. Do NOT failover. Querying partner via client_reference (Idempotency-Key).' },
      { status: 'SETTLED',                 triggeredBy: 'disbursement-worker', delayMs: 3000, note: 'Partner lookup resolved: SETTLED. No double payment — lookup used, not guess. ✓' },
    ],
  },
  {
    id: 'refund-failed',
    title: 'Refund Failed — Zero-Tolerance',
    description: 'Disbursement fails and the refund also fails. Money with Boku. Page oncall immediately.',
    steps: [
      { status: 'PENDING',            triggeredBy: 'api',                 delayMs: 0,    note: '202 Accepted' },
      { status: 'PENDING_COMPLIANCE', triggeredBy: 'compliance-service',  delayMs: 600,  note: 'Compliance passes.' },
      { status: 'FUND_PULLING',       triggeredBy: 'compliance-service',  delayMs: 2200, note: 'Funds pulled.' },
      { status: 'SUBMITTED',          triggeredBy: 'fund-pull-worker',    delayMs: 2400, note: 'Disbursement Worker submitting.' },
      { status: 'FAILED',             triggeredBy: 'disbursement-worker', delayMs: 5000, note: 'Rail rejected. Funds still with Boku.' },
      { status: 'REFUND_REQUIRED',    triggeredBy: 'disbursement-worker', delayMs: 200,  note: 'Flagged for refund.' },
      { status: 'REFUND_PENDING',     triggeredBy: 'refund-batch-job',    delayMs: 4000, note: 'Refund Batch Job executing refund call.' },
      { status: 'REFUND_FAILED',      triggeredBy: 'refund-batch-job',    delayMs: 4500, note: '🚨 REFUND_FAILED — money is with Boku, held by neither party. ALERT: REFUND_FAILED_ANY fired. Page oncall immediately. No acknowledgement window. Manual reconciliation required.' },
    ],
  },
]
