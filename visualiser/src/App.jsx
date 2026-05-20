/**
 * App.jsx  —  Auto Datapath Synthesiser
 *
 * Changes in this revision:
 *   • Removed static `import hardwareData from './output.json'`
 *   • Added Monaco Editor (left panel, above playback controls)
 *   • Added POST /synthesize API call + loading / error states
 *   • hardwareData is now React state; simulation resets on each new synthesis
 *   • useSimulationEngine now receives hardwareData as a prop (not a static import)
 *   • All existing features (React Flow, Dagre, FSM panel, fault injection) preserved
 */

import React, { useState, useCallback, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  MarkerType,
} from 'reactflow';
import 'reactflow/dist/style.css';
import dagre from 'dagre';

import { hwNodeTypes } from './components/HardwareNodes';
import useSimulationEngine from './hooks/useSimulationEngine';

// ─── Colour tokens ────────────────────────────────────────────────────────────
const C = {
  bg:     '#0f1117',
  bg2:    '#161b27',
  bg3:    '#1c2236',
  border: '#252d42',
  border2:'#303d5c',
  text:   '#dde3f0',
  text2:  '#7a88a8',
  text3:  '#4a566e',
  accent: '#5b8af5',
  green:  '#3ddc97',
  amber:  '#f5a623',
  red:    '#f05060',
  purple: '#a78bfa',
  cyan:   '#39c5cf',
  wire:   '#303d5c',
};

// ─── Wire colour semantics ────────────────────────────────────────────────────
const WIRE = {
  idle:     { stroke: C.wire,   strokeWidth: 1.5 },
  data:     { stroke: C.green,  strokeWidth: 2.5, animated: true },
  ctrl:     { stroke: C.amber,  strokeWidth: 2,   animated: true },
  alu:      { stroke: C.cyan,   strokeWidth: 2.5, animated: true },
  feedback: { stroke: C.purple, strokeWidth: 2,   animated: true },
};

const NODE_W = 120;
const NODE_H = 80;

// ─── Default algorithm shown in the editor on first load ─────────────────────
const DEFAULT_CODE = `// Square-and-Multiply — modular exponentiation kernel
// Inputs:  r (accumulator), b (base), e (exponent), i (counter)
// Outputs: r  (result after 8 iterations)

while (i < 8) {
  r = r * r;
  b = b * b;
  i = i + 1;
}
`;

// ─── Dagre auto-layout ────────────────────────────────────────────────────────
function getLayoutedElements(nodes, edges, direction = 'TB') {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    ranksep: 80,
    nodesep: 50,
    edgesep: 20,
    marginx: 40,
    marginy: 40,
  });

  nodes.forEach((node) => {
    g.setNode(node.id, { width: NODE_W, height: NODE_H });
  });
  edges.forEach((edge) => {
    g.setEdge(edge.source, edge.target);
  });

  dagre.layout(g);

  const layoutedNodes = nodes.map((node) => {
    const { x, y } = g.node(node.id);
    return {
      ...node,
      position: { x: x - NODE_W / 2, y: y - NODE_H / 2 },
    };
  });

  return { nodes: layoutedNodes, edges };
}

// ─── Build nodes from simulation state ───────────────────────────────────────
function buildNodes(simState, inputs) {
  const s      = simState?.signals ?? {};
  const ldR    = !!s['Ld_R'];
  const ldB    = !!s['Ld_B'];
  const ldE    = !!s['Ld_E'];
  const ldI    = !!s['Ld_I'];
  const shiftE = !!s['Shift_E'];
  const aluActive = !!s['ALU_Mul'];

  return [
    {
      id: 'ALU', type: 'alu', position: { x: 0, y: 0 },
      data: { label: '×', isActive: aluActive, operation: 'r×r  /  b×b' },
    },
    {
      id: 'Mux_r', type: 'mux', position: { x: 0, y: 0 },
      data: { label: 'MUX', sel: s['MuxSel_R'] ?? 0, isActive: ldR,
              inputs: [`r_in = ${inputs?.r_in ?? '?'}`, 'r×r  (ALU)'] },
    },
    {
      id: 'Mux_b', type: 'mux', position: { x: 0, y: 0 },
      data: { label: 'MUX', sel: s['MuxSel_B'] ?? 0, isActive: ldB,
              inputs: [`b_in = ${inputs?.b_in ?? '?'}`, 'b×b  (ALU)'] },
    },
    {
      id: 'Reg_r', type: 'register', position: { x: 0, y: 0 },
      data: { label: 'Reg_r', regKey: 'r', value: simState?.Reg_r ?? 0,
              isActive: ldR, activeSignal: 'Ld_R' },
    },
    {
      id: 'Reg_b', type: 'register', position: { x: 0, y: 0 },
      data: { label: 'Reg_b', regKey: 'b', value: simState?.Reg_b ?? 0,
              isActive: ldB, activeSignal: 'Ld_B' },
    },
    {
      id: 'Reg_e', type: 'register', position: { x: 0, y: 0 },
      data: { label: 'Reg_e', regKey: 'e', value: simState?.Reg_e ?? 0,
              isActive: ldE || shiftE, activeSignal: ldE ? 'Ld_E' : 'Shift_E' },
    },
    {
      id: 'Reg_i', type: 'register', position: { x: 0, y: 0 },
      data: { label: 'Reg_i', regKey: 'i', value: simState?.Reg_i ?? 0,
              isActive: ldI, activeSignal: 'Ld_I' },
    },
  ];
}

