# Payouts API — Traffic Model, SLA & Proactive Alerting

> Companion to the Design Decision Record. Covers expected traffic, per-step execution budgets, audit table schema, and alert thresholds — so the system can monitor itself and page before a caller notices.

---

## 1. Traffic Model

### 1.1 Baseline assumptions

| Dimension | Assumption | Rationale |
|---|---|---|
| Active merchants | 500 | Mid-scale launch estimate |
| Avg payouts / merchant / day | 200 | Mix of marketplace, payroll, supplier payments |
| Daily payout volume | 100,000 | 500 × 200 |
| Operating hours | 18h effective (global corridors, not 24h flat) | Night-time volumes drop ~80% |
| Baseline TPS | ~1.5 TPS | 100k / (18 × 3600) |
| Peak multiplier | 5× | Payroll runs, end-of-month batch spikes |
| **Peak TPS** | **~8 TPS** | Design target for submission layer |
| Batch payouts | Up to 1,000 payouts per batch call | Each fans out to individual records |
| Batch peak contribution | +20 TPS burst during fan-out | Short-lived, absorbed by Kafka backpressure |

### 1.2 Traffic by step (steady state → peak)

| Step | Steady TPS | Peak TPS | Notes |
|---|---|---|---|
| `POST /payouts` (API acceptance) | 1.5 | 8 | Thin write — must beat gateway timeout |
| `GET /payouts/{id}` (status poll) | 6 | 30 | Callers poll ~4× per submitted payout |
| Compliance checks (fraud + AML) | 1.5 | 8 | 1:1 with submissions; async |
| Fund pull calls (Pull-and-Pay) | 1.5 | 8 | 1:1 with compliance passes |
| Disbursement rail calls | 1.5 | 8 | 1:1 with fund pulls |
| Webhook deliveries | 3 | 16 | ~2 events per payout (PENDING→SETTLED/FAILED) |
| Refund calls | 0.05 | 0.3 | ~3% disbursement failure rate assumed |

### 1.3 Kafka topic sizing

| Topic | Partitions | Retention | Consumer groups |
|---|---|---|---|
| `payout.created` | 12 | 7 days | compliance-service |
| `payout.compliance_passed` | 12 | 7 days | fund-pull-worker |
| `payout.funded` | 12 | 7 days | disbursement-worker |
| `payout.settled / failed / returned` | 12 | 30 days | webhook-dispatcher, refund-worker, reconciliation |
| `payout.refunded / refund_failed` | 6 | 30 days | ops-alerting, reconciliation |
| `payout.rejected_compliance` | 6 | 90 days | compliance-reporting (regulatory) |

---

## 2. Per-Step Execution Budget (SLA)

Each step has a **target** (P95 expected), a **warning threshold** (P99 / elevated latency), and a **critical threshold** (breach = page oncall).

### 2.1 Synchronous path (gateway-bounded — must complete within 30s total)

| Step | Target (P95) | Warning | Critical | Notes |
|---|---|---|---|---|
| Idempotency-Key dedup check (Redis) | < 5ms | > 20ms | > 100ms | Cache miss falls to Postgres |
| Idempotency-Key dedup check (Postgres fallback) | < 20ms | > 80ms | > 200ms | On Redis miss or cold start |
| Payout INSERT + commit (Postgres) | < 15ms | > 60ms | > 150ms | Minimal write — id, status, amount, key |
| Kafka publish (fire-and-forget) | < 10ms | > 50ms | > 200ms | Non-blocking — `202` sent before ack |
| **Total `POST /payouts` response time** | **< 50ms** | **> 200ms** | **> 1,000ms** | Hard ceiling: 30,000ms (API Gateway limit) |
| `GET /payouts/{id}` response time | < 20ms | > 100ms | > 500ms | Read from Postgres; cache with short TTL |

### 2.2 Asynchronous path (no gateway involvement)

