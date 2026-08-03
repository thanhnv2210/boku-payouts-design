# Payouts API — High-Level Design

> Take-home task for Boku (Banking & Settlement). Prepared for HM walkthrough.
> Structure: Requirements & assumptions → Terminology → Implementation principles (incl. endpoints, schemas, failure handling, status tracking) → AWS mapping → Tech stack.

---

## 1. Requirement + Top 3 Assumptions

### Requirement (as given)
Design a Payouts API that lets a caller submit a payout to a beneficiary, exposes clear endpoints and request/response contracts, handles duplicate requests / failed disbursements / partial failures, and lets the caller track status after submission.

### Top 3 assumptions (and the scenario each one resolves)

**Assumption 1 — Submission is synchronous, settlement is not.**
*Scenario:* A caller hits `POST /payouts`. The actual movement of funds through a downstream bank/card/wallet rail can take anywhere from seconds to multiple business days.
*Assumption:* The API acknowledges **acceptance** synchronously (`202 Accepted` + a payout ID), and the caller tracks the real outcome asynchronously (poll or webhook). I'm assuming callers cannot tolerate an HTTP call blocking for the full settlement time.
*Alternative considered:* Fully synchronous confirm-then-respond — rejected, because it couples API availability to partner rail latency/uptime, which is exactly the kind of coupling DASH's FX/partner failover design was built to avoid.

**Assumption 2 — Single-payout is the primary unit; batch is additive, not foundational.**
*Scenario:* Boku's JD doesn't specify whether payouts arrive one at a time (e.g., a marketplace paying one seller) or as a payroll-style batch (e.g., paying 10,000 gig workers at once).
*Assumption:* I'm designing the core resource as **one payout = one API call**, with a separate `POST /payouts/batch` as an additive wrapper that fans out into individual payout records — because it's cleaner to get single-resource idempotency and state tracking right first, then compose it, rather than starting from batch semantics and bolting on single-payout as a special case.
*Alternative considered:* Batch-first design (file upload, job ID) — plausible if Boku's actual merchant customers are payroll-style, worth confirming with the interviewer live.

**Assumption 3 — Rail selection is the platform's responsibility, not the caller's.**
*Scenario:* Boku is global (65 countries per the JD) — a payout to Singapore vs. Kenya vs. the US likely rides completely different rails (local bank transfer, mobile money, card push).
*Assumption:* The caller specifies **what** and **to whom** (amount, currency, beneficiary), not **how** (which rail/partner). Rail selection is the platform's job, mirroring how DASH's FX orchestration picked and failed over between Thunes/Tranglo/WU without the caller knowing.

**Why not caller-selects-rail?** This is a real, legitimate model — Stripe, Wise, and some B2B treasury platforms expose it explicitly. It makes sense when the platform's value proposition is "connectivity layer, you control the routing." I'm ruling it out as the *default* here because Boku's value proposition reads differently: 65-country coverage, global corridor management, partner relationships the merchant doesn't have — the platform's job is to abstract that complexity away, not expose it. Letting a caller specify `"rail": "LOCAL_BANK_SG"` throws that abstraction away, and now every merchant needs to know Boku's partner topology per corridor, which couples the public API contract to internal infra decisions. That said, I'd keep an optional `preferred_rail` hint for edge cases where a specific caller genuinely needs it.

*Alternative considered:* Caller-selects-rail — valid if Boku's product is a connectivity/aggregation layer rather than a managed payout service. **Worth confirming live** — see open question below.

**Assumption 4 — Funding model: prefunded wallet, not atomic pull-and-pay.**
*Scenario:* Before Boku can disburse to a beneficiary, the money has to come from somewhere. There are two real-world models:

| Model | How it works | Design impact |
|---|---|---|
| **Prefunded wallet** (my assumption) | Merchant tops up a Boku-held balance in advance. `POST /payouts` checks and debits the wallet atomically before queuing disbursement. | `POST /payouts` can reject synchronously with `INSUFFICIENT_FUNDS`. Needs a `Wallet` resource and `POST /wallets/topup`. Two-ledger: wallet ledger + payout ledger. |
| **Atomic pull-and-pay** | `POST /payouts` triggers both a debit on the caller's payment account and the disbursement to the beneficiary in a single coordinated flow. No pre-funding step. | Simpler for the caller — one API call does everything. But now `POST /payouts` has two failure surfaces (pull fails, or disbursement fails), and a failed pull means neither side moves. Requires Boku to hold a direct debit mandate on the caller's account. |

