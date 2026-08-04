# Payouts API — High-Level Design

> Take-home task for Boku (Banking & Settlement). Prepared for HM walkthrough.
> Structure: Requirements & assumptions → Terminology → Implementation principles (endpoints, schemas, state machine, failure handling, compliance gate, fund pull, refund, status tracking, idempotency) → AWS mapping → Tech stack → Stakeholder coverage.

---

## 1. Requirements + Assumptions

### Requirement (as given)
Design a Payouts API that lets a caller submit a payout to a beneficiary, exposes clear endpoints and request/response contracts, handles duplicate requests / failed disbursements / partial failures, and lets the caller track status after submission.

### Assumptions (4 — each resolves a scenario the task leaves open)

**Assumption 1 — Submission is synchronous, settlement is not.**
*Scenario:* A caller hits `POST /payouts`. The actual movement of funds through a downstream bank/card/wallet rail can take seconds to multiple business days.
*Assumption:* The API acknowledges **acceptance** synchronously (`202 Accepted` + a payout ID), and the caller tracks the real outcome asynchronously (poll or webhook). The acceptance path must complete well within the API Gateway's timeout limit (e.g. 30s) — and it does, because the acceptance write is a thin DB insert + fire-and-forget Kafka publish, designed to complete in under 50ms P95.
*Alternative considered:* Fully synchronous confirm-then-respond — rejected because it couples API availability to partner rail latency/uptime, which is exactly the kind of coupling DASH's FX/partner failover design was built to avoid.

**Assumption 2 — Single-payout is the primary unit; batch is additive, not foundational.**
*Scenario:* Boku's JD doesn't specify whether payouts arrive one at a time (e.g. a marketplace paying one seller) or as a payroll-style batch (e.g. paying 10,000 gig workers at once).
*Assumption:* Core resource is **one payout = one API call**, with a separate `POST /payouts/batch` as an additive wrapper that fans out into individual payout records — cleaner to get single-resource idempotency and state tracking right first, then compose, rather than starting from batch semantics and bolting on single-payout as a special case.
*Alternative considered:* Batch-first design (file upload, job ID) — plausible if Boku's merchant customers are payroll-style. Worth confirming live.

**Assumption 3 — Rail selection is the platform's responsibility, not the caller's.**
*Scenario:* Boku is global (65 countries) — a payout to Singapore vs. Kenya vs. the US rides completely different rails (local bank transfer, mobile money, card push).
*Assumption:* The caller specifies **what** and **to whom** (amount, currency, beneficiary), not **how** (which rail/partner). Rail selection and failover is the platform's job, mirroring how DASH's FX orchestration picked and failed over between Thunes/Tranglo/WU without the caller knowing.

**Why not caller-selects-rail?** This is a real, legitimate model — Stripe, Wise, and some B2B treasury platforms expose it explicitly. I'm ruling it out as the default here because Boku's value proposition reads differently: 65-country coverage, global corridor management, partner relationships the merchant doesn't have. Letting a caller specify `"rail": "LOCAL_BANK_SG"` leaks internal partner topology into a public contract and couples the API to internal infra decisions. I'd keep an optional `preferred_rail` hint for edge cases. **Worth confirming live** — see open questions below.

**Assumption 4 — Pull-and-Pay as the primary funding model, showcased in full.**
*Scenario:* Before Boku can disburse to a beneficiary, the money has to come from somewhere. Two real-world models exist:

| Model | How it works | Design impact |
|---|---|---|
| **Prefunded wallet** | Merchant tops up a Boku-held balance in advance. `POST /payouts` checks + debits wallet atomically. | Synchronous `INSUFFICIENT_FUNDS` rejection. Needs wallet resource. Simpler failure handling — no refund flow. |
| **Pull-and-Pay** (primary) | `POST /payouts` accepts async; the platform debits the caller's account via direct debit mandate as a dedicated async step before disbursement. | Two failure surfaces (pull fails, disbursement fails). More complex — but demonstrates the full design including compliance gate, explicit fund pull state, and refund flow. |

*Why Pull-and-Pay as the showcase:* it forces the complete design — compliance gate, `FUND_PULLING` as a separate state, refund path, and the key insight that separating fund pull from disbursement eliminates the need for a `funds_pulled` flag entirely. Every failure from `SUBMITTED` unconditionally triggers a refund. This is more representative of a real platform's complexity than the prefunded model, which collapses multiple concerns into a simpler but less instructive flow.

*Prefunded wallet remains valid* — worth confirming with the interviewer which model Boku actually uses. If prefunded, the design simplifies: remove `FUND_PULLING`, `FUND_PULL_FAILED`, and the refund flow; add wallet debit in the acceptance transaction and synchronous `INSUFFICIENT_FUNDS`.

### Open questions for the walkthrough

**Q1 — Managed payout service or connectivity layer?**

| Model | Who picks the rail | Design impact |
|---|---|---|
| **Managed service** (assumed) | Platform, invisibly | Rail selection + failover internal; caller API stays simple |
| **Connectivity layer** | Caller specifies upfront | Rail selection removed entirely; `SUBMITTED_UNCONFIRMED` stays, failover-blocking in §3.9 goes away |

**Q2 — If platform-picks-rail: priority-ordered fallback or genuinely multi-rail?**
- **Priority-ordered fallback** — circuit breaker trips on primary, switches to next in list. Most common. §3.9 ambiguous-failure guard applies in full.
- **Genuinely multi-rail** — scoring per payout (cost, speed, success rate). Needs a selection/scoring step not currently designed.

