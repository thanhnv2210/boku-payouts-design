# Interview Walk-through — Speech Notes

> Aim for ~2 minutes per slide, ~40 minutes total. Slides 22–23 are not timed — they're a cue, not a script.
> On dense slides (8, 12, 13) — point at the code/table as you talk, don't read it line by line.
> Pause after Open Questions and invite them to answer — turns the last few minutes into a conversation.
> Slide 22 (Q&A) is a prompt for them, not a monologue for you. Put it up and stop talking.

---

## Slide 1 — Title

"Thanks for having me. I'm going to walk through a high-level design for a Payouts API — I'll cover the endpoints, the state machine, how I handle failures, and the trade-offs I made along the way. I've also built a live demo we can play with at the end. Let's jump in."

---

## Slide 2 — The Task

"The brief was deliberately open-ended — design a Payouts API. The interesting choices aren't the endpoints themselves, they're the funding model and the failure paths. I picked Pull-and-Pay with a compliance gate as the showcase scenario, because it's the hardest one. It forces you to think through async compliance, a separate fund pull state, ambiguous network failures, and a full refund path. If you can design that well, the simpler prefunded model is just a subset."

---

## Slide 3 — 3 Assumptions

"Before I get into the design, three assumptions I had to resolve — because the task leaves them open and each one changes the architecture meaningfully. Async submission, platform picks the rail, and Pull-and-Pay as the primary flow. I'll unpack each one on the next slides."

---

## Slide 4 — Assumption 1: Async by Design

"The first one is the most foundational. When a caller hits POST /payouts, the actual funds movement can take anywhere from seconds to multiple business days depending on the corridor. So the API responds 202 Accepted immediately — thin DB write plus a Kafka publish, under 50ms P95. The alternative — waiting for the rail to confirm before responding — would couple our API's availability to the slowest partner rail we're connected to. One slow corridor makes the entire API look down. That's not a trade-off I'm willing to make."

---

## Slide 5 — Assumption 2: Rail Selection

"Boku operates in 65 countries. Singapore, Kenya, and the US ride completely different rails. My decision: the caller specifies what they want to do and who the beneficiary is — the platform decides how to route it. If I let callers specify the rail explicitly, I've leaked internal partner topology into a public contract. Every time we onboard a new rail or change a partner, callers need to update their code. The platform-picks model keeps the caller API stable while giving us full flexibility on the routing layer."

---

## Slide 6 — Assumption 3: Pull-and-Pay

"Pull-and-Pay is more complex than a prefunded wallet, but it's the right showcase because it forces the complete design. The compliance gate must run before any funds move — that's a hard constraint. Having FUND_PULLING as an explicit state means that reaching SUBMITTED is a guarantee: funds are with Boku. That single insight eliminates an entire class of conditional logic in the refund worker — I'll come back to that when we get to refunds."

---

## Slide 7 — API Surface

"Nine endpoints. The ones worth noting: GET /payouts?external_ref= is a recovery path — if the caller's system crashes before it can persist the payout ID from the 202 response, they can look up by their own reference. POST /payouts/{id}/cancel is state-machine guarded — not just a soft delete. And I've deliberately left out DELETE /payouts/{id} — funds-movement records are never deleted, only transitioned to terminal states. That's a financial audit trail requirement."

---

## Slide 8 — Payout State Machine

"The full state machine. Happy path is top: PENDING → compliance → fund pull → SUBMITTED → SETTLED. What I want to highlight is the two-layer write guard. The obvious guard is UPDATE WHERE status = 'X' — that handles duplicate Kafka events from the same consumer. But it doesn't cover two independent writer types reading the same row simultaneously — for example, a partner async callback and a midnight batch reconciliation both see SUBMITTED, both try to write SETTLED. Without a second guard, you get a duplicate audit row and potentially a duplicate webhook. Optimistic locking with a version column closes this: rows_affected = 0 means you lost the race — discard silently."

---

## Slide 9 — Compliance Gate

"Compliance runs before any funds move. Fraud screening first — velocity checks, amount anomalies, beneficiary patterns. Then AML — OFAC, UN, EU, local sanctions, PEP lists. A hard hit goes straight to REJECTED_COMPLIANCE, which is terminal. A soft hit — partial name match, for example — goes to PENDING_MANUAL_REVIEW. The key distinction: REJECTED_COMPLIANCE is not the same as FAILED. FAILED means a rail issue — potentially retryable. REJECTED_COMPLIANCE is a legal or policy block — retrying won't change the outcome, and in some jurisdictions it triggers a regulatory reporting obligation."

