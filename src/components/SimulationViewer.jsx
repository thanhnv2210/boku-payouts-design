import { useState, useEffect, useRef } from 'react'
import { SCENARIOS, STATUS_KIND } from '../data/scenarios'
import MerchantPhone from './MerchantPhone'

const WORKER_LABELS = {
  'api':                 'API Gateway',
  'compliance-service':  'Compliance Service',
  'fund-pull-worker':    'Fund Pull Worker',
  'disbursement-worker': 'Disbursement Worker',
  'refund-batch-job':    'Refund Batch Job',
  'manual-review':       'Manual Review',
}

function StatusBadge({ status }) {
  return (
    <span className={`sim-badge sim-badge--${STATUS_KIND[status] || 'neutral'}`}>
      {status}
    </span>
  )
}

export default function SimulationViewer() {
  const [selectedId, setSelectedId] = useState(SCENARIOS[0].id)
  const [running, setRunning] = useState(false)
  const [currentStep, setCurrentStep] = useState(-1)  // -1 = not started
  const [auditRows, setAuditRows] = useState([])
  const [done, setDone] = useState(false)
  const timeoutsRef = useRef([])
  const auditBottomRef = useRef(null)

  const scenario = SCENARIOS.find(s => s.id === selectedId)

  function reset() {
    timeoutsRef.current.forEach(clearTimeout)
    timeoutsRef.current = []
    setRunning(false)
    setCurrentStep(-1)
    setAuditRows([])
    setDone(false)
  }

  function selectScenario(id) {
    reset()
    setSelectedId(id)
  }

  function run() {
    reset()
    setRunning(true)

    let elapsed = 0
    const startTime = Date.now()

    scenario.steps.forEach((step, index) => {
      elapsed += step.delayMs
      const stepElapsed = elapsed   // capture before closure — elapsed will keep mutating
      const t = setTimeout(() => {
        const now = new Date(startTime + stepElapsed).toISOString().replace('T', ' ').slice(0, 23)
        setCurrentStep(index)
        setAuditRows(prev => {
          const fromStatus = index === 0 ? null : scenario.steps[index - 1].status
          return [...prev, {
            id: index,
            fromStatus,
            toStatus: step.status,
            triggeredBy: step.triggeredBy,
            durationMs: index === 0 ? null : step.delayMs,
            note: step.note,
            at: now,
          }]
        })
        if (index === scenario.steps.length - 1) {
          setRunning(false)
          setDone(true)
        }
      }, elapsed)
      timeoutsRef.current.push(t)
    })
  }

  // Scroll audit table to bottom as rows are added
  useEffect(() => {
    if (auditBottomRef.current) {
      auditBottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [auditRows])

  // Clean up on unmount
  useEffect(() => () => timeoutsRef.current.forEach(clearTimeout), [])

  const currentStatus = currentStep >= 0 ? scenario.steps[currentStep].status : null

  return (
    <div className="viewer-content sim-root">

      {/* Scenario selector */}
      <div className="sim-selector">
        <h2 className="sim-heading">Flow Simulation</h2>
        <p className="sim-subheading">Select a scenario, click Run, and watch the state machine execute step by step.</p>
        <div className="sim-cards">
          {SCENARIOS.map(s => (
            <button
              key={s.id}
              className={`sim-card ${s.id === selectedId ? 'sim-card--active' : ''}`}
              onClick={() => selectScenario(s.id)}
              disabled={running}
            >
              <span className="sim-card-title">{s.title}</span>
              <span className="sim-card-desc">{s.description}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Controls */}
      <div className="sim-controls">
        {!running && !done && (
          <button className="sim-btn sim-btn--run" onClick={run}>▶ Run</button>
        )}
        {running && (
          <button className="sim-btn sim-btn--stop" onClick={reset}>■ Stop</button>
        )}
        {done && (
          <button className="sim-btn sim-btn--run" onClick={run}>↺ Run Again</button>
        )}
        {(currentStep >= 0) && (
          <button className="sim-btn sim-btn--reset" onClick={reset} disabled={running}>Reset</button>
        )}
      </div>

      {/* Side-by-side layout: internal view (left) + merchant phone (right) */}
      <div className="sim-layout">
      <div className="sim-left">

      {/* State pipeline */}
      <div className="sim-pipeline">
        {scenario.steps.map((step, i) => {
          const active = i === currentStep
          const past = i < currentStep
          const future = i > currentStep
          return (
            <div key={i} className={`sim-node ${active ? 'sim-node--active' : ''} ${past ? 'sim-node--past' : ''} ${future ? 'sim-node--future' : ''}`}>
              <div className={`sim-node-badge sim-badge--${STATUS_KIND[step.status] || 'neutral'}`}>
                {step.status}
              </div>
              <div className="sim-node-worker">{WORKER_LABELS[step.triggeredBy] || step.triggeredBy}</div>
              {i < scenario.steps.length - 1 && (
                <div className={`sim-node-arrow ${past || active ? 'sim-node-arrow--live' : ''}`}>→</div>
              )}
            </div>
          )
        })}
      </div>

      {/* Current step note */}
      {currentStep >= 0 && (
        <div className={`sim-note sim-note--${STATUS_KIND[currentStatus] || 'neutral'}`}>
          <strong>{currentStatus}</strong>
          <span> — {scenario.steps[currentStep].note}</span>
        </div>
      )}

      {/* Audit trail table */}
      {auditRows.length > 0 && (
        <div className="sim-audit">
          <h3 className="sim-audit-heading">payout_audit — live trail</h3>
          <div className="sim-audit-scroll">
            <table className="sim-audit-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>from_status</th>
                  <th>to_status</th>
                  <th>triggered_by</th>
                  <th>duration_ms</th>
                  <th>at</th>
                </tr>
              </thead>
              <tbody>
                {auditRows.map(row => (
                  <tr key={row.id} className="sim-audit-row">
                    <td className="sim-audit-id">{row.id + 1}</td>
                    <td>{row.fromStatus ? <StatusBadge status={row.fromStatus} /> : <span className="sim-null">—</span>}</td>
                    <td><StatusBadge status={row.toStatus} /></td>
                    <td><code>{row.triggeredBy}</code></td>
                    <td>{row.durationMs != null ? <span className="sim-duration">{row.durationMs.toLocaleString()} ms</span> : <span className="sim-null">—</span>}</td>
                    <td className="sim-at">{row.at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div ref={auditBottomRef} />
          </div>
          {auditRows[auditRows.length - 1] && (
            <p className="sim-audit-note">{auditRows[auditRows.length - 1].note}</p>
          )}
        </div>
      )}

      {done && (
        <div className={`sim-done sim-done--${STATUS_KIND[scenario.steps[scenario.steps.length - 1].status] || 'neutral'}`}>
          Terminal state reached: <strong>{scenario.steps[scenario.steps.length - 1].status}</strong>
        </div>
      )}

      </div>{/* /sim-left */}

      <MerchantPhone scenario={scenario} currentStep={currentStep} done={done} auditRows={auditRows} />
      </div>{/* /sim-layout */}
    </div>
  )
}
