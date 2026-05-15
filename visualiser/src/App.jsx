import { useState } from 'react'
import hardwareData from './output.json'

export default function App() {
  return (
    <div style={{ padding: '40px', fontFamily: 'system-ui, sans-serif', backgroundColor: '#f8fafc', minHeight: '100vh' }}>
      <h1 style={{ fontSize: '2rem', marginBottom: '20px', color: '#0f172a' }}>
        Auto Datapath Synthesizer
      </h1>
      
      <div style={{ display: 'flex', gap: '40px' }}>
        {/* Datapath Column */}
        <div style={{ flex: 1, backgroundColor: 'white', padding: '20px', borderRadius: '8px', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}>
          <h2 style={{ borderBottom: '2px solid #e2e8f0', paddingBottom: '10px' }}>Allocated Datapath</h2>
          {hardwareData.datapath.map((comp, idx) => (
            <div key={idx} style={{ padding: '12px', margin: '10px 0', backgroundColor: '#f1f5f9', borderRadius: '6px', borderLeft: '4px solid #3b82f6' }}>
              <strong>{comp.type}</strong>: {comp.id}
              {comp.target && <div style={{ fontSize: '0.9em', color: '#64748b' }}>Routes to ➔ {comp.target}</div>}
            </div>
          ))}
        </div>

        {/* Control Path Column */}
        <div style={{ flex: 1, backgroundColor: 'white', padding: '20px', borderRadius: '8px', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}>
          <h2 style={{ borderBottom: '2px solid #e2e8f0', paddingBottom: '10px' }}>Control Path (FSM)</h2>
          {hardwareData.fsm.map((state, idx) => (
            <div key={idx} style={{ padding: '12px', margin: '10px 0', backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '6px' }}>
              <strong style={{ color: '#10b981' }}>State {state.id}</strong>
              
              <ul style={{ margin: '10px 0', paddingLeft: '20px' }}>
                {state.actions.map((act, i) => (
                  <li key={i} style={{ fontFamily: 'monospace' }}>
                    {act.target} = {act.expression}
                  </li>
                ))}
              </ul>
              
              <div style={{ fontSize: '0.9em', color: '#64748b', marginTop: '10px', paddingTop: '10px', borderTop: '1px dashed #cbd5e1' }}>
                {state.next.type === 'Goto' && `Jump to State ${state.next.target_id}`}
                {state.next.type === 'Branch' && `If (${state.next.condition}) ➔ State ${state.next.true_id} else ➔ State ${state.next.false_id}`}
                {state.next.type === 'Done' && 'HALT'}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}