**Q3 — Prefunded wallet or Pull-and-Pay?**
- Prefunded → remove `FUND_PULLING` / refund flow, add wallet debit in acceptance transaction, synchronous `INSUFFICIENT_FUNDS`
- Pull-and-Pay → current design; two failure surfaces, refund flow, explicit fund pull state

---

## 2. Solution Terminologies

| Term | Definition |
|---|---|
| **Payout** | A single instruction to move funds from Boku's client (the caller) to a named beneficiary. |
| **Beneficiary** | The recipient of a payout — a bank account, card, or wallet identifier plus owner details. |
| **Disbursement / Rail / Partner** | The downstream network actually moving the money (bank transfer network, card scheme, mobile wallet). A payout is *fulfilled by* a disbursement. |
| **Idempotency Key** | A caller-supplied unique token guaranteeing that retrying the same request never creates a second payout. |
| **Payout State Machine** | The explicit set of statuses a payout moves through, with defined legal transitions (see §3.3). |
| **Terminal state** | A state the payout cannot leave (`SETTLED`, `FAILED`, `RETURNED`, `REFUNDED`, `REFUND_FAILED`, `FUND_PULL_FAILED`, `REJECTED_COMPLIANCE`, `CANCELLED`). |
| **Partial failure** | In a batch, some payouts succeed and others fail independently — the batch itself has no single pass/fail outcome. |
| **Reconciliation** | Matching Boku's internal payout records against the partner's own settlement/callback records to catch silent discrepancies. |
| **Ledger entry** | An immutable, append-only record of a funds-movement event — source of truth. The mutable `status` column is a projection of the ledger. |
| **Audit table** | Append-only `payout_audit` table — one row per state transition, recording `from_status`, `to_status`, `duration_ms`, `triggered_by`, `correlation_id`. Drives per-step SLA monitoring and proactive alerting. |
| **Quote** | An ephemeral, short-TTL FX rate lock + preview, obtained *before* a payout is created — not part of the payout ledger. |
| **Partner reference** | The Idempotency-Key reused on every outbound rail call — enables outcome lookup when a connection drops mid-call, without guessing. |
| **Correlation ID** | An ID threaded through every log line, Kafka event, and span for one specific execution attempt — distinct from the Idempotency-Key, which spans every retry of one logical payout. |
| **Webhook / callback** | An async, platform-initiated push notification to the caller when a payout's status changes. Convenience layer — never the source of truth. |
| **Compliance gate** | Async fraud + AML/sanctions checks that run after `202 Accepted` but before any funds move. Payout sits in `PENDING_COMPLIANCE` until the gate passes or blocks. |
| **Hard hit / Soft hit** | AML screening outcomes. Hard hit = definitive sanctions match → auto-reject to `REJECTED_COMPLIANCE`. Soft hit = partial match or PEP detected → `PENDING_MANUAL_REVIEW`. |
| **Wallet / prefunded balance** | A Boku-held balance belonging to the caller, debited atomically at acceptance in the prefunded model. |
| **Pull-and-Pay** | Funding model where the platform debits the caller's account via direct debit mandate as a dedicated async step (`FUND_PULLING`) before disbursement. |
| **`PENDING_COMPLIANCE`** | Non-terminal: payout accepted, fraud + AML checks running, no funds moved. |
| **`PENDING_MANUAL_REVIEW`** | Non-terminal: AML soft hit — human reviewer must approve or reject before payout proceeds. |
| **`REJECTED_COMPLIANCE`** | Terminal: compliance blocked the payout. Legal/policy block — distinct from `FAILED` (rail issue). No funds moved, no refund required. May trigger regulatory reporting. |
| **`FUND_PULLING`** | Non-terminal (Pull-and-Pay): debiting caller's account. Separating this from `SUBMITTED` means reaching `SUBMITTED` guarantees funds are with Boku — no flag check needed anywhere. |
| **`FUND_PULL_FAILED`** | Terminal: caller's account debit failed (insufficient funds, mandate revoked). No funds moved — no refund required. |
| **`SUBMITTED_UNCONFIRMED`** | Non-terminal: connection to partner rail dropped mid-call — outcome unknown. Must resolve via partner-reference lookup before any failover or refund decision. |
| **`REFUND_REQUIRED`** | Non-terminal (Pull-and-Pay): disbursement failed after `SUBMITTED` — flagged for refund. Boku holds caller's money. Picked up by the scheduled Refund Batch Job. Separating this from `REFUND_PENDING` decouples failure detection from execution — see §3.11 trade-off. |
| **`REFUND_PENDING`** | Non-terminal (Pull-and-Pay): Refund Batch Job has picked up the record and called the payment rail to push funds back. Refund is in-flight. |
| **`REFUNDED`** | Terminal: caller's funds successfully returned. Audit trail: pull → failed → refund_required → refund_pending → refunded. |
| **`REFUND_FAILED`** | Terminal: refund also failed. Money with Boku — neither beneficiary nor caller holds it. Page oncall immediately. |

---

## 3. Implementation Principles

### 3.1 API surface (endpoints + reasoning)