*Assumption:* I'm designing for **prefunded wallet** because it's the dominant model among B2B payout aggregators (Thunes, Airwallex, Rapyd) and it keeps `POST /payouts` semantically clean — by the time a payout is submitted, the funds are already Boku's to move. Atomic pull-and-pay is more elegant for the caller but introduces a two-phase money movement inside a single API call, which complicates failure handling significantly.

*What this adds to the prefunded model:*
- `POST /wallets/topup` — merchant initiates a fund transfer into their Boku wallet (out of scope for this design iteration, but named)
- Balance check inside `POST /payouts` — atomic with the idempotency dedup check: deduct from wallet + create payout in one transaction, or reject with `INSUFFICIENT_FUNDS`
- `INSUFFICIENT_FUNDS` as a new synchronous `422` rejection — the only case where `POST /payouts` fails without creating a payout record

*Alternative considered:* Atomic pull-and-pay — valid, especially for embedded finance or marketplace platforms where the caller's funds are already in a Boku-connected account. See diagram in the sidebar for how the flow differs. **Worth confirming live** — see open question below.

### Open question for the walkthrough (not an assumption — a thing to confirm live)

**Question 1 — Is the platform a managed payout service or a connectivity layer?**

This determines whether Assumption 3 holds at all:

| Model | Who picks the rail | Design impact |
|---|---|---|
| **Managed payout service** (my assumption) | Platform, invisibly | Rail selection + failover is internal; caller API stays simple |
| **Connectivity layer** | Caller specifies upfront | Rail selection layer removed entirely; simpler design, different product |

If it's the connectivity model, I'd remove the rail-selection layer, keep `SUBMITTED_UNCONFIRMED` (a connection drop is still a connection drop regardless of who picked the rail), but drop the failover-blocking logic in §3.9 entirely — there is no rail 2 to fail over to.

**Question 2 — If platform-picks-rail: single primary with fallback, or genuinely multi-rail?**

Assuming Assumption 3 holds, there are still two materially different sub-models:

- **Priority-ordered fallback** — a circuit breaker trips on the primary and switches wholesale to the next rail in the list. Most common in practice.
- **Genuinely multi-rail** — multiple candidate rails scored per payout (cost, speed, success rate), not just a fallback chain.

This changes the failure-handling design directly: the priority-list model needs the ambiguous-failure guard in §3.9 (don't fail over to rail 2 while rail 1's outcome is still unknown); a true multi-rail model needs a selection/scoring step I haven't designed here. I'd rather surface this as a live question than silently assume one.

---

## 2. Solution Terminologies