| Step | Target (P95) | Warning | Critical | Notes |
|---|---|---|---|---|
| Kafka consumer lag (`payout.created`) | < 500ms | > 2s | > 10s | Time from publish to compliance-service pickup |
| Fraud check execution | < 300ms | > 1s | > 3s | Internal rules engine; should be fast |
| AML / sanctions scan | < 2s | > 5s | > 15s | External provider call; most variable step |
| Manual review queue wait | < 4h business hours | > 8h | > 24h | Human-paced; SLA is policy, not technical |
| Fund pull (PayRail debit) | < 3s | > 8s | > 20s | External bank/mandate provider |
| Disbursement rail call | < 5s | > 15s | > 45s | Most variable — depends on corridor |
| Kafka consumer lag (`payout.funded`) | < 500ms | > 2s | > 10s | Disbursement worker pickup |
| Webhook delivery (first attempt) | < 2s | > 5s | > 15s | Merchant endpoint; retry on failure |
| Refund execution | < 5s | > 15s | > 60s | Same rail as fund pull, reversed |

### 2.3 End-to-end payout time (wall clock, P95)

| Corridor / Type | Expected | Warning | Critical |
|---|---|---|---|
| Same-currency, no compliance gate | < 30s | > 2min | > 10min |
| Cross-currency, compliance pass (auto) | < 5min | > 15min | > 1h |
| Cross-currency, manual review | < 4h | > 8h | > 24h |
| International bank transfer (slow rail) | < 2 business days | > 3 days | > 5 days |

---

## 3. Audit Table Design

The audit table is the source of truth for per-step execution timing. It is **append-only** — one row per state transition, never updated. The payout `status` column in the main table is a mutable projection; the audit table is the immutable ledger.

### 3.1 Schema

```sql
CREATE TABLE payout_audit (
    id               BIGSERIAL PRIMARY KEY,
    payout_id        VARCHAR(40)  NOT NULL,
    correlation_id   VARCHAR(40)  NOT NULL,   -- per-attempt trace ID (not idempotency key)
    from_status      VARCHAR(40),             -- NULL for the first PENDING entry
    to_status        VARCHAR(40)  NOT NULL,
    triggered_by     VARCHAR(60)  NOT NULL,   -- 'api', 'compliance-service', 'fund-pull-worker',
                                              -- 'disbursement-worker', 'refund-worker', 'manual-review'
    worker_instance  VARCHAR(80),             -- pod/lambda ID for distributed tracing
    duration_ms      INTEGER,                 -- time spent IN this step (null for PENDING — no prior step)
    failure_reason   VARCHAR(80),             -- structured code if to_status is a failure state
    partner_ref      VARCHAR(120),            -- partner rail reference (for SUBMITTED and beyond)
    metadata         JSONB,                   -- arbitrary context: rail name, compliance provider, etc.
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payout_audit_payout_id  ON payout_audit (payout_id, created_at);
CREATE INDEX idx_payout_audit_to_status  ON payout_audit (to_status, created_at);
CREATE INDEX idx_payout_audit_corr       ON payout_audit (correlation_id);
```

### 3.2 Example audit trail — happy path (Pull-and-Pay)

| payout_id | from_status | to_status | triggered_by | duration_ms | created_at |
|---|---|---|---|---|---|
| pyo_001 | — | PENDING | api | — | 09:00:00.000 |
| pyo_001 | PENDING | PENDING_COMPLIANCE | compliance-service | 480ms | 09:00:00.480 |
| pyo_001 | PENDING_COMPLIANCE | FUND_PULLING | compliance-service | 1,840ms | 09:00:02.320 |
| pyo_001 | FUND_PULLING | SUBMITTED | fund-pull-worker | 2,100ms | 09:00:04.420 |
| pyo_001 | SUBMITTED | SETTLED | disbursement-worker | 3,650ms | 09:00:08.070 |

`duration_ms` = time this step took (i.e., `created_at` of this row minus `created_at` of the previous row for the same `payout_id`). Computed on insert by the worker, or derived in a view.

### 3.3 Step duration view (for alerting queries)

```sql
CREATE VIEW payout_step_durations AS
SELECT
    payout_id,
    to_status                                          AS step,
    triggered_by,
    duration_ms,
    failure_reason,
    created_at
FROM payout_audit
WHERE from_status IS NOT NULL;   -- exclude the initial PENDING insert
```

### 3.4 Fail rate view (rolling 5-minute window)