| Endpoint | Purpose | Reasoning |
|---|---|---|
| `POST /payouts` | Submit a single payout | Core resource creation. Requires `Idempotency-Key` header. Returns `202` — acceptance only, not settlement. |
| `GET /payouts/{payoutId}` | Fetch current status + full lifecycle history | Primary status-tracking mechanism. Always correct — source of truth even if all webhooks failed. |
| `GET /payouts?external_ref={ref}` | Look up a payout by the caller's own reference | Recovery path when the caller crashed before persisting `payoutId` — keyed on their identifier, not ours. |
| `POST /payouts/batch` | Submit multiple payouts as one call | Additive per Assumption 2; fans out to N independent payout records, each with its own state machine. |
| `GET /payouts/batch/{batchId}` | Batch-level rollup status | Surfaces `succeeded/failed/pending` counts without hiding individual outcomes — partial failure is the expected case. |
| `POST /payouts/{payoutId}/cancel` | Cancel a payout still in a cancellable state | State-machine guard, not a soft delete. Cancellable only before any external API call has been made — see §3.10. |
| `POST /webhooks/subscriptions` | Register a callback URL for status-change events | Push-based tracking, complementary to polling. HMAC-signed deliveries. |
| `POST /quotes` | Lock an FX rate + preview before creating a payout | Optional pre-step for cross-currency payouts. TTL-bound — referencing an expired quote returns `QUOTE_EXPIRED`. |
| `GET /quotes/{quoteId}` | Fetch a previously issued quote | Check remaining validity before submitting the payout that references it. |
| `POST /wallets/topup` | Merchant tops up their Boku-held balance | Prefunded model only — named but out of scope for this design iteration. |

`DELETE /payouts/{id}` is deliberately absent — funds-movement records are never deleted, only transitioned to terminal states.

### 3.2 Request / response structures

**Submit a payout**
```
POST /payouts
Idempotency-Key: 6f1c1e2a-...   (required — caller-generated, stable across all retries)

{
  "external_reference": "invoice-8842",
  "amount": { "value": "150.00", "currency": "SGD" },
  "beneficiary": {
    "type": "BANK_ACCOUNT",
    "name": "Jane Tan",
    "account_number": "1234567890",
    "bank_code": "7171",
    "country": "SG"
  },
  "purpose": "SUPPLIER_PAYMENT",
  "quote_id": "qte_DEMO_001",      (optional — FX rate lock for cross-currency)
  "metadata": { "order_id": "ord_9981" }
}
```

**Response — 202 Accepted** (acceptance only, not settlement)
```
{
  "payout_id": "pyo_01HZX...",
  "status": "PENDING",
  "external_reference": "invoice-8842",
  "amount": { "value": "150.00", "currency": "SGD" },
  "created_at": "2026-08-03T09:00:00Z",
  "links": { "self": "/payouts/pyo_01HZX..." }
}
```

**Status fetch — `GET /payouts/{id}` — full lifecycle history**
```
{
  "payout_id": "pyo_01HZX...",
  "status": "SETTLED",
  "external_reference": "invoice-8842",
  "amount": { "value": "150.00", "currency": "SGD" },
  "settled_at": "2026-08-03T09:00:09Z",
  "history": [
    { "status": "PENDING",             "at": "2026-08-03T09:00:00Z" },
    { "status": "PENDING_COMPLIANCE",  "at": "2026-08-03T09:00:00Z", "duration_ms": 480 },
    { "status": "FUND_PULLING",        "at": "2026-08-03T09:00:02Z", "duration_ms": 1840 },
    { "status": "SUBMITTED",           "at": "2026-08-03T09:00:04Z", "duration_ms": 2100 },
    { "status": "SETTLED",             "at": "2026-08-03T09:00:09Z", "duration_ms": 3650 }
  ]
}
```

**Failed payout with refund**
```
{
  "payout_id": "pyo_02HZX...",
  "status": "REFUNDED",
  "failure_reason": "BENEFICIARY_ACCOUNT_INVALID",
  "history": [
    { "status": "PENDING",            "at": "2026-08-03T09:05:00Z" },
    { "status": "PENDING_COMPLIANCE", "at": "2026-08-03T09:05:00Z", "duration_ms": 510 },
    { "status": "FUND_PULLING",       "at": "2026-08-03T09:05:02Z", "duration_ms": 1920 },
    { "status": "SUBMITTED",          "at": "2026-08-03T09:05:04Z", "duration_ms": 2050 },
    { "status": "FAILED",             "at": "2026-08-03T09:05:09Z", "duration_ms": 4300,
      "reason": "BENEFICIARY_ACCOUNT_INVALID" },
    { "status": "REFUND_PENDING",     "at": "2026-08-03T09:05:09Z", "duration_ms": 180 },
    { "status": "REFUNDED",           "at": "2026-08-03T09:05:13Z", "duration_ms": 3600 }
  ]
}
```

Every error response uses a consistent shape (`error_code`, `message`, `request_id`) — callers branch on `error_code` programmatically, never on prose.

### 3.3 Payout state machine