// ─── Build edges from simulation state ───────────────────────────────────────
function buildEdges(simState) {
  const s        = simState?.signals ?? {};
  const aluActive = !!s['ALU_Mul'];
  const ldR      = !!s['Ld_R'];
  const ldB      = !!s['Ld_B'];
  const muxSelR  = s['MuxSel_R'] ?? 0;
  const muxSelB  = s['MuxSel_B'] ?? 0;

  const mk = (id, source, sourceHandle, target, targetHandle, wire) => ({
    id, source, sourceHandle, target, targetHandle,
    type: 'smoothstep',
    style:    { stroke: wire.stroke, strokeWidth: wire.strokeWidth },
    animated: wire.animated ?? false,
    markerEnd: { type: MarkerType.ArrowClosed, color: wire.stroke, width: 14, height: 14 },
  });

  return [
    mk('reg_r-alu',   'Reg_r', 'dout', 'ALU',   'a',   aluActive ? WIRE.alu      : WIRE.idle),
    mk('reg_b-alu',   'Reg_b', 'dout', 'ALU',   'b',   aluActive ? WIRE.alu      : WIRE.idle),
    mk('alu-mux_r',   'ALU',   'y',    'Mux_r', 'in1', (aluActive && muxSelR===1) ? WIRE.feedback : WIRE.idle),
    mk('alu-mux_b',   'ALU',   'y',    'Mux_b', 'in1', (aluActive && muxSelB===1) ? WIRE.feedback : WIRE.idle),
    mk('mux_r-reg_r', 'Mux_r', 'out',  'Reg_r', 'din', ldR ? WIRE.data : WIRE.idle),
    mk('mux_b-reg_b', 'Mux_b', 'out',  'Reg_b', 'din', ldB ? WIRE.data : WIRE.idle),
  ];
}

// ─── All known control signals ────────────────────────────────────────────────
const ALL_SIGNALS = [
  { key: 'Ld_R',     label: 'Ld_R',     color: C.amber,  desc: 'Load enable — Reg_r' },
  { key: 'Ld_B',     label: 'Ld_B',     color: C.amber,  desc: 'Load enable — Reg_b' },
  { key: 'Ld_E',     label: 'Ld_E',     color: C.amber,  desc: 'Load enable — Reg_e (exponent)' },
  { key: 'Ld_I',     label: 'Ld_I',     color: C.amber,  desc: 'Load enable — Reg_i (counter)' },
  { key: 'Shift_E',  label: 'Shift_E',  color: C.purple, desc: 'Right-shift Reg_e by 1' },
  { key: 'MuxSel_R', label: 'MuxSel_R', color: C.cyan,   desc: '0 = r_in  |  1 = ALU out' },
  { key: 'MuxSel_B', label: 'MuxSel_B', color: C.cyan,   desc: '0 = b_in  |  1 = ALU out' },
  { key: 'MuxSel_I', label: 'MuxSel_I', color: C.cyan,   desc: '0 = reset  |  1 = i+1' },
  { key: 'ALU_Mul',  label: 'ALU_Mul',  color: C.green,  desc: 'Activate multiplier' },
];

