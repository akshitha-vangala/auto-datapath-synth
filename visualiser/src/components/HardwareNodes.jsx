/**
 * HardwareNodes.jsx
 *
 * Custom React Flow node components for the Square-and-Multiply datapath.
 *
 * Exported node types (pass to <ReactFlow nodeTypes={...}>):
 *   register   — Rectangle with stored value display
 *   mux        — Trapezoid with active-input highlight
 *   alu        — Classic V-shaped ALU / multiplier symbol
 *
 * Each node receives `data` from the React Flow node definition.
 * Expected shape per type:
 *
 *   Register node data:
 *     { label, regKey, value, isActive, activeSignal }
 *       label       — e.g. "Reg_r"
 *       regKey      — e.g. "r" (shown as subscript)
 *       value       — current integer stored in the register
 *       isActive    — boolean: Ld_X == 1 this cycle
 *       activeSignal — string: which signal activated it (e.g. "Ld_R")
 *
 *   Mux node data:
 *     { label, sel, isActive, inputs }
 *       label       — e.g. "Mux_r"
 *       sel         — 0 | 1 (current MuxSel value)
 *       isActive    — boolean: mux is in the active signal set this cycle
 *       inputs      — array of strings labelling the two input lines
 *                     e.g. ["r_in (ext)", "r×r (ALU)"]
 *
 *   ALU node data:
 *     { label, isActive, operation }
 *       label       — e.g. "×"
 *       isActive    — boolean: ALU_Mul == 1 this cycle
 *       operation   — string shown inside body, e.g. "r×r / b×b"
 *
 * Usage example (React Flow nodes array):
 *
 *   const nodes = [
 *     {
 *       id: 'Reg_r',
 *       type: 'register',
 *       position: { x: 400, y: 200 },
 *       data: {
 *         label: 'Reg_r', regKey: 'r',
 *         value: simState.Reg_r,
 *         isActive: !!simState.signals['Ld_R'],
 *         activeSignal: 'Ld_R',
 *       },
 *     },
 *     ...
 *   ];
 *
 *   const nodeTypes = { register: RegisterNode, mux: MuxNode, alu: ALUNode };
 *
 *   <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} ... />
 */

import React, { memo } from 'react';
import { Handle, Position } from 'reactflow';

// ─── Design tokens ────────────────────────────────────────────────────────────

const COLORS = {
  // Background / surface
  canvas:      '#0d1117',
  surface:     '#161b22',
  surfaceAlt:  '#1c2128',

  // Inactive component styling
  border:      '#30363d',
  label:       '#8b949e',
  value:       '#e6edf3',
  wire:        '#484f58',

  // Active glow palette — amber for registers, cyan for mux, green for ALU
  activeReg:   '#f0883e',   // warm amber
  activeMux:   '#39c5cf',   // cyan
  activeAlu:   '#3fb950',   // vivid green

  // Selected-input highlight inside mux
  selInput:    '#ffa657',

  // Handle (connection point) dots
  handle:      '#58a6ff',
};

const FONT = {
  mono:  "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
  label: "'IBM Plex Sans', 'Segoe UI', sans-serif",
};