| Term | Definition |
|---|---|
| **Payout** | A single instruction to move funds from Boku's client (the caller) to a named beneficiary. |
| **Beneficiary** | The recipient of a payout — a bank account, card, or wallet identifier plus owner details. |
| **Disbursement / Rail / Partner** | The downstream network actually moving the money (bank transfer network, card scheme, mobile wallet). A payout is *fulfilled by* a disbursement. |
| **Idempotency Key** | A caller-supplied unique token guaranteeing that retrying the same request never creates a second payout. |
| **Payout State Machine** | The explicit set of statuses a payout moves through, with defined legal transitions (see §3.3). |
| **Terminal state** | A state the payout cannot leave (`SETTLED`, `FAILED`, `RETURNED`). Non-terminal states can still change. |
| **Partial failure** | In a batch, some payouts succeed and others fail independently — the batch itself has no single pass/fail outcome. |
| **Reconciliation** | Matching Boku's internal payout records against the partner's own settlement/callback records to catch silent discrepancies. |
| **Ledger entry** | An immutable, append-only record of a funds-movement event, used as the source of truth (vs. mutable payout status, which is a projection). |
| **Quote** | An ephemeral, short-TTL FX rate lock + preview, obtained *before* a payout is created — not part of the payout ledger. |
| **Partner reference** | The client-generated reference sent to a disbursement partner on every outbound call — reused from the Idempotency-Key — so an ambiguous outcome can be resolved by querying the partner's own system, not just by retrying. |
| **Correlation ID** | An ID threaded through every log line, event, and span for one specific execution attempt — distinct from the Idempotency-Key, which spans every retry of one logical request. |
| **Webhook / callback** | An async, platform-initiated push notification to the caller when a payout's status changes. |
| **Wallet / prefunded balance** | A Boku-held balance belonging to the caller, debited atomically when a payout is accepted. The source of funds for disbursement in the prefunded model. |
| **Atomic pull-and-pay** | An alternative funding model where `POST /payouts` triggers both a debit on the caller's external account and the beneficiary disbursement in one coordinated flow — no separate top-up step. |
| **Compliance gate** | An async fraud + AML/sanctions check that runs after `202 Accepted` but before any funds move. The payout sits in `PENDING_COMPLIANCE` until the gate passes or blocks. |
| **`PENDING_COMPLIANCE`** | Non-terminal state: payout accepted, compliance checks in progress, no funds moved yet. |
| **`REJECTED_COMPLIANCE`** | Terminal state: compliance gate blocked the payout (sanctions match, fraud score exceeded, PEP detected). Distinct from `FAILED` — this is a legal/policy block, not a rail issue. |
| **`PENDING_MANUAL_REVIEW`** | Non-terminal state: compliance returned a soft hit (partial match, PEP flag) — a human reviewer must approve or reject before the payout can proceed. |
| **Hard hit / Soft hit** | AML screening outcomes. Hard hit = definitive sanctions match → auto-reject. Soft hit = partial match or PEP detected → route to manual review queue. |
| **`FUND_PULLING`** | Non-terminal state (Pull-and-Pay only): compliance passed, the platform is now debiting the caller's account before disbursement begins. Separating this from `SUBMITTED` means if `SUBMITTED` is ever reached, funds are always with Boku — no flag needed. |
| **`FUND_PULL_FAILED`** | Terminal state: the debit on the caller's account failed (insufficient funds, mandate revoked). No funds moved — no refund required. |
| **`REFUND_PENDING`** | Non-terminal state (Pull-and-Pay only): disbursement failed after funds were pulled; a refund payment back to the caller is in progress. |
| **`REFUNDED`** | Terminal state: caller's funds have been successfully returned. Full audit trail preserved: pull → failed → refunded. |
| **`REFUND_FAILED`** | Terminal state: refund attempt to the caller also failed. Money is with Boku — neither beneficiary nor caller holds it. Requires immediate manual ops intervention. |

---

## 3. Implementation Principles

### 3.1 API surface (endpoints + reasoning)

| Endpoint | Purpose | Reasoning |
|---|---|---|
| `POST /payouts` | Submit a single payout | Core resource creation. Requires `Idempotency-Key` header. |
| `GET /payouts/{payoutId}` | Fetch current status + full lifecycle | Primary status-tracking mechanism; cacheable, cheap to poll. |
| `GET /payouts?external_ref={ref}` | Look up a payout by the caller's own reference | Callers often lose the returned `payoutId` (crashed before persisting it) — need a recovery path keyed on *their* identifier, not just ours. |
| `POST /payouts/batch` | Submit multiple payouts as one call | Additive per Assumption 2; internally decomposes into N individual payout records, each independently tracked. |
| `GET /payouts/batch/{batchId}` | Batch-level rollup status | Surfaces partial-failure counts (`succeeded: 8, failed: 2, pending: 0`) without hiding individual outcomes. |
| `POST /payouts/{payoutId}/cancel` | Cancel a payout still in a cancellable state | Payments-specific: cancellation must be rejected once a payout has left a cancellable state — this is a state-machine guard, not a soft delete. |
| `POST /webhooks/subscriptions` | Register a callback URL for status-change events | Push-based status tracking, complementary to polling. |
| `POST /quotes` | Lock an FX rate + preview a payout before it's created | Optional pre-step for cross-currency payouts — see §3.8. Not part of the payout ledger. |
| `GET /quotes/{quoteId}` | Fetch a previously issued quote | Lets a caller re-check a quote's remaining validity before submitting the payout that references it. |

I did **not** expose a `DELETE /payouts/{id}` — funds-movement records are never deleted, only transitioned to a terminal state. This is a deliberate omission, not an oversight.

### 3.2 Request / response structures

**Submit a payout**
```
POST /payouts
Idempotency-Key: 6f1c1e2a-...   (required, caller-generated, unique per logical payout)

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
  "metadata": { "order_id": "ord_9981" }
}
```

**Response — 202 Accepted**
```
{
  "payout_id": "pyo_01HZX...",
  "status": "PENDING",
  "external_reference": "invoice-8842",
  "amount": { "value": "150.00", "currency": "SGD" },
  "created_at": "2026-08-01T09:00:00Z",
  "links": { "self": "/payouts/pyo_01HZX..." }
}
```