```
PENDING → PENDING_COMPLIANCE → FUND_PULLING → SUBMITTED → SETTLED    (happy path, compliance + pull-and-pay)
PENDING → FUND_PULLING → SUBMITTED → SETTLED                          (no compliance gate required)
PENDING → SUBMITTED → SETTLED                                         (prefunded wallet — no fund pull step)

PENDING_COMPLIANCE → FUND_PULLING                                     (fraud + AML pass)
PENDING_COMPLIANCE → REJECTED_COMPLIANCE                              (hard hit — terminal, no funds moved)
PENDING_COMPLIANCE → PENDING_MANUAL_REVIEW                            (soft hit — human review)
PENDING_MANUAL_REVIEW → FUND_PULLING | REJECTED_COMPLIANCE            (reviewer approves or rejects)

FUND_PULLING → SUBMITTED                                              (pull succeeds — funds with Boku)
FUND_PULLING → FUND_PULL_FAILED                                       (pull fails — terminal, no refund)

SUBMITTED → SETTLED                                                   (rail confirms — terminal)
SUBMITTED → FAILED                                                    (rail rejects non-retryable — terminal)
SUBMITTED → RETURNED                                                  (rail accepted, later reversed — terminal)
SUBMITTED → SUBMITTED_UNCONFIRMED                                     (connection dropped — outcome unknown)
SUBMITTED_UNCONFIRMED → SETTLED | FAILED                              (partner-reference lookup only — never guessed)

FAILED   → REFUND_REQUIRED                                            (SUBMITTED reached = funds always with Boku — flagged for batch refund)
RETURNED → REFUND_REQUIRED                                            (rail reversed after pull — flagged for batch refund)
REFUND_REQUIRED → REFUND_PENDING                                      (Refund Batch Job picks up the record, calls payment rail)
REFUND_PENDING  → REFUNDED                                            (refund to caller succeeds — terminal)
REFUND_PENDING  → REFUND_FAILED                                       (refund fails — terminal, manual intervention)

PENDING → CANCELLED                                                   (caller cancels before submission — terminal)
```

See the **State Machine diagram** in the sidebar for the full visual.

**Why `FUND_PULLING` as a separate state eliminates a flag:**
Once `SUBMITTED` is reached, funds are *always* with Boku — by definition. No `funds_pulled` boolean needed anywhere. Every `FAILED` or `RETURNED` from `SUBMITTED` unconditionally triggers a refund. The disbursement worker does exactly one thing: send money to the beneficiary.

**Compliance gate — placement and sequencing:**
Runs after `202 Accepted`, before any funds move. Two checks in sequence:
- **Fraud screening** — velocity, amount anomalies, beneficiary pattern. Fast, automated, binary.
- **AML / sanctions scan** — OFAC, UN, EU, local lists. Hard hit → `REJECTED_COMPLIANCE` (auto). Soft hit → `PENDING_MANUAL_REVIEW` (human decision).

`REJECTED_COMPLIANCE` is deliberately separate from `FAILED`. `FAILED` = rail issue, potentially retryable. `REJECTED_COMPLIANCE` = legal/policy block, no retry will change the outcome, may trigger regulatory reporting obligation.

**Refund trigger — simplified by the `FUND_PULLING` separation:**

| State | Refund needed? | Why |
|---|---|---|
| `REJECTED_COMPLIANCE` | No | Compliance runs before any funds move |
| `FUND_PULL_FAILED` | No | Caller's account was never debited |
| `FAILED` (from `SUBMITTED`) | Yes — flags `REFUND_REQUIRED` | `SUBMITTED` means funds are with Boku; batch job executes |
| `RETURNED` (from `SUBMITTED`) | Yes — flags `REFUND_REQUIRED` | Rail reversed after Boku held funds; batch job executes |
| `SUBMITTED_UNCONFIRMED → FAILED` | Yes — after lookup resolves | Do not flag `REFUND_REQUIRED` while outcome is unknown |

`REFUND_FAILED` is the most serious ops state — money is with Boku, held by neither party. Must page oncall immediately with no acknowledgement window. See the **Traffic Model, SLA & Proactive Alerting** doc for full alert definitions.

**Single-writer guard — two layers:**

The `UPDATE ... WHERE status = 'X'` guard handles the common case: a duplicate Kafka event arriving on the same worker type. PostgreSQL's row locking ensures the second writer blocks, re-reads the already-advanced status, and the `WHERE` clause eliminates it as a no-op.

But that is not enough. A different scenario exists: **two independent writer types** — for example, a partner callback arriving at the same time as a midnight batch reconciliation sweep — both read `SUBMITTED` before either commits. Both pass the `WHERE status = 'SUBMITTED'` check, both attempt to write `SETTLED`, both insert an audit row. The result is a duplicate `SETTLED` record and a double webhook delivery.

**Optimistic locking with a `version` column closes this gap:**

```sql
-- payouts table gets a version column:
version  INTEGER NOT NULL DEFAULT 0

-- Every state transition reads the current version first, then:
UPDATE payouts
SET    status  = 'SETTLED',
       version = version + 1
WHERE  payout_id = ?
  AND  status    = 'SUBMITTED'
  AND  version   = ?          -- the version the worker read

-- Check rows_affected:
-- 1 → this worker won the race → proceed to INSERT payout_audit + publish event
-- 0 → another writer got there first → discard, do not insert audit row, do not publish
```

The `version` column is also written into `payout_audit` — so the audit trail reflects which version increment produced each row, making concurrent write attempts traceable even under load. The reconciliation job and the callback handler become safe to run simultaneously: exactly one will advance the version; the other will read `rows_affected = 0` and stop cleanly.

`SUBMITTED_UNCONFIRMED` is deliberately non-terminal and deliberately not `FAILED` — a connection drop tells you nothing about whether the partner processed it. Do not refund. Do not failover. Query the partner using the `client_reference` (= Idempotency-Key) to resolve. See §3.9.

### 3.4 Failure handling

