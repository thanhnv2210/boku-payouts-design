# Interview Walk-through — Speech Notes

> Aim for ~2 minutes per slide, ~40 minutes total. Slides 22–23 are not timed — they're a cue, not a script.
> On dense slides (8, 12, 13) — point at the code/table as you talk, don't read it line by line.
> Pause after Open Questions and invite them to answer — turns the last few minutes into a conversation.
> Slide 22 (Q&A) is a prompt for them, not a monologue for you. Put it up and stop talking.

---

## Slide 1 — Title

"Thanks for having me. I'm going to walk through a high-level design for a Payouts API — I'll cover the endpoints, the state machine, how I handle failures/ˈfeɪljər/, and the trade-offs I made along the way. I've also built a live demo we can play with at the end. Let's jump in."

---

## Slide 2 — The Task

"The brief was left open on purpose — design a Payouts API. The interesting choices aren't the endpoints themselves, they're the funding model and the failure/ˈfeɪljər/ paths. I picked Pull-and-Pay with a compliance gate as the showcase scenario, because it's the hardest one. It forces you to think through async compliance, a separate fund pull state, unclear network failures, and a full refund path. If you can design that well, the simpler prefunded model is just a subset."

---

## Slide 3 — 3 Assumptions

"Before I get into the design, three assumptions I had to resolve — because the task leaves them open and each one changes the architecture meaningfully. Async submission, platform picks the rail, and Pull-and-Pay as the primary flow. I'll unpack each one on the next slides."

---

## Slide 4 — Assumption 1: Async by Design

"The first one is the most important. When a caller hits POST /payouts, the actual funds movement can take anywhere from seconds to multiple business days depending on the corridor. So the API responds 202 Accepted immediately — thin DB write plus a Kafka publish, under 50ms P95. The alternative — waiting for the rail to confirm before responding — would tie our API's uptime to the slowest partner rail we're connected to. One slow corridor makes the entire API look down. That's not a trade-off I'm willing to make."

---

## Slide 5 — Assumption 2: Rail Selection

"Boku operates in 65 countries. Singapore, Kenya, and the US ride/raɪd/ completely different rails. My decision: the caller specifies what they want to do and who the beneficiary is — the platform decides how to route it. If I let callers pick the rail directly, I've exposed our internal partner setup in a public contract. Every time we bring on a new rail or change a partner, callers need to update their code. The platform-picks model keeps the caller API stable while giving us full flexibility on the routing layer."

---

## Slide 6 — Assumption 3: Pull-and-Pay

"Pull-and-Pay is more complex than a prefunded wallet, but it's the right showcase because it forces the complete design. The compliance gate must run before any funds move — that's a hard rule. Having FUND_PULLING as a separate state means that reaching SUBMITTED is a guarantee: funds are with Boku. That single insight removes an entire class of conditional logic in the refund worker — I'll come back to that when we get to refunds."

---

## Slide 7 — API Surface

"Nine/naɪn/ endpoints. The ones worth noting: GET /payouts?external_ref= is a recovery path — if the caller's system crashes before it can save the payout ID from the 202 response, they can look up by their own reference. POST /payouts/{id}/cancel is state-machine guarded/ˈɡɑːdɪd/ — not just a soft delete. And I've left out DELETE /payouts/{id} on purpose — funds-movement records are never deleted, only moved to terminal states. That's a financial audit trail requirement."

---

## Slide 8 — Payout State Machine

"The full state machine. Happy path is top: PENDING → compliance → fund pull → SUBMITTED → SETTLED. What I want to highlight is the two-layer write guard/ɡɑːd/. The obvious guard is UPDATE WHERE status = 'X' — that handles duplicate Kafka events from the same consumer. But it doesn't cover two separate writer types reading the same row at the same time — for example, a partner async callback and a midnight batch reconciliation both see SUBMITTED, both try to write SETTLED/ˈsetld/. Without a second guard, you get a duplicate audit row and a duplicate webhook. Optimistic locking with a version column closes this: rows_affected = 0 means you lost the race — discard silently."

---

## Slide 9 — Compliance Gate

"Compliance runs before any funds move. Fraud screening first — velocity checks, amount anomalies/əˈnɒməli/, beneficiary patterns. Then AML checks — OFAC, UN, EU, local sanctions/ˈsæŋkʃən/, PEP lists. A hard hit goes straight to REJECTED_COMPLIANCE, which is terminal. A soft hit — partial name match, for example — goes to PENDING_MANUAL_REVIEW. The key point: REJECTED_COMPLIANCE is not the same as FAILED. FAILED means a rail issue — possibly retryable. REJECTED_COMPLIANCE is a legal or policy block — retrying won't change the outcome, and in some countries it triggers a reporting obligation to regulators."

[ If they look unfamiliar with the terms — see Compliance Terms section at the bottom ]

---

## Slide 10 — SUBMITTED_UNCONFIRMED