**Status fetch — `GET /payouts/{id}`**
```
{
  "payout_id": "pyo_01HZX...",
  "status": "FAILED",
  "failure_reason": "BENEFICIARY_ACCOUNT_INVALID",
  "history": [
    { "status": "PENDING",   "at": "2026-08-01T09:00:00Z" },
    { "status": "SUBMITTED", "at": "2026-08-01T09:00:02Z" },
    { "status": "FAILED",    "at": "2026-08-01T09:00:11Z", "reason": "BENEFICIARY_ACCOUNT_INVALID" }
  ]
}
```

Every error response uses a consistent shape (`error_code`, `message`, `request_id`) so callers can branch on `error_code` programmatically rather than parsing prose.

### 3.3 Payout state machine

```
PENDING → PENDING_COMPLIANCE → FUND_PULLING → SUBMITTED → SETTLED    (happy path, compliance + pull-and-pay)
PENDING → FUND_PULLING → SUBMITTED → SETTLED                          (happy path, no compliance gate)
PENDING → SUBMITTED → SETTLED                                         (happy path, prefunded wallet)

PENDING_COMPLIANCE → FUND_PULLING                                     (compliance passes)
PENDING_COMPLIANCE → REJECTED_COMPLIANCE                              (hard hit — terminal, no funds moved)
PENDING_COMPLIANCE → PENDING_MANUAL_REVIEW                            (soft hit — human review)
PENDING_MANUAL_REVIEW → FUND_PULLING | REJECTED_COMPLIANCE            (reviewer decides)

FUND_PULLING → SUBMITTED                                              (pull succeeds — funds with Boku)
FUND_PULLING → FUND_PULL_FAILED                                       (pull fails — terminal, no refund needed)

SUBMITTED → SETTLED                                                   (rail confirms)
SUBMITTED → FAILED                                                    (rail rejects — non-retryable)
SUBMITTED → RETURNED                                                  (rail accepted, later reversed)
SUBMITTED → SUBMITTED_UNCONFIRMED                                     (connection dropped — outcome unknown)
SUBMITTED_UNCONFIRMED → SETTLED | FAILED                              (resolved via partner-reference lookup only)

FAILED   → REFUND_PENDING                                             (Pull-and-Pay: SUBMITTED reached = funds always with Boku)
RETURNED → REFUND_PENDING                                             (Pull-and-Pay: rail reversed after pull)
REFUND_PENDING → REFUNDED                                             (refund to caller succeeds — terminal)
REFUND_PENDING → REFUND_FAILED                                        (refund also fails — terminal, manual intervention)

PENDING → CANCELLED                                                   (caller cancels before submission — terminal)
```

See the **State Machine diagram** in the sidebar for the full visual.

**Why `FUND_PULLING` as a separate state simplifies the design:**
Separating fund pull from disbursement means that if `SUBMITTED` was reached, funds are *always* with Boku — no `funds_pulled` flag needed anywhere. Every `FAILED` or `RETURNED` from `SUBMITTED` unconditionally triggers a refund. The disbursement worker does one thing only: send money to the beneficiary.

**Refund trigger — simplified:**

| State | Refund needed? | Why |
|---|---|---|
| `REJECTED_COMPLIANCE` | No | Compliance runs before any funds move |
| `FUND_PULL_FAILED` | No | Pull failed — caller's account never debited |
| `FAILED` (from `SUBMITTED`) | Yes — always | `SUBMITTED` means funds are with Boku |
| `RETURNED` (from `SUBMITTED`) | Yes — always | Rail reversed after Boku already held funds |
| `SUBMITTED_UNCONFIRMED → FAILED` | Yes — after lookup resolves | Wait for partner-reference resolution first |

`REFUND_FAILED` is the most serious ops state — money is with Boku, not with the beneficiary or the caller. Must have a defined alerting threshold (e.g., page oncall within 5 minutes of entering this state).

Every transition is a single-writer update guarded by the current state (`UPDATE ... WHERE status = 'X'`), so two concurrent workers can never both advance the same payout — this is the same class of guard I used for the Dash transaction state machine.

**On `PENDING_COMPLIANCE`:** the compliance gate runs *after* `202 Accepted` but *before* any funds move. This is the correct placement — the caller gets an immediate acknowledgement, and the platform runs fraud/AML checks async without blocking the API on a scan that may take seconds. The gate is optional per corridor or payout type: low-risk, same-currency payouts below a threshold may skip it; high-value or cross-border payouts always go through.