**Duplicate payout requests.**
The `Idempotency-Key` is stored with a uniqueness constraint in the same Postgres transaction as the payout INSERT. A retried request with the same key returns the original `202` response — the caller cannot tell whether it was new or a replay, which is the point. Redis provides a sub-millisecond fast-path check; Postgres is the durable guarantee. Keys expire after 24h.

**API Gateway timeout (30s).**
The acceptance path (`POST /payouts`) is designed to complete in under 50ms P95 — a thin DB write + fire-and-forget Kafka publish. If the gateway times out before the `202` reaches the caller, the payout may or may not have been created. The caller retries with the same `Idempotency-Key` — dedup returns the original response if it was created, creates it fresh if not. No new state or logic needed; the Idempotency-Key already handles this.

**Compliance rejection.**
Hard sanctions match → `REJECTED_COMPLIANCE` (terminal, auto). Soft hit → `PENDING_MANUAL_REVIEW` (human review, SLA-bound). Both states confirm no funds moved — no refund required.

**Fund pull failure.**
`INSUFFICIENT_FUNDS` or `MANDATE_REVOKED` → `FUND_PULL_FAILED` (terminal). No money left the caller — no refund required. Caller is notified via webhook with a structured `failure_reason`.

**Failed disbursements.**
Rail rejection (invalid account, sanctions hold, partner liquidity) → `FAILED` (terminal). Because `SUBMITTED` was reached, funds are with Boku — refund flow triggers unconditionally. Transient errors (timeout, 5xx) retry with exponential backoff + jitter; exhausted retries land in a DLQ. Circuit breaker trips per-rail so one partner's outage doesn't cascade across all payouts.

**Connection dropped mid-rail-call (`SUBMITTED_UNCONFIRMED`).**
The outcome is unknown — neither assume success nor failure. Query the partner's status endpoint using the `client_reference` (= Idempotency-Key) to resolve. Only after resolution does the refund decision follow. Failover to another rail is blocked until resolution — sending to Partner B while Partner A's outcome is unknown is exactly how a system pays out twice.

**Partial failures (batch).**
Each payout inside a batch is its own state-machine instance. The batch resource is a read-only rollup (`succeeded/failed/pending` counts + links to child payouts) — never an all-or-nothing outcome.

**Refund failure (`REFUND_FAILED`).**
The refund push to the caller's account also failed. Money is with Boku. This is the only state with a zero-tolerance alert policy — page oncall with no ack window; manual reconciliation with finance required. See observability doc for `REFUND_FAILED_ANY` alert definition.

### 3.5 Status tracking after submission

Two complementary mechanisms — neither replaces the other:
- **Pull**: `GET /payouts/{id}` — always correct, caller-paced. The `history` array (sourced from `payout_audit`) gives full per-step timing. Good for backfilling after an outage or for low-volume callers.
- **Push**: webhook on every state transition, HMAC-signed. Boku retries failed deliveries with backoff; exhausted deliveries land in a DLQ.

Webhooks are a convenience layer — `GET /payouts/{id}` must always reflect true current state even if every webhook delivery failed.

### 3.6 Reconciliation

A scheduled job matches Boku's internal `payout_audit` ledger against each partner's own settlement report/callback feed, flagging discrepancies for automatic correction or manual review. The `payout_audit` table's `partner_ref` column (= the Idempotency-Key sent to each rail) is the join key for this match. Same shape as DASH's reconciliation flow — generalized to N disbursement rails.

### 3.7 Quote vs. Payout — why this isn't a Create + Submit split

Boku's Payouts API is B2B infrastructure — the caller is a merchant backend, not an end user at a review screen. If a merchant wants their own user to review before paying, that happens in the merchant's UI. Boku is called once the user has confirmed.

The real reason for a two-step flow is **FX rate locking**, not human review:
- `POST /quotes` → locked rate + fees, short TTL (60–120s)
- `POST /payouts` optionally references `quote_id` — expired quote returns `QUOTE_EXPIRED`, not a silent re-price
- No `quote_id` → platform prices at submission time (common path for same-currency payouts)

`Quote` lives in its own short-lived table — not in the payout ledger. Comparing quotes-created to payouts-referencing-that-quote gives abandonment metrics without polluting the financial ledger.

### 3.8 Security & observability

**Security:**
- **mTLS** for all partner-facing rail calls — mutual authentication, not just server auth
- **HMAC-SHA256 signed** webhook payloads — callers verify the `X-Boku-Signature` header before processing
- **Secrets Manager** for partner API keys and mTLS certs — rotated without redeployment
- **Correlation ID** generated at `POST /payouts`, threaded through every log line, Kafka event, and partner call for that payout's lifetime

**Observability:**
The `payout_audit` table (§2 terminology, §3.3) is the foundation for all monitoring — per-step `duration_ms` rows power SLA dashboards and proactive alerting. See the **Traffic Model, SLA & Proactive Alerting** document for:
- Per-step execution budgets (target / warning / critical thresholds)
- 18 named alert definitions with top-5 prioritisation (☑ marks MVP alerts)
- Audit table schema and SQL views
- Dashboard definitions (Payout Health, Step Latency, State Distribution, Rail Health, Refund Tracker)
- Ops runbook stubs

### 3.9 Idempotency — identifiers, storage, and why it's a systemic pattern

**Idempotency-Key and Correlation-ID answer different questions — don't collapse them.**
- `Idempotency-Key` — caller-supplied, stable across every retry of one logical payout including rail failover. Answers: *"is this a duplicate request?"*
- `Correlation-ID` — generated per attempt, threaded through logs/events/spans for that attempt alone. Answers: *"how do I trace this specific execution?"*

