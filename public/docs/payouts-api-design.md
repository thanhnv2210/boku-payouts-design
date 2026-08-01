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

**Assumption 3 — Multiple disbursement rails per payout, selected by the platform, not the caller.**
*Scenario:* Boku is global (65 countries per the JD) — a payout to Singapore vs. Kenya vs. the US likely rides completely different rails (local bank transfer, mobile money, card push).
*Assumption:* The caller specifies **what** and **to whom** (amount, currency, beneficiary), not **how** (which rail/partner) — rail selection and failover is the platform's job, mirroring how DASH's FX orchestration picked and failed over between Thunes/Tranglo/WU without the caller knowing.
*Alternative considered:* Let the caller pick a specific rail/partner — rejected as a default because it leaks internal partner topology into a public contract, though I'd keep an optional `preferred_rail` hint for edge cases.

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
| **Webhook / callback** | An async, platform-initiated push notification to the caller when a payout's status changes. |
| **Correlation ID** | An ID threaded through every service/log/event tied to one payout, for tracing across the distributed system. |

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
PENDING → SUBMITTED → SETTLED           (happy path)
                    → FAILED             (rail rejects — terminal)
                    → RETURNED           (rail accepts, later reverses — terminal)
PENDING → CANCELLED                      (caller cancels before submission — terminal)
```

Every transition is a single-writer update guarded by the current state (`UPDATE ... WHERE status = 'PENDING'`), so two concurrent workers can never both advance the same payout — this is the same class of guard I used for the Dash transaction state machine.

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

---

## 4. Apply for AWS Cloud (example)

| Component | AWS Service | Why |
|---|---|---|
| Public API entry | **API Gateway** | Request validation, auth, rate limiting before traffic reaches compute — same pattern used for FX rate caching at DASH. |
| Payout services | **EKS** | Spring Boot services as containerized microservices — submission, state-machine worker, reconciliation, webhook-dispatcher as separate deployables. |
| Event backbone | **MSK (managed Kafka)** | Payout-created / status-changed events fan out to reconciliation, webhook dispatch, analytics without tight coupling. |
| System of record | **RDS PostgreSQL** | ACID guarantees for money movement; idempotency-key table and payout ledger need real transactions, not eventual consistency. |
| Retry / DLQ | **SQS + DLQ** | Per-rail retry queues with backoff; exhausted messages land in a dead-letter queue for follow-up, exactly like DASH's callback DLQ. |
| Idempotency fast-path | **ElastiCache (Redis)** | Sub-millisecond duplicate-key check before hitting Postgres, under high submission volume. |
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

## Notes for the live walkthrough

- Lead with Assumption 2 (single vs. batch) early — it's the one most likely to get pushback/questions, and I want to show I've already weighed the alternative rather than have it "discovered" mid-walkthrough.
- If asked to go deeper on any one area, reconciliation and the state machine are the strongest — direct extensions of the Dash Remittance work.
- Be ready to admit: this design does not attempt to cover **treasury/cash-position** concerns (marked desirable in the JD, not required) — scope it out explicitly if asked, rather than improvising.