**Two checks, sequenced:**
- **Fraud screening** — velocity checks, amount anomalies, beneficiary pattern matching. Fast, automated, binary pass/fail.
- **AML / sanctions scan** — screen beneficiary against OFAC, UN, EU, and local sanctions lists. Mandatory for cross-border. A *hard hit* (exact match) auto-rejects to `REJECTED_COMPLIANCE`; a *soft hit* (partial match, PEP detected) routes to `PENDING_MANUAL_REVIEW` for a human decision.

**`REJECTED_COMPLIANCE` is deliberately separate from `FAILED`.** `FAILED` means a rail issue — a transient or retryable problem in the disbursement layer. `REJECTED_COMPLIANCE` means a legal/policy block — no amount of retrying will change the outcome, and the rejection reason (`SANCTIONS_MATCH`, `FRAUD_SCORE_EXCEEDED`, `PEP_DETECTED`) has different downstream implications (regulatory reporting, account review) that must not be conflated with a bank timeout.

`SUBMITTED_UNCONFIRMED` is deliberately non-terminal and deliberately not `FAILED` — a connection drop mid-call to the partner tells you nothing about whether they actually processed it. Guessing either way is wrong: retrying blind risks a duplicate disbursement, marking it `FAILED` risks paying out twice if the partner actually succeeded. It can only be resolved by looking, not by waiting or assuming — see §3.9.

### 3.4 Failure handling

**Duplicate payout requests.**
The `Idempotency-Key` is stored with a uniqueness constraint alongside the resulting `payout_id`. A retried request with the same key returns the **original** response (same `payout_id`, same status) instead of creating a second payout — the caller cannot tell, from the response alone, whether their request was new or a replay, which is the point. Keys expire after a bounded window (e.g., 24h) to avoid unbounded storage growth.

**Failed disbursements.**
A rail rejection (invalid account, sanctions hold, insufficient partner liquidity) transitions the payout straight to `FAILED` with a structured `failure_reason` — no silent retries on non-retryable errors. Transient errors (partner timeout, 5xx) go through retry with exponential backoff + jitter, capped at N attempts, then a **circuit breaker** trips per-rail so one partner's outage doesn't cascade into every payout timing out. Attempts that exhaust retries land in a DLQ for manual/automated follow-up rather than disappearing.

**Partial failures (batch).**
Each payout inside a batch is its own state-machine instance. The batch resource is a read-only rollup (`succeeded/failed/pending` counts + links to each child payout) — it never has an all-or-nothing outcome. This avoids the failure mode where one bad beneficiary record blocks 999 good ones.

### 3.5 Status tracking after submission

Two complementary mechanisms, not one:
- **Pull**: `GET /payouts/{id}` — always correct, caller-paced, good for low-volume callers or backfilling after an outage.
- **Push**: webhook on every status transition, with the caller's endpoint expected to respond `2xx` quickly and Boku retrying failed webhook deliveries with backoff (same DLQ pattern as partner-side failures).

Webhooks are a convenience layer, never the source of truth — `GET /payouts/{id}` must always reflect the true current state even if every webhook delivery failed. This mirrors the reconciliation principle: never let an async notification become the only record of what happened.

### 3.6 Reconciliation

A scheduled job matches Boku's internal ledger against each partner's own settlement report/callback feed, flagging discrepancies (partner says settled, we show pending; or vice versa) for automatic correction or manual review. This is the same shape as the DASH reconciliation flow — matching partner callbacks back to originating transactions — just generalized to N disbursement rails instead of N remittance hubs.

### 3.7 Quote vs. Payout — why this isn't a Create + Submit split

A natural question: should `POST /payouts` itself be split into **Create** (preview) and **Submit** (confirm), the way a consumer remittance app shows a review screen before the user taps confirm?

**Not for this API, and not for that reason.** Boku's Payouts API is B2B infrastructure — the caller is a merchant/platform's backend, not an end user looking at a screen. If a merchant wants *their own* user to review a beneficiary before triggering a payout, that review happens in the merchant's own UI, using data they already hold — they only call Boku once their user has actually confirmed. Modeling a caller-facing "double check" step inside the Payouts API solves a DASH-shaped (B2C) problem, not a Boku-shaped (B2B) one.