Collapsing them blurs two different attempts (possibly to two different partners) into one trace — making the exact failures this design handles hardest to debug.

**The Idempotency-Key doubles as the partner reference.**
On every outbound rail call, send the Idempotency-Key (or a partner-safe derivation if their reference field has length/charset limits) as the `client_reference`. This is what makes `SUBMITTED_UNCONFIRMED` recovery possible: query the partner's own status endpoint using that reference — targeted, on-demand reconciliation triggered by an ambiguous failure, not the scheduled sweep. And critically: **failover to a different rail must wait for that resolution.** Sending to Partner B while Partner A's outcome is still unknown is exactly how a system pays out twice.

**This also covers the API Gateway timeout scenario.**
If the gateway times out before the `202` reaches the caller, the caller retries with the same key. If the payout was already created, the dedup check returns the original response. If not, it creates it now. The caller can't tell the difference — that's the design.

**Storage: Postgres is the source of truth; Redis is a fast-path cache.**
The Idempotency-Key needs a uniqueness constraint in the same transactional store as the payout ledger — dedup check and payout INSERT must happen in one ACID transaction. Redis provides sub-millisecond fast-path under high volume; if Redis misses, the request falls through to Postgres. On a uniqueness violation, return the existing record — don't error the caller.

**Idempotency is a property of the whole microservices architecture, not one header.**
- **Ingress** (caller → API): `Idempotency-Key` header + Postgres unique constraint
- **Internal** (service → service via Kafka): at-least-once delivery means workers *will* see the same event twice. The single-writer guard (`UPDATE ... WHERE status = 'X'`) makes a duplicate event a no-op instead of a double transition
- **Egress** (service → partner): `client_reference` = Idempotency-Key on every outbound call

Three layers, three mechanisms, one principle.

### 3.10 Cancellation — boundary at the first external API call

`POST /payouts/{payoutId}/cancel` is a state-machine guard, not a soft delete. The critical rule:

> **Cancellation is only permitted before any external API call has been made.**

Once the system has called an external party — the fund pull rail, the compliance provider, or the disbursement rail — cancellation is no longer safe. The external party may have already acted; a unilateral cancel risks leaving them in an inconsistent state.

**Cancellable states (no external call yet):**

| Status | Cancellable? | Reasoning |
|---|---|---|
| `PENDING` | ✅ Yes | Only internal — DB insert + Kafka publish. No external call made. |
| `PENDING_COMPLIANCE` | ✅ Yes | Compliance check is in-flight, but it is Boku-internal. No funds touched, no partner contacted. |
| `PENDING_MANUAL_REVIEW` | ✅ Yes | Waiting on a human reviewer. Safe to cancel — notify reviewer to discard. |

**Non-cancellable states (external call already made or funds in motion):**

| Status | Cancellable? | Correct path |
|---|---|---|
| `FUND_PULLING` | ❌ No | Fund pull API call is in-flight or completed. Stopping mid-pull leaves mandate in unknown state. |
| `SUBMITTED` and beyond | ❌ No | Disbursement rail has been called. Funds are with Boku or en route. Use the refund flow. |
| Any terminal state | ❌ No | Already resolved — `SETTLED`, `FAILED`, `REFUNDED`, `REJECTED_COMPLIANCE`, etc. Return `422 Unprocessable`. |

**Response contract:**

```
POST /payouts/{payoutId}/cancel

→ 200 OK           { payout_id, status: "CANCELLED" }      (was in a cancellable state)
→ 200 OK           { payout_id, status: "CANCELLED" }      (already cancelled — idempotent)
→ 422 Unprocessable { error_code: "CANCELLATION_NOT_ALLOWED",
                       message: "Payout is in FUND_PULLING — cancellation not permitted after external API call. If you need funds returned, they will be refunded automatically on failure." }
```

**The `422` response must tell the caller what to do instead** — "wait for the outcome; if it fails, the refund flow triggers automatically." Do not return `409 Conflict` (which implies a retry might work) or `400` (which implies the request was malformed).

**Implementation — optimistic lock on the cancel transition:**

```sql
UPDATE payouts
SET    status  = 'CANCELLED',
       version = version + 1
WHERE  payout_id = ?
  AND  status IN ('PENDING', 'PENDING_COMPLIANCE', 'PENDING_MANUAL_REVIEW')
  AND  version = ?

-- rows_affected = 1 → cancelled successfully
-- rows_affected = 0 → status advanced past the cancellable window between the read and this write
--                     → re-read current status → return 422 with current state
```

The optimistic lock matters here too: a cancel request and a compliance-pass event can race. The `version` check ensures only one wins — if the compliance worker advanced the payout to `FUND_PULLING` between the cancel handler's read and write, `rows_affected = 0` and the cancel handler re-reads `FUND_PULLING` and returns `422`.

### 3.11 Trade-off — `REFUND_REQUIRED` + Batch Job vs. Immediate Refund Execution

**The design choice:** when a payout fails after `SUBMITTED`, the Disbursement Worker writes `REFUND_REQUIRED` and stops. A scheduled **Refund Batch Job** (e.g. every 5 minutes, or configurable per corridor) picks up all `REFUND_REQUIRED` records and executes the refund — advancing each to `REFUND_PENDING` → `REFUNDED` | `REFUND_FAILED`.