// Shared glow keyframes injected once into <head>
const GLOW_STYLE_ID = 'hw-node-keyframes';
function injectKeyframesOnce() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(GLOW_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = GLOW_STYLE_ID;
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&family=JetBrains+Mono:wght@400;700&display=swap');

    @keyframes hw-pulse-reg {
      0%,100% { box-shadow: 0 0 6px 2px ${COLORS.activeReg}55, 0 0 18px 4px ${COLORS.activeReg}33; }
      50%      { box-shadow: 0 0 12px 4px ${COLORS.activeReg}99, 0 0 30px 8px ${COLORS.activeReg}55; }
    }
    @keyframes hw-pulse-mux {
      0%,100% { filter: drop-shadow(0 0 4px ${COLORS.activeMux}66); }
      50%      { filter: drop-shadow(0 0 10px ${COLORS.activeMux}cc); }
    }
    @keyframes hw-pulse-alu {
      0%,100% { filter: drop-shadow(0 0 4px ${COLORS.activeAlu}66); }
      50%      { filter: drop-shadow(0 0 12px ${COLORS.activeAlu}cc); }
    }
    @keyframes hw-badge-pop {
      0%   { transform: scale(0.7); opacity: 0; }
      60%  { transform: scale(1.15); }
      100% { transform: scale(1); opacity: 1; }
    }
  `;
  document.head.appendChild(style);
}

// ─── Shared: invisible drag handle overlay ────────────────────────────────────
// React Flow requires the outer div to be the drag target.
const NodeShell = ({ width, height, children, style = {} }) => (
  <div style={{ width, height, position: 'relative', ...style }}>
    {children}
  </div>
);

// ─── ActiveBadge ─────────────────────────────────────────────────────────────
// Small pill shown above active components
const ActiveBadge = ({ text, color }) => (
  <div style={{
    position:      'absolute',
    top:           -22,
    left:          '50%',
    transform:     'translateX(-50%)',
    background:    color,
    color:         '#000',
    fontSize:      10,
    fontFamily:    FONT.mono,
    fontWeight:    700,
    padding:       '2px 7px',
    borderRadius:  99,
    whiteSpace:    'nowrap',
    pointerEvents: 'none',
    zIndex:        10,
    animation:     'hw-badge-pop 0.25s ease-out',
    letterSpacing: '0.04em',
  }}>
    {text} = 1
  </div>
);

// ─── RegisterNode ─────────────────────────────────────────────────────────────
/**
 * Classic rectangle register with label subscript, stored value, and
 * a pulsing amber glow when the load-enable signal is asserted.
 *
 * Handles:
 *   Top    — data input (from Mux output)
 *   Bottom — data output (to ALU or next stage)
 *   Left   — load-enable control wire
 */
export const RegisterNode = memo(({ data }) => {
  injectKeyframesOnce();

  const {
    label      = 'Reg',
    regKey     = '?',
    value      = 0,
    isActive   = false,
    activeSignal = '',
  } = data;

  const W = 110, H = 70;

  const containerStyle = {
    width:        W,
    height:       H,
    borderRadius: 6,
    border:       `2px solid ${isActive ? COLORS.activeReg : COLORS.border}`,
    background:   isActive
      ? `linear-gradient(145deg, #1e1208 0%, ${COLORS.surface} 100%)`
      : COLORS.surface,
    animation:    isActive ? 'hw-pulse-reg 1.2s ease-in-out infinite' : 'none',
    display:      'flex',
    flexDirection:'column',
    alignItems:   'center',
    justifyContent:'center',
    gap:          4,
    position:     'relative',
    cursor:       'default',
    transition:   'border-color 0.3s, background 0.3s',
    userSelect:   'none',
  };

  const labelStyle = {
    fontFamily: FONT.mono,
    fontSize:   11,
    color:      isActive ? COLORS.activeReg : COLORS.label,
    fontWeight: 600,
    transition: 'color 0.3s',
    letterSpacing: '0.05em',
  };

  const valueStyle = {
    fontFamily: FONT.mono,
    fontSize:   22,
    fontWeight: 700,
    color:      isActive ? '#fff' : COLORS.value,
    transition: 'color 0.3s',
    lineHeight:  1,
  };

  // Subscript divider line (mimics register symbol)
  const dividerStyle = {
    width:       '80%',
    height:      1,
    background:  isActive ? `${COLORS.activeReg}66` : `${COLORS.border}88`,
    margin:      '2px 0',
    transition:  'background 0.3s',
  };

  return (
    <NodeShell width={W} height={H}>
      {/* Control-enable wire handle — left side */}
      <Handle
        type="target"
        position={Position.Left}
        id="ctrl"
        style={{
          top: '50%', left: -8, width: 12, height: 12,
          background: isActive ? COLORS.activeReg : COLORS.wire,
          border: `2px solid ${COLORS.canvas}`,
          borderRadius: '50%',
          transition: 'background 0.3s',
        }}
      />
      {/* Data input — top */}
      <Handle
        type="target"
        position={Position.Top}
        id="din"
        style={{
          top: -7, left: '50%',
          width: 12, height: 12,
          background: isActive ? COLORS.activeReg : COLORS.handle,
          border: `2px solid ${COLORS.canvas}`,
          borderRadius: '50%',
          transition: 'background 0.3s',
        }}
      />

      {isActive && <ActiveBadge text={activeSignal} color={COLORS.activeReg} />}

      <div style={containerStyle}>
        <span style={labelStyle}>
          {/* e.g. "Reg" with subscript "r" */}
          Reg<sub style={{ fontSize: 9 }}>{regKey}</sub>
        </span>
        <div style={dividerStyle} />
        <span style={valueStyle}>{value}</span>
      </div>

      {/* Data output — bottom */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="dout"
        style={{
          bottom: -7, left: '50%',
          width: 12, height: 12,
          background: COLORS.handle,
          border: `2px solid ${COLORS.canvas}`,
          borderRadius: '50%',
        }}
      />
    </NodeShell>
  );
});
RegisterNode.displayName = 'RegisterNode';