```sql
CREATE VIEW payout_fail_rate_5m AS
SELECT
    to_status                                          AS terminal_state,
    failure_reason,
    COUNT(*)                                           AS count,
    NOW() - INTERVAL '5 minutes'                       AS window_start
FROM payout_audit
WHERE created_at > NOW() - INTERVAL '5 minutes'
  AND to_status IN (
      'FAILED', 'FUND_PULL_FAILED', 'REJECTED_COMPLIANCE',
      'REFUND_FAILED', 'RETURNED'
  )
GROUP BY to_status, failure_reason;
```

---

## 4. Proactive Alert Definitions

Alerts fire before a caller notices. Each alert has a **condition**, a **severity**, and a **recommended first action**.

> **Prioritisation note:** 18 alerts are defined below — all are valid, but not all are equal. The 5 marked ☑ are the ones to implement first at MVP. They cover the highest-impact failure modes: two protect money in limbo, one covers API availability, one covers systemic rail failure, and one covers a silent risk that can cause double disbursement if left unresolved. The remaining alerts (☐) are important but can follow in a second instrumentation pass.

### 4.1 Latency alerts (per step)

| | Alert name | Condition | Severity | First action |
|---|---|---|---|---|
| ☐ | `POST_PAYOUTS_SLOW` | P95 response > 200ms over 2min | Warning | Check Postgres write latency, Redis hit rate |
| ☑ | `POST_PAYOUTS_CRITICAL` | P95 response > 1,000ms over 1min | Critical | Check DB connection pool, Kafka broker health. **Chosen because this is the only step where every caller is affected simultaneously — if the acceptance path is slow, the entire platform appears broken.** |
| ☐ | `COMPLIANCE_SLOW` | AML scan P95 > 5s over 5min | Warning | Check compliance provider API latency |
| ☐ | `COMPLIANCE_CRITICAL` | AML scan P95 > 15s over 2min | Critical | Circuit-break to manual review queue; alert compliance team |
| ☐ | `FUND_PULL_SLOW` | Fund pull P95 > 8s over 5min | Warning | Check PayRail API health |
| ☐ | `FUND_PULL_CRITICAL` | Fund pull P95 > 20s over 2min | Critical | Check mandate provider status page; consider pausing new submissions |
| ☐ | `DISBURSEMENT_SLOW` | Rail call P95 > 15s over 5min | Warning | Check partner rail status per corridor |
| ☐ | `DISBURSEMENT_CRITICAL` | Rail call P95 > 45s over 2min | Critical | Trip circuit breaker on affected rail; failover if available |
| ☐ | `KAFKA_LAG_WARNING` | Consumer lag > 2s on any topic | Warning | Check consumer group health, partition assignment |
| ☐ | `KAFKA_LAG_CRITICAL` | Consumer lag > 10s on any topic | Critical | Check broker, scale consumer pods |
| ☐ | `MANUAL_REVIEW_BACKLOG` | Queue depth > 50 pending items | Warning | Alert compliance ops team to review |
| ☐ | `MANUAL_REVIEW_SLA` | Any item age > 8h in queue | Critical | Escalate to compliance team lead |

### 4.2 Failure rate alerts

| | Alert name | Condition | Severity | First action |
|---|---|---|---|---|
| ☐ | `FAIL_RATE_ELEVATED` | Failed payouts > 5% of submissions in 5min | Warning | Check failure_reason distribution — systemic or isolated? |
| ☑ | `FAIL_RATE_CRITICAL` | Failed payouts > 15% of submissions in 5min | Critical | Identify corridor or rail causing spike; consider pausing. **Chosen because > 15% failure rate means a systemic rail problem is already affecting real merchant volume — every minute of delay compounds revenue and trust impact.** |
| ☐ | `FUND_PULL_FAIL_SPIKE` | FUND_PULL_FAILED > 3% in 5min | Warning | Check mandate provider; may indicate broad account issue |
| ☐ | `COMPLIANCE_REJECT_SPIKE` | REJECTED_COMPLIANCE > 2% in 5min | Warning | Check if sanctions list was updated; review rejection reasons |
| ☑ | `REFUND_FAILED_ANY` | Any REFUND_FAILED in 5min | Critical | Money with Boku — page oncall immediately, manual resolution. **Chosen because this is the only zero-tolerance state: money belongs to neither the beneficiary nor the caller. Every minute without resolution is a financial liability and potential regulatory breach. No acknowledgement window.** |
| ☐ | `DLQ_DEPTH_WARNING` | DLQ message count > 10 | Warning | Review DLQ contents — identify which step is exhausting retries |
| ☐ | `DLQ_DEPTH_CRITICAL` | DLQ message count > 50 | Critical | Stop new submissions to affected rail; alert engineering lead |
| ☑ | `SUBMITTED_UNCONFIRMED_AGE` | Any payout in SUBMITTED_UNCONFIRMED > 15min | Critical | Partner-reference lookup may be stuck; check rail status API. **Chosen because this is a silent risk with a hard deadline: if left unresolved and a failover is triggered without knowing the original outcome, the beneficiary gets paid twice. The 15min threshold gives the lookup time to complete under normal conditions.** |
| ☑ | `REFUND_PENDING_AGE` | Any payout in REFUND_PENDING > 30min | Critical | Refund worker may be stuck; money with Boku — escalate. **Chosen because a stuck refund means the caller's money is being held by the platform with no progress. This compounds quickly under load and becomes a regulatory issue in jurisdictions with mandated reversal timeframes.** |