---

## Slide 10 — SUBMITTED_UNCONFIRMED

"This is the scenario that keeps people up at night. We submit to the partner rail, and then the connection drops. We don't know if the partner processed it. The two wrong answers are: trigger a refund immediately — you might refund money that was already disbursed — or failover to a different partner rail — that's a double payment if the first partner processed it. The right answer is: query the partner using the Idempotency-Key as a client reference. That lookup resolves the outcome deterministically. SUBMITTED_UNCONFIRMED is a non-terminal state specifically to block failover until that query completes."

---

## Slide 11 — Refund Trigger

"This table is simple because of the FUND_PULLING separation I mentioned earlier. The compliance states need no refund — nothing was debited. FUND_PULL_FAILED needs no refund — the caller's account was never touched. But SUBMITTED is the guarantee that funds are with Boku. So any failure from SUBMITTED onwards triggers a refund unconditionally — no boolean flags, no conditional logic. The refund worker does exactly one thing. And if the refund itself fails — REFUND_FAILED — that's zero tolerance. Money is with Boku, held by neither party. Page oncall immediately, no acknowledgement window."

---

## Slide 12 — Refund Design

"I introduced REFUND_REQUIRED as an intermediate state between detection and execution, and the trade-off is user satisfaction versus system resilience. The immediate event-driven path gets money back faster — better for the merchant. But if you have a burst of disbursement failures, you also get a burst of simultaneous refund rail calls. The batch job path adds up to a few minutes of delay, but it gives you rate control, and the SELECT FOR UPDATE SKIP LOCKED pattern means two batch job instances can never pick up the same row. DB rows are also trivially reprocessable — much easier than replaying a Kafka DLQ. If the SLA requires sub-minute refund initiation, you can keep event-driven but add a token bucket rate limiter per rail."

---

## Slide 13 — Cancellation

"Cancellation is only permitted before any external API call has been made. PENDING, PENDING_COMPLIANCE, and PENDING_MANUAL_REVIEW are cancellable — all Boku-internal steps, nothing external has been contacted. FUND_PULLING and beyond are not — the fund pull API has already been called and we're in an unknown mid-flight state. The status code is 422, not 409. 409 implies a retry might succeed. 422 is unambiguous: the window is permanently closed. There's also a race condition to handle — if cancel and compliance-pass arrive simultaneously. Optimistic locking handles that too: rows_affected = 0 means the status advanced past the cancellable window while the cancel handler was running."

---

## Slide 14 — Idempotency

"Three layers, one principle. At ingress, the Idempotency-Key plus a Postgres unique constraint in the same ACID transaction as the INSERT — so a duplicate key either returns the original response or races to the constraint violation, never creates two records. Internally, the UPDATE WHERE status = 'X' makes every Kafka consumer idempotent. At egress, the same Idempotency-Key is forwarded as client_reference to every partner rail call — that's what enables the SUBMITTED_UNCONFIRMED lookup to work. The separation between Idempotency-Key and Correlation-ID is deliberate: the Key is stable across all retries of a logical operation; the Correlation-ID is generated fresh per execution and threads through logs, events, and spans."

---

## Slide 15 — Observability

"The audit table is the foundation. Append-only, one row per state transition, never updated. The status column on the payouts table is a projection — a convenience read cache. The audit table is the immutable ledger. duration_ms per step gives you P95 latency per stage — you can build a dashboard that tells you 'compliance is taking 15% longer than yesterday in the Singapore corridor'. triggered_by means you can filter to see everything a specific worker touched. And correlation_id threads through to distributed traces in X-Ray."

---

## Slide 16 — Top 5 Alerts

"I defined 18 alerts total, here are the five I'd page oncall for. The POST latency alert is highest priority because it's the only step where every caller is simultaneously affected — any issue there is customer-visible instantly. The failure rate alert catches systemic rail problems before they compound. REFUND_FAILED is zero tolerance — no acknowledgement window. SUBMITTED_UNCONFIRMED age is a silent double-payment risk if we accidentally failover without resolving the lookup first. And REFUND_PENDING age is a regulatory issue in some jurisdictions — a caller's money stuck with Boku with no progress. The 15-minute and 30-minute thresholds are policy decisions, not technical ones — I'd want to confirm those with the team."

---

## Slide 17 — AWS Architecture