**Why not trigger the refund immediately (event-driven)?**

An immediate, event-driven refund feels like the obvious choice — a Kafka consumer reacts to `payout.failed` and calls the payment rail right away. But it introduces risks under load:

- A burst of failures (rail outage, batch of invalid accounts) fires a corresponding burst of refund rail calls simultaneously — amplifying load on the same rail that may already be struggling
- No rate control: if 1,000 payouts fail in 30 seconds, 1,000 refund calls go out in the same window
- A partial system failure (Refund Worker crashes mid-burst) leaves some payouts flagged and some not, with no clean retry boundary

The `REFUND_REQUIRED` state is a **durable queue in the database**. The batch job reads it under controlled conditions — with rate limiting, retry logic, and a single observable query that shows exactly what is waiting and for how long.

**Trade-off table:**

| Dimension | Immediate (event-driven) | Batch Job via `REFUND_REQUIRED` |
|---|---|---|
| **User satisfaction** | Faster refund — merchant sees funds returned sooner | Delay of up to one batch interval (e.g. 5min) before refund starts |
| **System risk** | Burst of failures = burst of refund calls — may overwhelm rail | Controlled rate — batch job throttles outbound calls |
| **Failure recovery** | Kafka DLQ for failed events — harder to inspect and replay | `REFUND_REQUIRED` rows are visible, queryable, and trivially reprocessable |
| **Observability** | Refund state scattered across Kafka consumer metrics | Single SQL query on `status = 'REFUND_REQUIRED'` shows everything waiting |
| **Concurrency risk** | Multiple consumer instances can race on the same payout | Batch job uses `SELECT ... FOR UPDATE SKIP LOCKED` — safe fan-out with no double-execution |
| **Operational control** | No easy way to pause, drain, or rate-limit refunds | Batch job schedule and batch size are tunable without code change |

**Implementation — safe batch pickup with `SKIP LOCKED`:**

```sql
-- Batch job: claim a batch of REFUND_REQUIRED records safely
SELECT payout_id, version
FROM   payouts
WHERE  status = 'REFUND_REQUIRED'
ORDER  BY updated_at ASC          -- oldest first
LIMIT  100
FOR UPDATE SKIP LOCKED;           -- other batch job instances skip rows already claimed
```

Each claimed row is immediately advanced to `REFUND_PENDING` (with optimistic lock on `version`) before the refund call is made — so a job crash leaves records in `REFUND_PENDING`, not silently stuck in `REFUND_REQUIRED`.

**The `REFUND_REQUIRED_AGE` alert** (companion to the existing `REFUND_PENDING_AGE` alert in the observability doc) should fire if any `REFUND_REQUIRED` row is older than the expected batch interval + buffer — indicating the batch job has stalled.

**When to prefer immediate refund instead:**
If merchant SLA requires sub-minute refund initiation (e.g. consumer-facing corridors with regulatory mandates on reversal time), the batch interval is too slow. In that case, use the event-driven path but add an explicit rate-limiter (token bucket per rail) and a circuit breaker so a failure burst does not amplify into a refund rail storm.

---

## 4. AWS Mapping

| Component | AWS Service | Why |
|---|---|---|
| Public API entry | **API Gateway** | Request validation, auth, rate limiting before traffic reaches compute |
| Payout services | **EKS** | Six Spring Boot microservices as separate deployables: Payout Service, Compliance Service, Fund Pull Worker, Disbursement Worker, Refund Worker, Webhook Dispatcher |
| Event backbone | **MSK (managed Kafka)** | 6 topics (see observability doc §1.3); durable, ordered, replayable event log for all state transitions |
| System of record | **RDS PostgreSQL** | ACID guarantees for payout ledger + payout_audit + idempotency-key table — all three need real transactions |
| Retry / DLQ | **SQS + DLQ** | Per-rail and per-worker retry queues with backoff; exhausted messages land in DLQ for follow-up |
| Idempotency fast-path | **ElastiCache (Redis)** | Sub-millisecond duplicate-key check before hitting Postgres — cache in front of the source of truth, never a replacement |
| Compliance provider | **External API (via EKS)** | Fraud engine + AML/sanctions scanner called from Compliance Service; credentials in Secrets Manager |
| Scheduled reconciliation | **Lambda + EventBridge Scheduler** | Periodic batch job matching partner reports against `payout_audit` — same shape as DASH's Lambda-based reconciliation |
| Partner credentials / certs | **Secrets Manager** | mTLS certs and partner API keys rotated without redeploying services |
| Observability | **CloudWatch + X-Ray** | Structured logs, per-step duration metrics from `payout_audit`, distributed traces keyed on Correlation ID |
| Webhook delivery | **SNS/SQS fan-out + Lambda dispatcher** | Decouples "status changed" from "call every subscriber"; same retry/backoff/DLQ pattern as partner calls |

Assumes a blank-slate AWS environment, consistent with Boku's greenfield Banking & Settlement build.

---