### 4.3 Alert routing

| Severity | Channel | Response time |
|---|---|---|
| Warning | Slack `#payouts-alerts` | Acknowledge within 30min |
| Critical | PagerDuty → oncall engineer | Acknowledge within 5min |
| `REFUND_FAILED_ANY` | PagerDuty → oncall + engineering lead | Immediate — no acknowledgement window |
| `COMPLIANCE_REJECT_SPIKE` | Slack `#compliance-ops` + Warning channel | Compliance team reviews within 1h |

---

## 5. Recommended Dashboards (CloudWatch / Grafana)

| Dashboard | Key panels |
|---|---|
| **Payout Health** | Submission TPS, P50/P95/P99 response time, fail rate by reason, DLQ depth |
| **Step Latency** | Per-step P95 latency (compliance, fund pull, disbursement) — last 1h and 24h |
| **State Distribution** | Live count of payouts in each non-terminal state (PENDING_COMPLIANCE, FUND_PULLING, SUBMITTED, SUBMITTED_UNCONFIRMED, REFUND_PENDING, PENDING_MANUAL_REVIEW) |
| **Rail Health** | Per-rail success rate, P95 latency, circuit breaker state |
| **Refund Tracker** | REFUND_PENDING count + age, REFUND_FAILED count, REFUNDED count |
| **Compliance Pipeline** | Fraud pass/fail rate, AML hard/soft hit rate, manual review queue depth + age |
| **Kafka Lag** | Consumer lag per topic + consumer group, last 30min |

---

## 6. Ops Runbooks (stub — to be written)

| Scenario | Entry point |
|---|---|
| `SUBMITTED_UNCONFIRMED` > 15min | Query partner reference via rail status API; force-resolve in admin tool |
| `REFUND_FAILED` | Manual push via ops admin endpoint; escalate to finance for ledger reconciliation |
| `DLQ_DEPTH_CRITICAL` | Identify failing message type; fix root cause; replay from DLQ |
| Rail circuit breaker tripped | Verify rail is actually down; manually reset or failover via ops config |
| Compliance provider down | Route all new payouts to `PENDING_MANUAL_REVIEW` until provider recovers |

> Runbooks are named here as a gap — the data to support them exists (audit table, DLQ, structured error codes), but the step-by-step procedures need to be written before go-live.

---

## Notes for the live walkthrough

- Lead with the audit table — it's the single artefact that makes every other monitoring capability possible. Without append-only step records, you can't compute per-step duration, you can't build the state distribution panel, and you can't write the DLQ replay runbook.
- The `REFUND_FAILED_ANY` alert is the one to name explicitly — it's the only alert with no acknowledgement window. Every other alert has a grace period; this one pages immediately because money is in limbo.
- `SUBMITTED_UNCONFIRMED` age threshold (15min) and `REFUND_PENDING` age threshold (30min) are policy decisions, not technical ones — good to surface live and ask what Boku's tolerance is.
- The manual review SLA (4h / 8h warning / 24h critical) is also a policy question — regulatory obligations in some jurisdictions mandate a maximum hold time for a compliance-flagged payment.