"This is the scenario that keeps people up at night. We send the request to the partner rail, and then the connection drops. We don't know if the partner processed it. The two wrong answers are: trigger a refund right away — you might refund money that was already disbursed/dɪsˈbɜːs/ — or switch to a different partner rail — that's a double payment if the first partner already processed it. The right answer is: query the partner using the Idempotency-Key as a client reference. That lookup resolves/rɪˈzɑːlv/ the outcome clearly. SUBMITTED_UNCONFIRMED is a non-terminal state specifically to block switching rails until that query finishes."

---

## Slide 11 — Refund Trigger

"This table is simple because of the FUND_PULLING separation I mentioned earlier. The compliance states need no refund — nothing was debited/ˈdeb.ɪt/. FUND_PULL_FAILED needs no refund — the caller's account was never touched. But SUBMITTED is the guarantee that funds are with Boku. So any failure from SUBMITTED onwards triggers a refund every time — no boolean flags, no conditional logic. The refund worker does exactly one thing. And if the refund itself fails — REFUND_FAILED — that's zero tolerance/ˈtɒl.ər.əns/. Money is with Boku, held by neither party. Page oncall immediately, no waiting window."

---

## Slide 12 — Refund Design

"I introduced REFUND_REQUIRED as an intermediate/ˌɪn.təˈmiː.di.ət/ state between spotting the failure and running the refund, and the trade-off is user experience versus system stability. The immediate event-driven path gets money back faster — better for the merchant. But if you have a burst/bɜːst/ of disbursement failures, you also get a burst/bɜːst/ of refund rail calls all at once. The batch job path adds a few minutes of delay, but it gives you rate control, and the SELECT FOR UPDATE SKIP LOCKED pattern means two batch job instances can never pick up the same row. DB rows are also easy to retry — much easier than replaying a Kafka DLQ. If the SLA requires sub-minute refund initiation, you can keep event-driven but add a rate limiter per rail."

---

## Slide 13 — Cancellation

"Cancellation is only allowed before any external API call has been made. PENDING, PENDING_COMPLIANCE, and PENDING_MANUAL_REVIEW are cancellable — all Boku-internal steps, nothing external has been contacted. FUND_PULLING and beyond are not — the fund pull API has already been called and we're in an unknown in-flight state. The status code is 422 (Unprocessable Entity — the action cannot be done on this resource), not 409 (Conflict — resource state clash). 409 implies a retry might succeed. 422 is clear: the window is permanently closed. There's also a race condition to handle — if cancel and compliance-pass arrive at the same time. Optimistic locking handles that too: rows_affected = 0 means the status moved past the cancellable window while the cancel handler was running."

---

## Slide 14 — Idempotency

"Three layers, one principle. At ingress/ˈɪn.ɡres/, the Idempotency-Key plus a Postgres unique constraint in the same ACID transaction as the INSERT — so a duplicate key either returns the original response or hits the constraint violation, never creates two records. Internally, the UPDATE WHERE status = 'X' makes every Kafka consumer safe to retry. At egress, the same Idempotency-Key is forwarded as client_reference to every partner rail call — that's what makes the SUBMITTED_UNCONFIRMED lookup possible. The separation/ˌsep.əˈreɪ.ʃən/ between Idempotency-Key and Correlation-ID is intentional: the Key stays the same across all retries of one operation; the Correlation-ID is new per execution and threads through logs, events, and spans."

---

## Slide 15 — Observability

"The audit table is the foundation. Append-only, one row per state transition, never updated. The status column on the payouts table is a projection/prəˈdʒek.ʃən/ — a shortcut read cache. The audit table is the permanent ledger/ˈledʒ.ər/. duration_ms per step gives you P95 latency per stage — you can build a dashboard that tells you 'compliance is taking 15% longer than yesterday in the Singapore corridor'. triggered_by lets you filter to see everything a specific worker touched. And correlation_id connects through to distributed traces in X-Ray."

---

## Slide 16 — Top 5 Alerts

"I defined 18 alerts total, here are the five I'd call oncall for. The POST latency alert is highest priority because it's the only step where every caller is affected at the same time — any issue there is visible to customers instantly. The failure rate alert catches widespread rail problems before they grow. REFUND_FAILED is zero tolerance — no waiting window. SUBMITTED_UNCONFIRMED age is a hidden double-payment risk if we switch rails without resolving the lookup first. And REFUND_PENDING age is a regulatory issue in some countries — a caller's money stuck with Boku with no progress. The 15-minute and 30-minute thresholds are policy decisions, not technical ones — I'd want to confirm those with the team."

---

## Slide 17 — AWS Architecture

"The stack maps naturally to the state machine. API Gateway handles auth, rate limiting, and request validation at the edge. Six Spring Boot microservices on EKS — one per major concern. MSK for the event backbone — durable, ordered, replayable. RDS PostgreSQL as the system of record for the payout ledger/ˈledʒ.ər/ and audit table. Redis on ElastiCache for the sub-millisecond idempotency key check before we hit Postgres on every submission. Lambda plus EventBridge for the Refund Batch Job and the nightly reconciliation. Java 21 with Spring Boot matches the Boku stack — WebFlux on the Disbursement Worker and Fund Pull Worker specifically, because high fan-out to slow external rails is exactly the use case reactive is built for."