## 5. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Language / framework | **Java 21 + Spring Boot** | Matches Boku's stated stack. Blocking model is fine for the Payout Service API layer; evaluate **WebFlux** for Disbursement Worker and Fund Pull Worker — high fan-out to slow external rails is exactly the non-blocking use case it's built for. |
| Internal service calls | **gRPC + Protocol Buffers** | Boku's JD lists gRPC as primary internal protocol; typed contracts and lower latency matter for the worker-to-worker call chain. |
| External API | **REST/JSON** | Public-facing payout API — broadest caller compatibility, no protobuf toolchain required for merchant integrators. |
| Event streaming | **Kafka (MSK)** | Durable, ordered, replayable — required for an auditable money-movement event log. Not just a message bus. |
| Primary datastore | **PostgreSQL** | ACID guarantees for ledger, state machine, and idempotency; same engine tuned at scale (9.6M-row table, HOT/autovacuum at DASH). |
| Cache / fast dedup | **Redis** | Idempotency-key fast-path and rate limiting need sub-ms latency. |
| IaC | **Terraform** | Reproducible greenfield infra from a blank AWS account. |
| CI/CD | **GitHub Actions** | Straightforward fit for EKS deploys; already used across own projects. |

---

## 6. Stakeholder Coverage

| Role | What they need | Covered | Gap |
|---|---|---|---|
| **Customer** (merchant/platform) | Predictable behaviour, no duplicate charges, clear status visibility, fast failure diagnosis | Idempotency-Key (§3.4/§3.9), dual pull+push tracking (§3.5), structured `error_code`/`failure_reason`, full history in `GET /payouts/{id}` | No stated SLA on max time in `PENDING_COMPLIANCE` / `SUBMITTED_UNCONFIRMED`; no rate-limit contract; no API versioning policy |
| **PO** | Clear scope, MVP vs. later, business justification | Quote + batch explicitly "additive, not foundational"; Pull-and-Pay vs. prefunded named as a live question; compliance gate as optional per-corridor | No Phase 1 / Phase 2 scope line; no success metrics (payout success rate, time-to-settle); no cost-per-rail tradeoff |
| **Developer** | Reasoned state model, testable contracts, low ambiguity | Full state machine (§3.3), Correlation-ID vs. Idempotency-Key split (§3.9), consistent error shape, audit table schema | No test strategy (contract tests, chaos rail failures); no API versioning scheme; no client SDK story for REST + gRPC |
| **DevOps** | Deployability, observability, scaling, secrets | Full AWS mapping (§4): 6 EKS microservices, MSK, RDS, SQS+DLQ, Secrets Manager, CloudWatch+X-Ray | No canary/blue-green deployment strategy; no EKS autoscaling policy for submission bursts; Terraform named but not detailed |
| **Operation Team** | Investigate stuck payouts, manual intervention, alerting | `SUBMITTED_UNCONFIRMED` + `REFUND_PENDING` age alerts (☑ in observability doc), `payout_audit` for per-step trace, DLQ for exhausted retries | No admin API/dashboard; no manual override/force-resolve endpoint; runbooks are stubs — data supports them but procedures not yet written |
| **Financial team** | Immutable audit trail, reconciliation accuracy, dispute resolution | `payout_audit` is append-only (§3.3); reconciliation matches internal ledger vs. partner records (§3.6); `REFUNDED` trail: pull → failed → refunded | No GL/accounting-system integration point; no audit-log retention policy; no explicit handling of how `RETURNED` reconciles back into finance's books |
| **Stakeholder** (exec/business) | Risk, cost, time-to-market, scalability story | Greenfield rationale; AWS choices justified against DASH-proven patterns at real scale | No TCO/cost estimate; no phased timeline; no risk register |

**The honest read:** strongest on Customer / Developer / DevOps — these map directly onto DASH-proven patterns. Operation Team coverage improved materially with the observability doc (audit table, alert thresholds, dashboard definitions), but the runbooks are still stubs. Financial team and Stakeholder remain the thinnest. Naming these gaps unprompted is a stronger answer than overclaiming coverage.

---

## Notes for the live walkthrough

- **Lead with the Pull-and-Pay + compliance gate design** — it demonstrates the full complexity of a real payments platform: async compliance, explicit fund pull state, conditional refund flow, and the key insight that separating `FUND_PULLING` from `SUBMITTED` eliminates an entire class of flag-check bugs. This is the showcase, not the simple path.
- **Ask Q3 (funding model) early** — if Boku uses prefunded wallet, the design simplifies significantly. Show you know both, let them confirm, then pivot. Don't defend Pull-and-Pay unconditionally.
- **Ask Q1 + Q2 (rail model) before failure handling** — the answers scope how much of §3.9 applies. Framing it as a live question shows the design is load-bearing on a real unknown, not a gap.
- **Ask Q2 (rail model) before failure handling** — the answers scope how much of §3.9 applies:
  - Caller-selects-rail → rail selection layer gone, failover-blocking in §3.9 gone, `SUBMITTED_UNCONFIRMED` stays
  - Priority-ordered fallback → §3.9 applies in full
  - True multi-rail scoring → need a selection/scoring step not currently designed
- **The state machine diagram is the anchor** — walk through it first, then the compliance gate, then idempotency. Everything else is a detail of one of those three.
- **Strongest deep-dive areas:** the idempotency/Correlation-ID split (§3.9), the `SUBMITTED_UNCONFIRMED` ambiguous-failure handling, and the audit table as the foundation for all observability — all direct extensions of the DASH Remittance work.
- **Proactively surface Operation Team and Financial team gaps** (§6) — naming them first lands better than waiting to be caught out.
- **Be ready to scope out treasury/cash-position** — marked desirable in the JD, not required. Scope it out explicitly if asked.
- **`REFUND_FAILED` is the zero-tolerance state** — the only alert with no acknowledgement window. Worth naming explicitly to show you understand the difference between "important" and "critical."