// ─── MuxNode ──────────────────────────────────────────────────────────────────
/**
 * Trapezoid mux rendered via inline SVG.
 * The two input pins on the left side are colour-coded:
 *   — The selected input (matching `sel`) glows amber
 *   — The unselected input stays dim
 *
 * Handles:
 *   Left-top (id="in0")  — input 0
 *   Left-bottom (id="in1") — input 1
 *   Right (id="out")     — output
 *   Bottom (id="sel")    — MuxSel control wire
 */
export const MuxNode = memo(({ data }) => {
  injectKeyframesOnce();

  const {
    label    = 'Mux',
    sel      = 0,
    isActive = false,
    inputs   = ['in₀ (ext)', 'in₁ (ALU)'],
  } = data;

  const W = 90, H = 80;

  // SVG trapezoid points — wider on left (inputs), narrower on right (output)
  // left edge: full height (0→H), right edge: inset top & bottom by 20px
  const TL = { x: 0,  y: 0  };
  const BL = { x: 0,  y: H  };
  const BR = { x: W,  y: H - 20 };
  const TR = { x: W,  y: 20 };

  const pts = `${TL.x},${TL.y} ${BL.x},${BL.y} ${BR.x},${BR.y} ${TR.x},${TR.y}`;

  const strokeColor = isActive ? COLORS.activeMux : COLORS.border;
  const fillColor   = isActive ? '#081419' : COLORS.surface;

  // The two input midpoints on the left edge (y = H*0.25 and H*0.75)
  const in0Y = H * 0.25;
  const in1Y = H * 0.75;
  const outY = H * 0.5;

  const selColor0 = (!isActive && sel !== 0) ? COLORS.wire
                  : sel === 0 ? COLORS.selInput : COLORS.wire;
  const selColor1 = (!isActive && sel !== 1) ? COLORS.wire
                  : sel === 1 ? COLORS.selInput : COLORS.wire;

  const animStyle = isActive
    ? { animation: 'hw-pulse-mux 1.2s ease-in-out infinite' }
    : {};

  return (
    <NodeShell width={W} height={H}>
      {/* Input 0 — left-top */}
      <Handle
        type="target"
        position={Position.Left}
        id="in0"
        style={{
          top: in0Y, left: -7,
          width: 12, height: 12,
          background: sel === 0 && isActive ? COLORS.selInput : COLORS.handle,
          border: `2px solid ${COLORS.canvas}`,
          borderRadius: '50%',
          transition: 'background 0.3s',
        }}
      />
      {/* Input 1 — left-bottom */}
      <Handle
        type="target"
        position={Position.Left}
        id="in1"
        style={{
          top: in1Y, left: -7,
          width: 12, height: 12,
          background: sel === 1 && isActive ? COLORS.selInput : COLORS.handle,
          border: `2px solid ${COLORS.canvas}`,
          borderRadius: '50%',
          transition: 'background 0.3s',
        }}
      />
      {/* Output — right */}
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        style={{
          top: outY, right: -7,
          width: 12, height: 12,
          background: COLORS.handle,
          border: `2px solid ${COLORS.canvas}`,
          borderRadius: '50%',
        }}
      />
      {/* Sel control — bottom */}
      <Handle
        type="target"
        position={Position.Bottom}
        id="sel"
        style={{
          bottom: -7, left: '40%',
          width: 10, height: 10,
          background: isActive ? COLORS.activeMux : COLORS.wire,
          border: `2px solid ${COLORS.canvas}`,
          borderRadius: '50%',
          transition: 'background 0.3s',
        }}
      />

      {isActive && <ActiveBadge text={`MuxSel=${sel}`} color={COLORS.activeMux} />}

      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        style={{ position: 'absolute', top: 0, left: 0, ...animStyle }}
        overflow="visible"
      >
        {/* Body */}
        <polygon
          points={pts}
          fill={fillColor}
          stroke={strokeColor}
          strokeWidth={isActive ? 2 : 1.5}
          style={{ transition: 'fill 0.3s, stroke 0.3s' }}
        />

        {/* Input selection highlight bars */}
        <line
          x1={2} y1={in0Y} x2={28} y2={in0Y}
          stroke={selColor0}
          strokeWidth={isActive && sel === 0 ? 2.5 : 1.5}
          style={{ transition: 'stroke 0.3s, stroke-width 0.3s' }}
        />
        <line
          x1={2} y1={in1Y} x2={28} y2={in1Y}
          stroke={selColor1}
          strokeWidth={isActive && sel === 1 ? 2.5 : 1.5}
          style={{ transition: 'stroke 0.3s, stroke-width 0.3s' }}
        />

        {/* Input labels */}
        <text x={5} y={in0Y - 5} fill={selColor0} fontSize={8} fontFamily={FONT.mono} style={{ transition: 'fill 0.3s' }}>
          {inputs[0] ?? 'in0'}
        </text>
        <text x={5} y={in1Y - 5} fill={selColor1} fontSize={8} fontFamily={FONT.mono} style={{ transition: 'fill 0.3s' }}>
          {inputs[1] ?? 'in1'}
        </text>

        {/* Component label */}
        <text
          x={W * 0.62} y={outY + 4}
          fill={isActive ? COLORS.activeMux : COLORS.label}
          fontSize={11}
          fontFamily={FONT.mono}
          fontWeight="700"
          textAnchor="middle"
          style={{ transition: 'fill 0.3s' }}
        >
          {label}
        </text>

        {/* Sel value indicator at bottom-center */}
        {isActive && (
          <text
            x={W * 0.38} y={H - 5}
            fill={COLORS.activeMux}
            fontSize={8}
            fontFamily={FONT.mono}
            textAnchor="middle"
          >
            sel={sel}
          </text>
        )}
      </svg>
    </NodeShell>
  );
});
MuxNode.displayName = 'MuxNode';