"The stack maps naturally to the state machine. API Gateway handles auth, rate limiting, and request validation at the edge. Six Spring Boot microservices on EKS — one per major concern. MSK for the event backbone — durable, ordered, replayable. RDS PostgreSQL as the system of record for the payout ledger and audit table. Redis on ElastiCache for the sub-millisecond idempotency key check before we hit Postgres on every submission. Lambda plus EventBridge for the Refund Batch Job and the nightly reconciliation. Java 21 with Spring Boot matches the Boku stack — WebFlux on the Disbursement Worker and Fund Pull Worker specifically, because high fan-out to slow external rails is exactly the use case reactive is built for."

---

## Slide 18 — Stakeholder Coverage

"I want to be honest about where this design is strong and where it's thin. Strong on customer, developer, and DevOps — those are direct extensions of patterns I've built before. Thinner on financial team and stakeholder — there's no GL integration point, no retention policy, no TCO estimate, no phased rollout timeline. I've named these gaps explicitly because I'd rather surface them here than have them raised as blind spots. Each one is solvable, but they'd need input from the finance and product side."

---

## Slide 19 — Eight Design Gaps

"Eight gaps I identified and addressed. The most interesting two: GDPR versus the append-only audit table — you can't erase a financial ledger, but you can store a HMAC token in the audit table and keep raw PII only in the payouts table. Erasure removes the PII row without corrupting the trail. And the PENDING_MANUAL_REVIEW timeout — I defaulted to 24 hours with auto-reject, but that's a compliance team policy decision and it must be disclosed to merchants in the SLA documentation."

---

## Slide 20 — Open Questions

"Three questions I'd want to resolve in the first design review. The big one is whether Boku is a managed service where the platform picks the rail, or a connectivity layer where the caller specifies it. That changes the entire routing and failover story. Second, if the platform picks: priority-ordered fallback or a multi-rail scoring model? Third, prefunded wallet or Pull-and-Pay? If it's prefunded, the design simplifies significantly — remove FUND_PULLING, FUND_PULL_FAILED, and the refund flow, replace with a synchronous wallet debit in the acceptance transaction. I designed for Pull-and-Pay because it's the harder case — but I'd want to confirm which model is actually in use."

[ PAUSE — invite them to answer the questions before moving to demo ]

---

## Slide 21 — Demo

"Let me show you the live system. This is the API Playground pointed at a WireMock instance running on Railway — real HTTP calls. Try pyo_SETTLED_001 first for the happy path with full timing in the history. Then pyo_UNCONF_001 for the SUBMITTED_UNCONFIRMED scenario. And there's a flow simulation on the main site where you can watch the state machine execute step by step alongside what a merchant would see as webhook events arrive — let me pull that up."

---

## Slide 22 — Q&A

[ Put the slide up. Don't read the bullet list. ]

"Happy to go wherever is most useful — state machine edge cases, the compliance gate, the refund design, the AWS choices, or anything I glossed over."

[ Then stop talking. Let them lead. ]

---

## Slide 23 — Thank You

"Thanks for the time — I enjoyed working through this. I'll leave the site up at boku.thanhnguyen.dev if you want to share it or come back to any of the diagrams."

[ If they have closing logistics — offer times, next steps — just listen and respond naturally. No script needed. ]

---

## Handling Common Questions

**"Why not just poll instead of webhooks?"**
"Polling works but it's expensive — every caller hammering GET /payouts/{id} every few seconds under load. Webhooks push the event once. I'd offer both — polling as the safe fallback for callers who can't receive inbound HTTP, webhooks as the efficient primary. The GET endpoint is always the source of truth either way."

**"What happens if the webhook delivery fails?"**
"Eight attempts, exponential backoff from 1 second up to a 2-hour total window, 10-second timeout per attempt. Exhausted payouts go to a DLQ and trigger an ops alert. There's also a replay endpoint so support can manually re-trigger delivery without touching the payout record itself."

**"How do you handle the compliance SLA — what if review takes longer than 24 hours?"**
"24 hours is the default auto-reject threshold — policy decision, not a technical constraint. The compliance team sets that number. Whatever it is, it has to be disclosed to merchants in the SLA documentation so they know when to expect a resolution. The system auto-rejects with failure_reason = MANUAL_REVIEW_TIMEOUT and that's surfaced in the history endpoint."

**"Why PostgreSQL and not a NoSQL store?"**
"The payout ledger needs ACID guarantees — specifically for the optimistic locking and the idempotency key unique constraint. Both need to be atomic with the INSERT. NoSQL would force me to implement that in application code, which is harder to get right under concurrent load. The audit table is append-only and fits naturally in relational. If we needed to scale reads horizontally we'd add read replicas — the write path is a single record per payout so write throughput isn't the bottleneck."