**Where a split is still justified: FX rate locking, not human review.**
Cross-currency payouts (likely, given Boku's global footprint) need the exchange rate committed to *before* execution — the platform can't disburse at a stale rate. That's the real reason for a two-step flow, and it's solved with a separate, ephemeral **Quote** resource rather than by splitting the payout itself:

- `POST /quotes` → returns a locked rate, computed fees, and beneficiary preview, with a short TTL (e.g. 60–120s).
- `POST /payouts` optionally references `quote_id` — if the quote has expired, the payout is rejected with a specific error (`QUOTE_EXPIRED`) rather than silently re-pricing.
- No `quote_id` provided → the platform prices at submission time; this is the common path for same-currency or system-to-system payouts with no rate-sensitivity.

**Abandonment/funnel analytics falls out of this for free — without polluting the ledger.**
A payout ledger is a financial system of record — every row should correspond to a real, intended money movement, because reconciliation and audit depend on that invariant. If "create" wrote a payout-ledger row that might never be submitted, you'd be mixing "nothing happened" attempts into a book of record. Instead, `Quote` lives in its own short-lived table: comparing quotes-created to payouts-referencing-that-quote gives the exact "people who previewed but never confirmed" metric, with no ledger contamination and no cleanup/expiry logic needed on the Payout resource itself.

**Net design:** `POST /payouts` stays a single call for the core resource. `Quote` is an additive, optional, non-authoritative pre-step — used only where FX-rate sensitivity actually demands it, not as a default double-check gate on every payout.

### 3.8 Security & observability

- **mTLS** for partner-facing calls, **HMAC-signed payloads** for webhook deliveries so callers can verify authenticity.
- **Correlation ID** generated at `POST /payouts` and threaded through every log line, Kafka event, and partner call for that payout.
- Structured logs + metrics (payout latency, failure rate by rail, DLQ depth) as first-class outputs, not an afterthought.

### 3.9 Idempotency — identifiers, storage, and why it's a systemic pattern, not one header

**Idempotency-Key and Correlation-ID answer different questions — don't collapse them.**
The Idempotency-Key answers *"is this a duplicate request?"* — caller-supplied, and stable across every retry of one logical payout, including a rail failover. The Correlation-ID answers *"how do I trace this specific execution?"* — generated per attempt, and threaded through logs/Kafka events/spans for that attempt alone. If a payout retries or fails over from one rail to another, one Idempotency-Key should span the whole thing, but each attempt should get its own Correlation-ID — collapsing them into a single ID blurs two different attempts (possibly to two different partners) into one trace, which makes exactly the failure this design cares about harder to debug.

**The Idempotency-Key doubles as the partner reference — that's what makes ambiguous-failure recovery possible.**
On every outbound call to a disbursement partner, send the Idempotency-Key itself (or a partner-safe derivation of it, if their reference field has length/charset limits) as the `client_reference`. This is the exact mechanism DASH used with WU's MTCN reference. It matters specifically when a connection drops mid-call and the outcome is unknown: instead of guessing, query the partner's own status-lookup endpoint using that same reference — this is a targeted, on-demand use of the reconciliation logic in §3.6, triggered by an ambiguous failure instead of the scheduled sweep. This is exactly what the `SUBMITTED_UNCONFIRMED` state in §3.3 exists for, and — critically — **failover to a different rail must wait for that resolution.** Sending the same payout to Partner B while Partner A's outcome is still unknown is exactly how a system pays out twice.

**Where the key lives: Postgres is the source of truth; Redis is a fast-path cache, never the reverse.**
The Idempotency-Key needs a **unique constraint in the same transactional store as the payout ledger** (Postgres) — dedup-check and payout-creation have to happen in one ACID transaction, or two concurrent requests can both race past a separate check before either writes the payout. Redis alone isn't safe as the source of truth here: it's not durable by default, and an evicted or lost key would let a genuine retry sail through as a "new" payout — unacceptable for money movement. The right split (already reflected in §4's AWS mapping) is: Redis in front, for a sub-millisecond "have I seen this key" check under high submission volume; Postgres behind it as the actual guarantee. If Redis misses or is empty, the request falls through to Postgres, whose unique constraint catches it — and on a constraint violation, look up and return the existing record rather than erroring the caller.

**Idempotency is a property of the whole microservices architecture, not a header on one endpoint.**
The stack here is event-driven (Kafka) with multiple services (submission, state-machine worker, reconciliation, partner integration) — and duplicate delivery can happen at every hop, not just the public API:
- **Ingress** (caller → API): the `Idempotency-Key` header, as above.
- **Internal** (service → service, via Kafka): at-least-once delivery means the state-machine worker *will* see the same event twice eventually. This is already handled, just not previously named as idempotency — the single-writer guard (`UPDATE ... WHERE status = 'PENDING'`) from §3.3 is what makes a duplicate event a no-op instead of a double transition.
- **Egress** (service → partner): the partner reference, above.

Three layers, three mechanisms, one principle — worth stating explicitly in the walkthrough rather than letting it look like idempotency is just something `POST /payouts` does.

---

## 4. Apply for AWS Cloud (example)

| Component | AWS Service | Why |
|---|---|---|
| Public API entry | **API Gateway** | Request validation, auth, rate limiting before traffic reaches compute — same pattern used for FX rate caching at DASH. |
| Payout services | **EKS** | Spring Boot services as containerized microservices — submission, state-machine worker, reconciliation, webhook-dispatcher as separate deployables. |
| Event backbone | **MSK (managed Kafka)** | Payout-created / status-changed events fan out to reconciliation, webhook dispatch, analytics without tight coupling. |
| System of record | **RDS PostgreSQL** | ACID guarantees for money movement; idempotency-key table and payout ledger need real transactions, not eventual consistency. |
| Retry / DLQ | **SQS + DLQ** | Per-rail retry queues with backoff; exhausted messages land in a dead-letter queue for follow-up, exactly like DASH's callback DLQ. |
| Idempotency fast-path | **ElastiCache (Redis)** | Sub-millisecond duplicate-key check before hitting Postgres, under high submission volume — a cache in front of the source of truth, not a replacement for it (see §3.9). |
| Scheduled reconciliation | **Lambda + EventBridge Scheduler** | Periodic batch job matching partner reports to internal records — same shape as DASH's Lambda-based reconciliation. |
| Partner credentials / certs | **Secrets Manager** | mTLS certs and partner API keys rotated without redeploying services. |
| Observability | **CloudWatch + X-Ray** | Structured logs, per-rail failure metrics, distributed traces keyed on the correlation ID. |
| Webhook delivery | **SNS/SQS fan-out + Lambda dispatcher** | Decouples "status changed" from "call every subscriber," with the same retry/backoff/DLQ pattern as partner calls. |

This assumes a blank-slate AWS environment, consistent with Boku's greenfield Banking & Settlement build — no legacy infra to work around.

---

## 5. Tech Stack Selection

| Layer | Choice | Why |
|---|---|---|
| Language / framework | **Java 21 + Spring Boot** | Matches Boku's stated stack; Spring Boot's blocking model is fine for the API layer, but I'd evaluate **WebFlux** for the partner-calling layer specifically — high fan-out to multiple slow rails is exactly the non-blocking use case it's built for. |
| Internal service calls | **gRPC + Protocol Buffers** | Boku's JD lists gRPC as primary internal protocol; typed contracts and lower latency matter for the submission → state-machine-worker → reconciliation call chain. |
| External API | **REST/JSON** | Public-facing payout API — broadest caller compatibility, easiest for merchant integrators to consume without a protobuf toolchain. |
| Event streaming | **Kafka (MSK)** | Durable, ordered, replayable — required for an auditable money-movement event log, not just a message bus. |
| Primary datastore | **PostgreSQL** | Transactional guarantees for the ledger and state machine; same engine I've already tuned at scale (9.6M-row table, HOT/autovacuum). |
| Cache / fast dedup | **Redis** | Idempotency-key lookups and rate limiting need sub-ms latency. |
| IaC | **Terraform** | Reproducible, greenfield infra from a blank AWS account. |
| CI/CD | **GitHub Actions** (or equivalent) | Already used across my own projects; straightforward fit for EKS deploys. |

---

## 6. Stakeholder Coverage

A design that only satisfies the API contract misses half of what's actually being evaluated for a Senior/Architect role — the honest version of this section names what's covered, and what isn't, rather than claiming full coverage that hasn't actually been designed.

| Role | What they need from this design | Covered already | Gap |
|---|---|---|---|
| **Customer** (the merchant/platform calling the API) | Predictable behavior, no duplicate charges, clear status visibility, fast failure diagnosis | Idempotency-Key (§3.4/§3.9), dual pull+push status tracking (§3.5), structured `error_code`/`failure_reason` | No stated SLA (max time in `PENDING`/`SUBMITTED_UNCONFIRMED` before it's treated as stuck), no rate-limit contract, no API versioning policy for breaking changes |
| **PO** | Clear scope boundaries, MVP vs. later, ability to justify choices to the business | Quote and batch are explicitly "additive, not foundational" (§1); the approval gate is a policy flag, not a hard requirement (Decision D4) — phased-rollout thinking, not a single monolithic scope | No explicit Phase 1 / Phase 2 scope line, no success metrics tied to product outcomes (payout success rate, time-to-settle), no cost-per-rail tradeoff to inform prioritization |
| **Developer** | Reasoned state model, testable contracts, low ambiguity at edges | Explicit state machine (§3.3), correlation-id vs. idempotency-key split (§3.9), consistent error shape | No test strategy named (contract tests, chaos-testing rail failures), no API versioning scheme, no client SDK story for the two protocols in play (REST external, gRPC internal) |
| **DevOps** | Deployability, observability, scaling, secrets handling | Full AWS mapping (§4): EKS, MSK, RDS, SQS+DLQ, Secrets Manager, CloudWatch+X-Ray | No deployment strategy (canary/blue-green), no autoscaling policy for EKS under submission bursts, IaC named (Terraform) but not detailed |
| **Operation Team** | Investigate a specific stuck payout, manual intervention, alerting thresholds | `SUBMITTED_UNCONFIRMED` exists exactly for stuck cases (§3.3), DLQ for exhausted retries, reconciliation loop (§3.6) | No ops-facing surface at all — no admin API/dashboard, no manual override/force-resolve endpoint, no defined alert threshold (e.g. page if `SUBMITTED_UNCONFIRMED` > 15 min), no runbook |
| **Financial team** | Immutable audit trail, reconciliation accuracy, dispute resolution, regulatory reporting | Ledger entries are immutable/append-only (§2), reconciliation matches internal ledger vs. partner records (§3.6) | No GL/accounting-system integration point named, no stated audit-log retention policy, no explicit handling of how a `RETURNED` payout reconciles back into finance's books |
| **Stakeholder** (exec/business) | Risk, cost, time-to-market, scalability story | Greenfield rationale, AWS choices justified against DASH-proven patterns at real scale | No TCO/cost estimate, no phased timeline, no risk register for the Payouts API itself |

**The honest read:** the design is strongest on Customer / Developer / DevOps, because those map directly onto what's already proven at DASH. **Operation Team and Financial team are the thinnest** — the underlying data already supports both (the ledger, `SUBMITTED_UNCONFIRMED`, reconciliation), but there's no explicit ops-facing tooling or finance-integration story naming how those roles actually use it day to day. Naming that gap live is a stronger answer than claiming coverage that isn't there.

---

## Notes for the live walkthrough

- Lead with Assumption 2 (single vs. batch) early — it's the one most likely to get pushback/questions, and I want to show I've already weighed the alternative rather than have it "discovered" mid-walkthrough.
- Ask both rail-model open questions (§1) **before** diving into failure handling — the answers directly scope how much of §3.9 applies:
  - If caller-selects-rail: the rail-selection layer disappears entirely, failover-blocking in §3.9 goes away, `SUBMITTED_UNCONFIRMED` stays.
  - If platform-picks-rail with priority-ordered fallback: §3.9 applies in full.
  - If platform-picks-rail with true multi-rail scoring: need to add a selection/scoring step not currently designed.
  - Framing it this way shows the design is load-bearing on a real unknown, not a gap — it's a live conversation, not a mistake to defend.
- If asked to go deeper on any one area, reconciliation, the state machine, and the idempotency/correlation-id split (§3.9) are the strongest — direct extensions of the Dash Remittance work.
- Ask the funding model question (Assumption 4) early — it changes `POST /payouts` materially:
  - Prefunded wallet → `POST /payouts` can reject synchronously with `INSUFFICIENT_FUNDS`; needs a wallet resource
  - Atomic pull-and-pay → one API call, two failure surfaces; pull failure means nothing moves; simpler for caller, harder to reason about failures
- Be ready to admit: this design does not attempt to cover **treasury/cash-position** concerns (marked desirable in the JD, not required) — scope it out explicitly if asked, rather than improvising.
- If asked "who else does this touch beyond the API caller?" — go straight to §6. Naming the Operation Team / Financial team gaps unprompted lands better than waiting to be caught out on them.