// ─── ALUNode ──────────────────────────────────────────────────────────────────
/**
 * Classic V-shaped (arrow/chevron) ALU symbol rendered in SVG.
 *
 * The standard IEEE ALU shape:
 *   - Two flat edges at top-left and top-right (operand inputs)
 *   - A pointed bottom (output)
 *   - Notched sides (the concave indents halfway down each side)
 *
 * Handles:
 *   Left (id="a")   — operand A input
 *   Right (id="b")  — operand B input (in this datapath both are from regs)
 *   Bottom (id="y") — result output
 *
 * When ALU_Mul == 1, the shape pulses vivid green.
 */
export const ALUNode = memo(({ data }) => {
  injectKeyframesOnce();

  const {
    label     = '×',
    isActive  = false,
    operation = 'r×r  b×b',
  } = data;

  const W = 120, H = 100;

  /*
   * Classic IEEE 91 ALU outline (normalised to W×H):
   *
   *   A──────────────B   ← top edge
   *   |              |
   *   F    notch→ G  C   ← mid-notch points
   *    \          /
   *         D         ← bottom tip (output)
   *
   * Coordinates (clockwise from top-left):
   */
  const pts = [
    [0,       0      ],   // A – top-left
    [W,       0      ],   // B – top-right
    [W,       H*0.45 ],   // C – right before notch
    [W*0.65,  H*0.55 ],   // notch-in right
    [W*0.65,  H*0.65 ],   // notch-bottom right
    [W*0.5,   H      ],   // D – bottom tip
    [W*0.35,  H*0.65 ],   // notch-bottom left
    [W*0.35,  H*0.55 ],   // notch-in left
    [0,       H*0.45 ],   // F – left before notch
  ].map(([x, y]) => `${x},${y}`).join(' ');

  // Input handle vertical positions (on the flat top part of each side)
  const inputY = H * 0.22;

  const strokeColor = isActive ? COLORS.activeAlu : COLORS.border;
  const fillGrad    = isActive ? '#071209' : COLORS.surface;

  const animStyle   = isActive
    ? { animation: 'hw-pulse-alu 1.2s ease-in-out infinite' }
    : {};

  return (
    <NodeShell width={W} height={H}>
      {/* Operand A — left */}
      <Handle
        type="target"
        position={Position.Left}
        id="a"
        style={{
          top: inputY, left: -7,
          width: 12, height: 12,
          background: isActive ? COLORS.activeAlu : COLORS.handle,
          border: `2px solid ${COLORS.canvas}`,
          borderRadius: '50%',
          transition: 'background 0.3s',
        }}
      />
      {/* Operand B — right */}
      <Handle
        type="target"
        position={Position.Right}
        id="b"
        style={{
          top: inputY, right: -7,
          width: 12, height: 12,
          background: isActive ? COLORS.activeAlu : COLORS.handle,
          border: `2px solid ${COLORS.canvas}`,
          borderRadius: '50%',
          transition: 'background 0.3s',
        }}
      />
      {/* Result — bottom tip */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="y"
        style={{
          bottom: -7, left: '50%',
          width: 12, height: 12,
          background: isActive ? COLORS.activeAlu : COLORS.handle,
          border: `2px solid ${COLORS.canvas}`,
          borderRadius: '50%',
          transition: 'background 0.3s',
        }}
      />

      {isActive && <ActiveBadge text="ALU_Mul" color={COLORS.activeAlu} />}

      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        style={{ position: 'absolute', top: 0, left: 0, overflow: 'visible', ...animStyle }}
      >
        <defs>
          <linearGradient id="alu-grad-active" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0d2b14" />
            <stop offset="100%" stopColor="#071209" />
          </linearGradient>
          <linearGradient id="alu-grad-idle" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COLORS.surfaceAlt} />
            <stop offset="100%" stopColor={COLORS.surface} />
          </linearGradient>
        </defs>

        {/* Body */}
        <polygon
          points={pts}
          fill={`url(#${isActive ? 'alu-grad-active' : 'alu-grad-idle'})`}
          stroke={strokeColor}
          strokeWidth={isActive ? 2.5 : 1.5}
          strokeLinejoin="round"
          style={{ transition: 'stroke 0.3s, stroke-width 0.3s' }}
        />

        {/* Operator symbol */}
        <text
          x={W / 2}
          y={H * 0.32}
          textAnchor="middle"
          dominantBaseline="middle"
          fill={isActive ? COLORS.activeAlu : COLORS.label}
          fontSize={22}
          fontFamily={FONT.mono}
          fontWeight="700"
          style={{ transition: 'fill 0.3s' }}
        >
          {label}
        </text>

        {/* Operation description */}
        <text
          x={W / 2}
          y={H * 0.56}
          textAnchor="middle"
          fill={isActive ? '#7ee787' : COLORS.wire}
          fontSize={9}
          fontFamily={FONT.mono}
          style={{ transition: 'fill 0.3s' }}
        >
          {operation}
        </text>

        {/* Input port labels */}
        <text x={8}   y={inputY - 5} fill={COLORS.label} fontSize={8} fontFamily={FONT.mono}>A</text>
        <text x={W-14} y={inputY - 5} fill={COLORS.label} fontSize={8} fontFamily={FONT.mono}>B</text>
      </svg>
    </NodeShell>
  );
});
ALUNode.displayName = 'ALUNode';