// ─── Icon helpers ─────────────────────────────────────────────────────────────
const IconPlay   = () => <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><polygon points="3,1 13,7 3,13"/></svg>;
const IconPause  = () => <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="2" y="1" width="4" height="12"/><rect x="8" y="1" width="4" height="12"/></svg>;
const IconStep   = () => <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><polygon points="2,1 10,7 2,13"/><rect x="11" y="1" width="2" height="12"/></svg>;
const IconRewind = () => <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><polygon points="12,1 4,7 12,13"/><rect x="1" y="1" width="2" height="12"/></svg>;
const IconReset  = () => <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M7 2a5 5 0 1 0 4.33 2.5M7 2V5M7 2L10 5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>;

// ─── Toggle switch ────────────────────────────────────────────────────────────
function SignalToggle({ sigKey, fsmValue, overrideValue, color, onToggle }) {
  const isOverridden = overrideValue !== undefined;
  const effectiveVal = isOverridden ? overrideValue : (fsmValue ?? 0);
  const isOn = effectiveVal === 1;
  return (
    <button
      onClick={() => onToggle(sigKey, isOn ? 0 : 1, isOverridden)}
      title={isOverridden ? `Override: ${effectiveVal}` : `FSM value: ${fsmValue ?? 0}`}
      style={{
        position: 'relative', width: 36, height: 20, borderRadius: 10,
        border: `1px solid ${isOn ? color : C.border2}`,
        background: isOn ? `${color}33` : C.bg3,
        cursor: 'pointer', padding: 0, flexShrink: 0,
        transition: 'background 0.2s, border-color 0.2s',
        outline: isOverridden ? `2px solid ${C.red}` : 'none',
        outlineOffset: 1,
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: isOn ? 17 : 2,
        width: 14, height: 14, borderRadius: '50%',
        background: isOn ? color : C.text3,
        transition: 'left 0.18s, background 0.18s', display: 'block',
      }} />
    </button>
  );
}

// ─── Cycle log ────────────────────────────────────────────────────────────────
function CycleLog({ history, currentCycle }) {
  const rows = history.slice(0, currentCycle + 1).slice(-8).reverse();
  return (
    <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, lineHeight: 1.9, color: C.text2 }}>
      {rows.map((h) => {
        const sigs = Object.keys(h.signals ?? {}).filter(k => h.signals[k]);
        const isCurrent = h.cycle === currentCycle;
        return (
          <div key={h.cycle} style={{
            padding: '3px 8px', borderRadius: 4,
            background: isCurrent ? `${C.accent}18` : 'transparent',
            color: isCurrent ? C.text : C.text2,
            display: 'flex', gap: 10, alignItems: 'baseline',
          }}>
            <span style={{ color: C.text3, minWidth: 28 }}>#{h.cycle}</span>
            <span style={{ color: isCurrent ? C.accent : C.text2, minWidth: 90, fontWeight: isCurrent ? 600 : 400 }}>
              {h.fsmLabel}
            </span>
            <span style={{ color: C.green, fontSize: 10 }}>
              {sigs.length ? sigs.join('  ') : '—'}
            </span>
            {h.halted && <span style={{ color: C.red, fontWeight: 700 }}>HALT</span>}
          </div>
        );
      })}
    </div>
  );
}

// ─── Error toast ──────────────────────────────────────────────────────────────
function ErrorToast({ message, onDismiss }) {
  return (
    <div style={{
      position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
      zIndex: 9999, maxWidth: 680, width: 'calc(100vw - 48px)',
      background: `${C.bg2}f0`, border: `1px solid ${C.red}88`,
      borderRadius: 10, padding: '14px 18px',
      backdropFilter: 'blur(12px)',
      boxShadow: `0 8px 32px ${C.red}22, 0 2px 8px #0008`,
      animation: 'slideUp 0.2s ease',
    }}>
      <style>{`@keyframes slideUp { from { opacity:0; transform: translateX(-50%) translateY(12px); } to { opacity:1; transform: translateX(-50%) translateY(0); } }`}</style>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.red, marginBottom: 6, letterSpacing: '0.05em' }}>
            ✗  COMPILER ERROR
          </div>
          <pre style={{
            fontFamily: "'JetBrains Mono',monospace", fontSize: 11,
            color: C.text2, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            maxHeight: 180, overflowY: 'auto', lineHeight: 1.6,
          }}>{message}</pre>
        </div>
        <button onClick={onDismiss} style={{
          background: 'none', border: 'none', color: C.text3, fontSize: 18,
          cursor: 'pointer', padding: 0, lineHeight: 1, flexShrink: 0,
        }}>×</button>
      </div>
    </div>
  );
}