---

## Slide 18 — Stakeholder Coverage

"I want to be upfront about where this design is strong and where it's thin. Strong on customer, developer, and DevOps — those are direct extensions of patterns I've built before. Thinner on financial team and stakeholder — there's no GL integration point, no retention policy, no cost estimate, no step-by-step launch timeline. I've named these gaps clearly because I'd rather/ˈrɑː.ðər/ bring them up myself than have them raised as blind spots. Each one is solvable/ˈsɒl.və.bəl/, but they'd need input from the finance and product side."

---

## Slide 19 — Eight Design Gaps

"Eight gaps I found and addressed. The most interesting two: GDPR versus the append-only audit table — you can't erase/ɪˈreɪz/ a financial ledger/ˈledʒ.ər/, but you can store a HMAC token in the audit table and keep raw personal data only in the payouts table. Erasure/ɪˈreɪ.ʒər/ removes the personal data row without breaking the trail. And the PENDING_MANUAL_REVIEW timeout — I defaulted to 24 hours with auto-reject, but that's a compliance team policy decision and it must be shared with merchants in the SLA documentation."

---

## Slide 20 — Open Questions

"Three questions I'd want to answer in the first design review. The big one is whether Boku is a managed service where the platform picks the rail, or a pass-through layer where the caller specifies it. That changes the entire routing and failover story. Second, if the platform picks: priority-ordered fallback or a multi-rail scoring model? Third, prefunded wallet or Pull-and-Pay? If it's prefunded, the design gets much simpler — remove FUND_PULLING, FUND_PULL_FAILED, and the refund flow, replace with a wallet debit in the acceptance transaction. I designed for Pull-and-Pay because it's the harder case — but I'd want to confirm which model is actually in use."

[ PAUSE — invite them to answer the questions before moving to demo ]

---

## Slide 21 — Demo

"Let me show you the flow simulation — you can watch the state machine execute step by step and see exactly what webhook events a merchant would receive at each transition. It makes the async model concrete."

[ Open boku.thanhnguyen.dev and run a scenario ]

[ If they want to go deeper into the HTTP layer: ]
"There's also a live API Playground wired to a WireMock server if you'd like to hit the actual endpoints — pyo_SETTLED_001 for the happy path, pyo_UNCONF_001 for the unclear failure scenario."

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
"Eight attempts/əˈtempt/, exponential/ˌek.spəˈnen.ʃəl/ backoff from 1 second up to a 2-hour total window, 10-second timeout per attempt. Exhausted payouts go to a DLQ and trigger an ops alert. There's also a replay endpoint so support can manually re-trigger delivery without touching the payout record itself."

**"How do you handle the compliance SLA — what if review takes longer than 24 hours?"**
"24 hours is the default auto-reject threshold — policy decision, not a technical constraint. The compliance team sets that number. Whatever it is, it has to be shared with merchants in the SLA documentation so they know when to expect a resolution. The system auto-rejects with failure_reason = MANUAL_REVIEW_TIMEOUT and that's surfaced in the history endpoint."

**"Why PostgreSQL and not a NoSQL store?"**
"The payout ledger needs ACID guarantees — specifically for the optimistic locking and the idempotency key unique constraint. Both need to be atomic with the INSERT. NoSQL would force me to implement that in application code, which is harder to get right under load. The audit table is append-only and fits naturally in relational. If we needed to scale reads horizontally we'd add read replicas — the write path is a single record per payout so write throughput isn't the bottleneck."

---

## Compliance Terms — Quick Reference

> Use this if the interviewer looks unfamiliar when you mention these on Slide 9.

**AML — Anti-Money Laundering**
Checks that make sure money isn't being used to hide criminal activity. Every payment platform is legally required to run these. We screen each payout before funds move.

**OFAC — Office of Foreign Assets Control**
A US government list of individuals, companies, and countries that are banned from receiving money. If a beneficiary is on this list, the payment must be blocked. Applies globally — not just to US companies.

**UN / EU Sanctions Lists**
Same idea as OFAC but issued by the United Nations and the European Union. Together, OFAC + UN + EU cover the major international blocklists. Most corridors require checking all three.

**PEP — Politically Exposed Person**
Someone who holds (or recently held) a significant public position — politicians, senior government officials, judges, military leaders, and their close family. Not automatically blocked, but flagged for extra scrutiny because they carry higher risk of bribery or corruption. A PEP hit typically goes to PENDING_MANUAL_REVIEW, not REJECTED_COMPLIANCE.

**Hard hit vs. Soft hit**
- Hard hit = definite match (e.g. exact name on OFAC list) → auto-reject, no human review needed
- Soft hit = possible match (e.g. similar name, partial match) → route to a human reviewer to decide