// ─── nodeTypes export ─────────────────────────────────────────────────────────
/**
 * Pass this object directly to <ReactFlow nodeTypes={...} />
 *
 * import { hwNodeTypes } from './HardwareNodes';
 * <ReactFlow nodeTypes={hwNodeTypes} ... />
 */
export const hwNodeTypes = {
  register: RegisterNode,
  mux:      MuxNode,
  alu:      ALUNode,
};

// ─── buildDatapathGraph ───────────────────────────────────────────────────────
/**
 * Convenience builder: given the current simulation state (from
 * useSimulationEngine) returns `{ nodes, edges }` ready for React Flow.
 *
 * Layout is fixed for the Square-and-Multiply datapath:
 *
 *              [ALU]
 *             /     \
 *         [Mux_r] [Mux_b]        Mux feedback from ALU
 *            |        |
 *         [Reg_r]  [Reg_b]       Main registers
 *
 *         [Reg_e]  [Reg_i]       (Shift-register / counter — simple rectangles)
 *
 * External inputs (r_in, b_in, e_in) are represented as simple source handles
 * on the mux nodes.
 *
 * @param {Object} simState  — output of useSimulationEngine().state
 * @param {Object} inputs    — { r_in, b_in, e_in }
 * @returns {{ nodes: Array, edges: Array }}
 */