// ─── Empty state (pre-synthesis) ──────────────────────────────────────────────
function EmptyCanvas() {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '100%', gap: 16,
      color: C.text3, userSelect: 'none',
    }}>
      <div style={{
        width: 64, height: 64, borderRadius: 16,
        background: `linear-gradient(135deg, ${C.accent}22, ${C.cyan}22)`,
        border: `1px solid ${C.border2}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 28,
      }}>Σ</div>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.text2, marginBottom: 6 }}>
          No hardware synthesised yet
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.7 }}>
          Write an algorithm in the editor on the left,<br />
          then click <span style={{ color: C.accent, fontWeight: 600 }}>Synthesize to Hardware</span>.
        </div>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  // ── Editor state ────────────────────────────────────────────────────────────
  const [editorCode, setEditorCode]       = useState(DEFAULT_CODE);
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [compileError, setCompileError]   = useState(null);

  // ── Hardware data (replaces static import) ──────────────────────────────────
  const [hardwareData, setHardwareData] = useState(null);

  // ── Simulation engine — receives hardwareData as a live prop ────────────────
  const sim = useSimulationEngine(hardwareData, { r_in: 1, b_in: 3, e_in: 4 });
  const {
    state, currentCycle, isPlaying, history, overrides, inputs,
    play, pause, stepForward, stepBackward, reset,
    setOverride, clearOverride, setInputs,
  } = sim;

  const [inputForm, setInputForm] = useState({ r: 1, b: 3, e: 4 });
  const applyInputs = () => setInputs(+inputForm.r, +inputForm.b, +inputForm.e);

  // ── React Flow ──────────────────────────────────────────────────────────────
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  useEffect(() => {
    if (!hardwareData || !state) return;
    const rawNodes = buildNodes(state, inputs);
    const rawEdges = buildEdges(state);
    const { nodes: ln, edges: le } = getLayoutedElements(rawNodes, rawEdges, 'TB');
    setNodes(ln);
    setEdges(le);
  }, [state, inputs, hardwareData]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Synthesize handler ──────────────────────────────────────────────────────
  const handleSynthesize = async () => {
    setIsSynthesizing(true);
    setCompileError(null);
    try {
      const res = await fetch('http://localhost:3001/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: editorCode }),
      });

      const data = await res.json();

      if (!res.ok) {
        // data.details carries the raw compiler stderr
        setCompileError(data.details ?? data.error ?? 'Unknown compiler error');
        return;
      }

      setHardwareData(data);
    } catch (err) {
      setCompileError(
        err.message.includes('Failed to fetch')
          ? 'Could not reach the synthesis server.\nMake sure `node server.js` is running on port 3001.'
          : err.message
      );
    } finally {
      setIsSynthesizing(false);
    }
  };

  // ── Fault injection handler ──────────────────────────────────────────────────
  const handleToggle = useCallback((sigKey, newVal, wasOverridden) => {
    if (wasOverridden && overrides[sigKey] === newVal) {
      clearOverride(sigKey);
    } else {
      setOverride(sigKey, newVal);
    }
  }, [overrides, setOverride, clearOverride]);

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      // Don't steal shortcuts from the Monaco editor
      if (e.target.closest?.('.monaco-editor')) return;
      if (e.code === 'Space')      { e.preventDefault(); isPlaying ? pause() : play(); }
      if (e.code === 'ArrowRight') stepForward();
      if (e.code === 'ArrowLeft')  stepBackward();
      if (e.code === 'KeyR')       reset();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isPlaying, play, pause, stepForward, stepBackward, reset]);

  // ── Derived values ──────────────────────────────────────────────────────────
  const fsmSignals = state?.signals ?? {};
  const halted     = state?.halted ?? false;

  // ── Shared style objects ────────────────────────────────────────────────────
  const panel = {
    background: C.bg2, border: `1px solid ${C.border}`,
    borderRadius: 10, padding: 16,
  };
  const sectionTitle = {
    fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
    textTransform: 'uppercase', color: C.text3, marginBottom: 10,
  };
  const btnBase = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    gap: 6, padding: '7px 14px', borderRadius: 6,
    border: `1px solid ${C.border2}`, background: C.bg3,
    color: C.text, fontSize: 12, fontWeight: 500,
    cursor: 'pointer', fontFamily: 'inherit',
    transition: 'background 0.12s, opacity 0.12s',
  };
  const btnActive = { ...btnBase, background: `${C.accent}22`, borderColor: C.accent, color: C.accent };
  const btnDanger = { ...btnBase, background: `${C.red}15`,    borderColor: C.red,    color: C.red    };

  // ───────────────────────────────────────────────────────────────────────────
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      background: C.bg, color: C.text,
      fontFamily: "'IBM Plex Sans','Segoe UI',sans-serif",
      overflow: 'hidden',
    }}>

      {/* ── Top bar ───────────────────────────────────────────────────────── */}
      <header style={{
        display: 'flex', alignItems: 'center', gap: 16,
        padding: '10px 20px', borderBottom: `1px solid ${C.border}`,
        background: C.bg2, flexShrink: 0, zIndex: 20,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 6,
            background: `linear-gradient(135deg, ${C.accent}, ${C.cyan})`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 14, fontWeight: 800, color: '#000',
          }}>Σ</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.01em' }}>
              Auto Datapath Synthesiser
            </div>
            <div style={{ fontSize: 10, color: C.text3, fontFamily: "'JetBrains Mono',monospace" }}>
              {hardwareData
                ? `${hardwareData.meta?.algorithm ?? 'custom'} · cycle-accurate · dagre auto-layout`
                : 'write algorithm → synthesize → simulate'}
            </div>
          </div>
        </div>

        {/* Cycle counter (hidden until data is loaded) */}
        {hardwareData && (
          <div style={{
            marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8,
            background: C.bg3, border: `1px solid ${C.border2}`,
            borderRadius: 20, padding: '5px 14px',
          }}>
            <span style={{ fontSize: 10, color: C.text3, fontFamily: "'JetBrains Mono',monospace" }}>CYCLE</span>
            <span style={{ fontSize: 18, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color: C.accent }}>
              {currentCycle}
            </span>
            <span style={{ fontSize: 10, color: C.text3 }}>/ {history.length - 1}</span>
          </div>
        )}

        {/* FSM state pill */}
        {hardwareData && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: halted ? `${C.red}18` : `${C.green}15`,
            border: `1px solid ${halted ? C.red : C.green}55`,
            borderRadius: 20, padding: '5px 14px',
            marginLeft: hardwareData ? 0 : 'auto',
          }}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%', display: 'inline-block',
              background: halted ? C.red : (isPlaying ? C.green : C.amber),
              boxShadow: `0 0 6px ${halted ? C.red : (isPlaying ? C.green : C.amber)}`,
            }} />
            <span style={{
              fontSize: 12, fontWeight: 600,
              fontFamily: "'JetBrains Mono',monospace",
              color: halted ? C.red : C.text,
            }}>
              {state?.fsmLabel ?? '—'}
            </span>
          </div>
        )}
      </header>

      {/* ── Body ──────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* ── Left sidebar ────────────────────────────────────────────────── */}
        <aside style={{
          width: 320, flexShrink: 0,
          display: 'flex', flexDirection: 'column', gap: 12,
          padding: 14, borderRight: `1px solid ${C.border}`,
          background: C.bg2, overflowY: 'auto', zIndex: 10,
        }}>

          {/* ── Monaco Editor panel ── */}
          <div style={{ ...panel, padding: 0, overflow: 'hidden' }}>
            <div style={{
              padding: '10px 14px 8px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              borderBottom: `1px solid ${C.border}`,
            }}>
              <div style={sectionTitle}>Algorithm Source</div>
              <div style={{
                fontSize: 10, color: C.text3,
                fontFamily: "'JetBrains Mono',monospace",
                background: C.bg3, borderRadius: 4, padding: '2px 7px',
                border: `1px solid ${C.border2}`,
              }}>C-like</div>
            </div>

            <Editor
              height="300px"
              language="c"
              theme="vs-dark"
              value={editorCode}
              onChange={(val) => setEditorCode(val ?? '')}
              options={{
                fontSize: 12,
                lineHeight: 1.7,
                fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                renderLineHighlight: 'gutter',
                padding: { top: 12, bottom: 12 },
                wordWrap: 'on',
                tabSize: 2,
                overviewRulerLanes: 0,
                hideCursorInOverviewRuler: true,
                scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
              }}
            />

            {/* Synthesize button */}
            <div style={{ padding: '10px 14px', borderTop: `1px solid ${C.border}` }}>
              <button
                onClick={handleSynthesize}
                disabled={isSynthesizing}
                style={{
                  width: '100%', padding: '10px 0',
                  borderRadius: 7, border: 'none', cursor: isSynthesizing ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit', fontSize: 13, fontWeight: 700,
                  letterSpacing: '0.04em',
                  background: isSynthesizing
                    ? C.bg3
                    : `linear-gradient(135deg, ${C.accent}, ${C.cyan})`,
                  color: isSynthesizing ? C.text3 : '#000',
                  transition: 'all 0.2s',
                  position: 'relative', overflow: 'hidden',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                }}
              >
                {isSynthesizing ? (
                  <>
                    <span style={{
                      display: 'inline-block', width: 12, height: 12,
                      border: `2px solid ${C.text3}`,
                      borderTopColor: 'transparent', borderRadius: '50%',
                      animation: 'spin 0.7s linear infinite',
                    }} />
                    Compiling…
                    <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                  </>
                ) : (
                  <>⚡ Synthesize to Hardware</>
                )}
              </button>
            </div>
          </div>

          {/* ── Playback controls — only shown after synthesis ── */}
          {hardwareData && (
            <>
              <div style={panel}>
                <div style={sectionTitle}>Playback</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    style={isPlaying ? btnActive : btnBase}
                    onClick={() => isPlaying ? pause() : play()}
                    disabled={halted}
                    title="Space"
                  >
                    {isPlaying ? <IconPause /> : <IconPlay />}
                    {isPlaying ? 'Pause' : 'Play'}
                  </button>
                  <button style={btnBase} onClick={stepBackward} disabled={currentCycle === 0} title="←">
                    <IconRewind /> Back
                  </button>
                  <button style={btnBase} onClick={stepForward} disabled={halted} title="→">
                    <IconStep /> Step
                  </button>
                  <button style={btnDanger} onClick={reset} title="R">
                    <IconReset /> Reset
                  </button>
                </div>
                <div style={{ marginTop: 10, height: 4, background: C.bg3, borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    width: `${Math.min(100, (currentCycle / Math.max(1, history.length - 1)) * 100)}%`,
                    background: halted
                      ? `linear-gradient(90deg, ${C.red}, ${C.amber})`
                      : `linear-gradient(90deg, ${C.accent}, ${C.cyan})`,
                    borderRadius: 2, transition: 'width 0.3s',
                  }} />
                </div>
                <div style={{ marginTop: 6, fontSize: 10, color: C.text3, fontFamily: "'JetBrains Mono',monospace" }}>
                  {halted ? '✓ Simulation complete' : '⌨  Space · ← · → · R'}
                </div>
              </div>

              {/* Register snapshot */}
              <div style={panel}>
                <div style={sectionTitle}>Register File</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {[
                    { key: 'Reg_r', sig: 'Ld_R', label: 'r', val: state?.Reg_r },
                    { key: 'Reg_b', sig: 'Ld_B', label: 'b', val: state?.Reg_b },
                    { key: 'Reg_e', sig: 'Ld_E', label: 'e', val: state?.Reg_e },
                    { key: 'Reg_i', sig: 'Ld_I', label: 'i', val: state?.Reg_i },
                  ].map(({ key, sig, label, val }) => {
                    const active = !!(fsmSignals[sig] ?? overrides[sig]);
                    return (
                      <div key={key} style={{
                        background: active ? `${C.amber}15` : C.bg3,
                        border: `1px solid ${active ? C.amber : C.border}`,
                        borderRadius: 8, padding: '8px 10px', textAlign: 'center',
                        transition: 'all 0.25s',
                      }}>
                        <div style={{ fontSize: 10, color: active ? C.amber : C.text3, marginBottom: 3, fontFamily: "'JetBrains Mono',monospace" }}>
                          Reg<sub>{label}</sub>
                        </div>
                        <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color: active ? '#fff' : C.text }}>
                          {val ?? 0}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Input configurator */}
              <div style={panel}>
                <div style={sectionTitle}>Inputs  (r_in · b_in · e_in)</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {[
                    { field: 'r', label: 'r_in', hint: 'initial r' },
                    { field: 'b', label: 'b_in', hint: 'base'      },
                    { field: 'e', label: 'e_in', hint: 'exponent'  },
                  ].map(({ field, label, hint }) => (
                    <label key={field} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 11, color: C.text3, fontFamily: "'JetBrains Mono',monospace", minWidth: 44 }}>
                        {label}
                      </span>
                      <input
                        type="number"
                        value={inputForm[field]}
                        onChange={(e) => setInputForm((f) => ({ ...f, [field]: e.target.value }))}
                        style={{
                          flex: 1, background: C.bg3,
                          border: `1px solid ${C.border2}`,
                          borderRadius: 6, color: C.text,
                          padding: '4px 8px', fontSize: 13,
                          fontFamily: "'JetBrains Mono',monospace",
                          outline: 'none',
                        }}
                      />
                      <span style={{ fontSize: 10, color: C.text3 }}>{hint}</span>
                    </label>
                  ))}
                  <button
                    style={{ ...btnBase, marginTop: 4, justifyContent: 'center', borderColor: C.accent, color: C.accent, background: `${C.accent}15` }}
                    onClick={applyInputs}
                  >
                    Apply & Reset
                  </button>
                </div>
              </div>

              {/* Cycle log */}
              <div style={{ ...panel, flexShrink: 0 }}>
                <div style={sectionTitle}>Cycle Log</div>
                <CycleLog history={history} currentCycle={currentCycle} />
              </div>
            </>
          )}
        </aside>

        {/* ── React Flow canvas / empty state ─────────────────────────────── */}
        <main style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          {!hardwareData ? (
            <EmptyCanvas />
          ) : (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              nodeTypes={hwNodeTypes}
              fitView
              fitViewOptions={{ padding: 0.3 }}
              minZoom={0.3}
              maxZoom={2.5}
              attributionPosition="bottom-right"
              style={{ background: C.bg }}
            >
              <Background variant="dots" gap={24} size={1.2} color={C.border} />
              <Controls style={{
                background: C.bg2, border: `1px solid ${C.border}`,
                borderRadius: 8, overflow: 'hidden',
              }} />
              <MiniMap
                nodeColor={(n) => {
                  if (n.data?.isActive) {
                    if (n.type === 'alu')      return C.green;
                    if (n.type === 'mux')      return C.cyan;
                    if (n.type === 'register') return C.amber;
                  }
                  return C.border2;
                }}
                maskColor={`${C.bg}cc`}
                style={{
                  background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8,
                }}
              />
              {halted && (
                <div style={{
                  position: 'absolute', bottom: 80, left: '50%',
                  transform: 'translateX(-50%)',
                  background: `${C.red}22`, border: `1px solid ${C.red}88`,
                  borderRadius: 20, padding: '8px 20px',
                  color: C.red, fontSize: 13, fontWeight: 600,
                  letterSpacing: '0.06em', zIndex: 10,
                  backdropFilter: 'blur(6px)',
                  fontFamily: "'JetBrains Mono',monospace",
                }}>
                  ■  HALT — FSM reached Done state
                </div>
              )}
            </ReactFlow>
          )}
        </main>

        {/* ── Right sidebar — FSM & fault injection ───────────────────────── */}
        {hardwareData && (
          <aside style={{
            width: 280, flexShrink: 0,
            display: 'flex', flexDirection: 'column', gap: 12,
            padding: 14, borderLeft: `1px solid ${C.border}`,
            background: C.bg2, overflowY: 'auto', zIndex: 10,
          }}>

            {/* FSM inspector */}
            <div style={panel}>
              <div style={sectionTitle}>FSM State</div>
              <div style={{
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: 11, color: C.text2, marginBottom: 10, lineHeight: 1.8,
              }}>
                <div><span style={{ color: C.text3 }}>id     </span><span style={{ color: C.accent }}>{state?.fsmStateId}</span></div>
                <div><span style={{ color: C.text3 }}>label  </span><span style={{ color: C.text  }}>{state?.fsmLabel}</span></div>
                <div><span style={{ color: C.text3 }}>cycle  </span><span style={{ color: C.text  }}>{state?.cycle}</span></div>
                <div><span style={{ color: C.text3 }}>halted </span><span style={{ color: halted ? C.red : C.green }}>{halted ? 'yes' : 'no'}</span></div>
              </div>

              {Object.keys(overrides).length > 0 && (
                <div style={{
                  background: `${C.red}18`, border: `1px solid ${C.red}55`,
                  borderRadius: 6, padding: '6px 10px',
                  fontSize: 11, color: C.red, marginBottom: 8,
                  fontFamily: "'JetBrains Mono',monospace",
                }}>
                  ⚡ {Object.keys(overrides).length} override{Object.keys(overrides).length > 1 ? 's' : ''} active
                </div>
              )}
            </div>

            {/* Signal fault-injection panel */}
            <div style={panel}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <div style={sectionTitle}>Control Signals</div>
                {Object.keys(overrides).length > 0 && (
                  <button
                    style={{ ...btnDanger, padding: '3px 8px', fontSize: 10 }}
                    onClick={() => ALL_SIGNALS.forEach(s => clearOverride(s.key))}
                  >
                    Clear all
                  </button>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {ALL_SIGNALS.map(({ key, label, color, desc }) => {
                  const fsmVal       = fsmSignals[key] ?? 0;
                  const overrideVal  = overrides[key];
                  const effectiveVal = overrideVal !== undefined ? overrideVal : fsmVal;
                  const isOn         = effectiveVal === 1;
                  const isOverridden = overrideVal !== undefined;
                  const isFsmActive  = fsmVal === 1;

                  return (
                    <div key={key} style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '6px 8px', borderRadius: 6,
                      background: isOn ? `${color}18` : (isOverridden ? `${C.red}12` : 'transparent'),
                      border: `1px solid ${isOverridden ? C.red+'66' : (isOn ? color+'55' : 'transparent')}`,
                      transition: 'all 0.18s',
                    }}>
                      <SignalToggle
                        sigKey={key} fsmValue={fsmVal} overrideValue={overrideVal}
                        color={color} onToggle={handleToggle}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{
                            fontFamily: "'JetBrains Mono',monospace",
                            fontSize: 11, fontWeight: 600,
                            color: isOn ? color : C.text2, transition: 'color 0.2s',
                          }}>{label}</span>
                          <span style={{
                            fontFamily: "'JetBrains Mono',monospace",
                            fontSize: 11, fontWeight: 700,
                            color: isOn ? color : C.text3,
                          }}>{effectiveVal}</span>
                          {isOverridden && (
                            <span style={{
                              fontSize: 9, background: `${C.red}33`, color: C.red,
                              borderRadius: 4, padding: '1px 4px', fontWeight: 700, letterSpacing: '0.04em',
                            }}>OVR</span>
                          )}
                          {!isOverridden && isFsmActive && (
                            <span style={{
                              fontSize: 9, background: `${color}33`, color,
                              borderRadius: 4, padding: '1px 4px', fontWeight: 700,
                            }}>FSM</span>
                          )}
                        </div>
                        <div style={{ fontSize: 9.5, color: C.text3, marginTop: 1 }}>{desc}</div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={{
                marginTop: 10, fontSize: 10, color: C.text3, lineHeight: 1.6,
                paddingTop: 8, borderTop: `1px solid ${C.border}`,
              }}>
                Toggle any signal to override the FSM for the next clock edge.
                Overrides are consumed after one cycle (red outline = active override).
              </div>
            </div>

            {/* Wire legend */}
            <div style={panel}>
              <div style={sectionTitle}>Wire Legend</div>
              {[
                { color: C.green,   label: 'Data bus  (Ld active)'  },
                { color: C.cyan,    label: 'ALU operand path'        },
                { color: C.purple,  label: 'ALU → Mux feedback'      },
                { color: C.amber,   label: 'Control / select'        },
                { color: C.border2, label: 'Idle wire'               },
              ].map(({ color, label }) => (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                  <div style={{
                    height: 2, width: 24, borderRadius: 1, background: color,
                    boxShadow: color !== C.border2 ? `0 0 4px ${color}` : 'none',
                  }} />
                  <span style={{ fontSize: 10.5, color: C.text2 }}>{label}</span>
                </div>
              ))}
            </div>

            {/* Dagre info badge */}
            <div style={{ ...panel, fontSize: 10, color: C.text3, lineHeight: 1.7 }}>
              <div style={sectionTitle}>Layout Engine</div>
              <span style={{ color: C.accent, fontFamily: "'JetBrains Mono',monospace" }}>dagre</span>
              {' '}· TB direction · {NODE_W}×{NODE_H} node bbox
              <br />
              Re-synthesize any time to swap the hardware graph.
            </div>
          </aside>
        )}
      </div>

      {/* ── Error toast ───────────────────────────────────────────────────── */}
      {compileError && (
        <ErrorToast message={compileError} onDismiss={() => setCompileError(null)} />
      )}
    </div>
  );
}