export function buildDatapathGraph(simState, inputs = {}) {
  const sigs = simState?.signals ?? {};

  // ── Nodes ─────────────────────────────────────────────────────────────────
  const nodes = [
    // ALU / Multiplier — top centre
    {
      id:   'ALU',
      type: 'alu',
      position: { x: 290, y: 30 },
      draggable: true,
      data: {
        label:     '×',
        isActive:  !!sigs['ALU_Mul'],
        operation: 'r×r  /  b×b',
      },
    },

    // Mux_r — below ALU left
    {
      id:   'Mux_r',
      type: 'mux',
      position: { x: 160, y: 200 },
      draggable: true,
      data: {
        label:    'MUX',
        sel:      sigs['MuxSel_R'] ?? 0,
        isActive: !!sigs['Ld_R'],
        inputs:   [
          `r_in=${inputs.r_in ?? '?'}`,
          'r×r (ALU)',
        ],
      },
    },

    // Mux_b — below ALU right
    {
      id:   'Mux_b',
      type: 'mux',
      position: { x: 450, y: 200 },
      draggable: true,
      data: {
        label:    'MUX',
        sel:      sigs['MuxSel_B'] ?? 0,
        isActive: !!sigs['Ld_B'],
        inputs:   [
          `b_in=${inputs.b_in ?? '?'}`,
          'b×b (ALU)',
        ],
      },
    },

    // Reg_r
    {
      id:   'Reg_r',
      type: 'register',
      position: { x: 170, y: 360 },
      draggable: true,
      data: {
        label:       'Reg_r',
        regKey:      'r',
        value:       simState?.Reg_r ?? 0,
        isActive:    !!sigs['Ld_R'],
        activeSignal:'Ld_R',
      },
    },

    // Reg_b
    {
      id:   'Reg_b',
      type: 'register',
      position: { x: 460, y: 360 },
      draggable: true,
      data: {
        label:       'Reg_b',
        regKey:      'b',
        value:       simState?.Reg_b ?? 0,
        isActive:    !!sigs['Ld_B'],
        activeSignal:'Ld_B',
      },
    },

    // Reg_e — shift register for exponent
    {
      id:   'Reg_e',
      type: 'register',
      position: { x: 50, y: 500 },
      draggable: true,
      data: {
        label:       'Reg_e',
        regKey:      'e',
        value:       simState?.Reg_e ?? 0,
        isActive:    !!(sigs['Ld_E'] || sigs['Shift_E']),
        activeSignal: sigs['Ld_E'] ? 'Ld_E' : 'Shift_E',
      },
    },

    // Reg_i — loop counter
    {
      id:   'Reg_i',
      type: 'register',
      position: { x: 620, y: 500 },
      draggable: true,
      data: {
        label:       'Reg_i',
        regKey:      'i',
        value:       simState?.Reg_i ?? 0,
        isActive:    !!sigs['Ld_I'],
        activeSignal:'Ld_I',
      },
    },
  ];

  // ── Edges ─────────────────────────────────────────────────────────────────
  const activeEdgeStyle  = { stroke: COLORS.activeAlu,  strokeWidth: 2.5, animated: true };
  const defaultEdgeStyle = { stroke: COLORS.wire,        strokeWidth: 1.5 };
  const aluActive = !!sigs['ALU_Mul'];
  const ldR = !!sigs['Ld_R'];
  const ldB = !!sigs['Ld_B'];

  const edges = [
    // ALU → Mux_r (in1 — ALU output feedback)
    {
      id: 'e-alu-mux_r',
      source: 'ALU', sourceHandle: 'y',
      target: 'Mux_r', targetHandle: 'in1',
      type: 'smoothstep',
      style: aluActive ? activeEdgeStyle : defaultEdgeStyle,
    },
    // ALU → Mux_b (in1 — ALU output feedback)
    {
      id: 'e-alu-mux_b',
      source: 'ALU', sourceHandle: 'y',
      target: 'Mux_b', targetHandle: 'in1',
      type: 'smoothstep',
      style: aluActive ? activeEdgeStyle : defaultEdgeStyle,
    },
    // Mux_r → Reg_r
    {
      id: 'e-mux_r-reg_r',
      source: 'Mux_r', sourceHandle: 'out',
      target: 'Reg_r', targetHandle: 'din',
      type: 'smoothstep',
      style: ldR ? { stroke: COLORS.activeReg, strokeWidth: 2.5, animated: true } : defaultEdgeStyle,
    },
    // Mux_b → Reg_b
    {
      id: 'e-mux_b-reg_b',
      source: 'Mux_b', sourceHandle: 'out',
      target: 'Reg_b', targetHandle: 'din',
      type: 'smoothstep',
      style: ldB ? { stroke: COLORS.activeReg, strokeWidth: 2.5, animated: true } : defaultEdgeStyle,
    },
    // Reg_r → ALU operand A
    {
      id: 'e-reg_r-alu',
      source: 'Reg_r', sourceHandle: 'dout',
      target: 'ALU', targetHandle: 'a',
      type: 'smoothstep',
      style: aluActive ? activeEdgeStyle : defaultEdgeStyle,
    },
    // Reg_b → ALU operand B
    {
      id: 'e-reg_b-alu',
      source: 'Reg_b', sourceHandle: 'dout',
      target: 'ALU', targetHandle: 'b',
      type: 'smoothstep',
      style: aluActive ? activeEdgeStyle : defaultEdgeStyle,
    },
  ];

  return { nodes, edges };
}
