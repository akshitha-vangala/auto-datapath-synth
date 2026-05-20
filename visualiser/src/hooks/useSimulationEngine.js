/**
 * useSimulationEngine.js
 *
 * Custom React hook that drives a cycle-accurate simulation of the RTL
 * hardware datapath described in output.json.
 *
 * Architecture — Square-and-Multiply algorithm
 * ─────────────────────────────────────────────
 *   Registers : Reg_r, Reg_b, Reg_e, Reg_i
 *   ALU       : Mul (r*r, b*b)
 *   Muxes     : Mux_r (sel=0 → external input, sel=1 → ALU)
 *               Mux_b (sel=0 → external input, sel=1 → ALU)
 *   FSM       : sequence of states from output.json, each carrying a
 *               "signals" dict of active control wires
 *
 * Exposed API
 * ───────────
 *   state            Current simulation snapshot (see HardwareState typedef)
 *   currentCycle     Index into history[] (0-based)
 *   isPlaying        Whether the auto-advance interval is running
 *   history          Array of every HardwareState ever computed
 *   overrides        Dict of user-forced signal values { signalName: 0|1 }
 *
 *   play()           Start auto-advance at PLAYBACK_INTERVAL_MS per cycle
 *   pause()          Stop auto-advance
 *   stepForward()    Advance one clock cycle
 *   stepBackward()   Rewind one clock cycle
 *   reset()          Return to cycle 0
 *   setOverride(name, value)   Force a control signal for the next cycle
 *   clearOverride(name)        Remove an override
 *   clearAllOverrides()        Remove all overrides
 *   setInputs(r, b, e)         Configure the three external input values
 *                              (only effective when currentState is LD_R/LD_B/LD_E)
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import hardwareSpec from '../output.json';

// ─── Constants ───────────────────────────────────────────────────────────────

const PLAYBACK_INTERVAL_MS = 2500; // 1 clock cycle per second — readable pace

// Build a fast lookup map: stateId → FSM state object
const FSM_MAP = Object.fromEntries(
  hardwareSpec.fsm.map((s) => [s.id, s])
);

// The first FSM state is always the entry point (lowest id that isn't HALT)
const ENTRY_STATE_ID = hardwareSpec.fsm.find((s) => s.next.type !== 'Done')?.id ?? 0;

// ─── Types (JSDoc) ───────────────────────────────────────────────────────────

/**
 * @typedef {Object} HardwareState
 * @property {number}  cycle          Clock cycle index (0 = initial)
 * @property {number}  fsmStateId     ID of the active FSM state
 * @property {string}  fsmLabel       Human-readable FSM state label
 * @property {Object}  signals        Active control signals this cycle { name: 0|1 }
 * @property {Object}  appliedOverrides Overrides that were active this cycle
 * @property {number}  Reg_r          Integer value in register R
 * @property {number}  Reg_b          Integer value in register B
 * @property {number}  Reg_e          Integer value in register E (exponent)
 * @property {number}  Reg_i          Integer value in register I (loop counter)
 * @property {boolean} halted         True when FSM reached a Done transition
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Evaluate an FSM branch condition string against the current register values.
 * The only condition in output.json is "i < 8".
 */
function evaluateCondition(conditionExpr, regs) {
  if (!conditionExpr) return false;

  // Simple safe evaluator — supports <, >, ==, <=, >=
  // Maps variable names to register values
  const tokenised = conditionExpr
    .replace(/\bi\b/g, String(regs.Reg_i))
    .replace(/\be\b/g, String(regs.Reg_e))
    .replace(/\br\b/g, String(regs.Reg_r))
    .replace(/\bb\b/g, String(regs.Reg_b));

  try {
    // eslint-disable-next-line no-new-func
    return Boolean(Function('"use strict"; return (' + tokenised + ')')());
  } catch {
    console.warn('[SimEngine] Could not evaluate condition:', conditionExpr);
    return false;
  }
}

/**
 * Merge the FSM's declared signals with any user overrides.
 * Overrides shadow the FSM value for exactly one cycle.
 *
 * @param {Object} fsmSignals  e.g. { Ld_R: 1, MuxSel_R: 1, ALU_Mul: 1 }
 * @param {Object} overrides   e.g. { MuxSel_R: 0 }
 * @returns {Object}           Merged signal map
 */
function mergeSignals(fsmSignals, overrides) {
  return { ...fsmSignals, ...overrides };
}

/**
 * Compute the next register values for one rising clock edge.
 *
 * Signal semantics (from fsm.ml comments):
 *   Ld_R      — load enable for Reg_r
 *   Ld_B      — load enable for Reg_b
 *   Ld_E      — load enable for Reg_e (initial write from input port)
 *   Ld_I      — load enable for Reg_i (loop counter)
 *   MuxSel_R  — 0 = init/external input, 1 = ALU output
 *   MuxSel_B  — 0 = init/external input, 1 = ALU output
 *   MuxSel_I  — 0 = reset to 0,          1 = Reg_i + 1 (increment)
 *   ALU_Mul   — activates Mul ALU (computes r*r for Reg_r and b*b for Reg_b)
 *
 * @param {Object} regs     Current register values
 * @param {Object} signals  Merged (FSM + overrides) signal map
 * @param {Object} inputs   External inputs { r_in, b_in, e_in }
 * @returns {Object}        Next register values
 */
function computeNextRegisters(regs, signals, inputs) {
  let { Reg_r, Reg_b, Reg_e, Reg_i } = regs;

  // ── ALU ────────────────────────────────────────────────────────────────────
  // The multiplier fires when ALU_Mul is asserted.
  // For Reg_r it computes r * r; for Reg_b it computes b * b.
  const alu_mul_active = Boolean(signals['ALU_Mul']);
  const alu_out_r = alu_mul_active ? Reg_r * Reg_r : 0;
  const alu_out_b = alu_mul_active ? Reg_b * Reg_b : 0;

  // ── Mux_r → Reg_r ──────────────────────────────────────────────────────────
  if (signals['Ld_R']) {
    const muxSel_r = signals['MuxSel_R'] ?? 0;
    Reg_r = muxSel_r ? alu_out_r : inputs.r_in;
  }

  // ── Mux_b → Reg_b ──────────────────────────────────────────────────────────
  if (signals['Ld_B']) {
    const muxSel_b = signals['MuxSel_B'] ?? 0;
    Reg_b = muxSel_b ? alu_out_b : inputs.b_in;
  }

  // ── Reg_e (exponent — shift register in hardware, simple integer here) ──────
  // Ld_E  = initial load from input
  // Shift_E = right-shift by 1 (SReg semantics)
  if (signals['Ld_E']) {
    Reg_e = inputs.e_in;
  } else if (signals['Shift_E']) {
    Reg_e = Math.floor(Reg_e / 2); // logical right shift by 1
  }

  // ── Reg_i (loop counter) ────────────────────────────────────────────────────
  if (signals['Ld_I']) {
    const muxSel_i = signals['MuxSel_I'] ?? 0;
    Reg_i = muxSel_i ? Reg_i + 1 : 0;
  }

  return { Reg_r, Reg_b, Reg_e, Reg_i };
}

/**
 * Given a current FSM state and the current register values, resolve
 * which state comes next.
 *
 * @param {Object} fsmState  FSM state object from FSM_MAP
 * @param {Object} regs      Current register values
 * @returns {number|null}    Next FSM state ID, or null if Done
 */
function resolveNextFsmState(fsmState, regs) {
  const { next } = fsmState;
  if (!next) return null;

  switch (next.type) {
    case 'Goto':
      return next.target_id;

    case 'Branch': {
      const cond = next.condition;
      let taken = false;

      if (cond.kind === 'expr') {
        taken = evaluateCondition(cond.expr, regs);
      } else if (cond.kind === 'wire') {
        // status wire from comparator — not used in current output.json
        // but supported for forward compatibility
        if (cond.wire === 'eqz')    taken = regs.Reg_e === 0;
        if (cond.wire === 'is_odd') taken = regs.Reg_e % 2 !== 0;
      }

      return taken ? next.true_id : next.false_id;
    }

    case 'Done':
    default:
      return null; // halt
  }
}

// ─── Initial snapshot ────────────────────────────────────────────────────────

function makeInitialSnapshot(inputs) {
  const firstState = FSM_MAP[ENTRY_STATE_ID];
  return {
    cycle:            0,
    fsmStateId:       ENTRY_STATE_ID,
    fsmLabel:         firstState?.label ?? 'UNKNOWN',
    signals:          {},        // no signals fire at cycle 0 (pre-clock)
    appliedOverrides: {},
    Reg_r:            0,
    Reg_b:            0,
    Reg_e:            0,
    Reg_i:            0,
    halted:           false,
  };
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export default function useSimulationEngine(initialInputs = { r_in: 1, b_in: 3, e_in: 4 }) {
  // ── Inputs (the three external values loaded in LD_R / LD_B / LD_E) ─────────
  const [inputs, setInputsState] = useState(initialInputs);

  // ── History: array of HardwareState snapshots, one per cycle ────────────────
  const [history, setHistory] = useState(() => [makeInitialSnapshot(initialInputs)]);

  // ── Cursor pointing at the "current" cycle within history[] ─────────────────
  const [currentCycle, setCurrentCycle] = useState(0);

  // ── Playback state ───────────────────────────────────────────────────────────
  const [isPlaying, setIsPlaying] = useState(false);

  // ── Fault-injection overrides { signalName: 0|1 } ───────────────────────────
  const [overrides, setOverrides] = useState({});

  // Ref so interval callback always sees fresh values without re-registering
  const intervalRef   = useRef(null);
  const overridesRef  = useRef(overrides);
  const historyRef    = useRef(history);
  const currentCycleRef = useRef(currentCycle);
  const inputsRef     = useRef(inputs);

  // Keep refs in sync
  useEffect(() => { overridesRef.current  = overrides;     }, [overrides]);
  useEffect(() => { historyRef.current    = history;        }, [history]);
  useEffect(() => { currentCycleRef.current = currentCycle; }, [currentCycle]);
  useEffect(() => { inputsRef.current     = inputs;         }, [inputs]);

  // ── Core: advance one clock cycle ───────────────────────────────────────────
  const advanceOneCycle = useCallback(() => {
    const hist   = historyRef.current;
    const cursor = currentCycleRef.current;
    const ov     = overridesRef.current;
    const inp    = inputsRef.current;

    const current = hist[cursor];
    if (!current || current.halted) return; // nothing to do

    const fsmState = FSM_MAP[current.fsmStateId];
    if (!fsmState) return;

    // Merge FSM signals with user overrides
    const fsmSignals     = fsmState.signals ?? {};
    const mergedSignals  = mergeSignals(fsmSignals, ov);

    // Compute register values at the rising clock edge
    const prevRegs = {
      Reg_r: current.Reg_r,
      Reg_b: current.Reg_b,
      Reg_e: current.Reg_e,
      Reg_i: current.Reg_i,
    };
    const nextRegs = computeNextRegisters(prevRegs, mergedSignals, inp);

    // Resolve FSM transition (uses updated registers so branches see new values)
    const nextFsmId = resolveNextFsmState(fsmState, nextRegs);
    const halted    = nextFsmId === null;
    const nextFsm   = halted ? fsmState : (FSM_MAP[nextFsmId] ?? fsmState);

    const nextSnapshot = {
      cycle:            current.cycle + 1,
      fsmStateId:       halted ? fsmState.id : nextFsmId,
      fsmLabel:         nextFsm.label,
      signals:          mergedSignals,
      appliedOverrides: { ...ov },
      ...nextRegs,
      halted,
    };

    // If we're not at the tip of history, truncate the future (new branch)
    const newHistory = hist.slice(0, cursor + 1).concat(nextSnapshot);

    setHistory(newHistory);
    setCurrentCycle(cursor + 1);

    // Overrides are consumed after one cycle
    setOverrides({});
  }, []);

  // ── Playback interval management ────────────────────────────────────────────
  useEffect(() => {
    if (isPlaying) {
      intervalRef.current = setInterval(() => {
        const current = historyRef.current[currentCycleRef.current];
        if (current?.halted) {
          // Auto-stop when the FSM reaches Done
          setIsPlaying(false);
          return;
        }
        advanceOneCycle();
      }, PLAYBACK_INTERVAL_MS);
    } else {
      clearInterval(intervalRef.current);
    }

    return () => clearInterval(intervalRef.current);
  }, [isPlaying, advanceOneCycle]);

  // ── Public controls ──────────────────────────────────────────────────────────

  const play = useCallback(() => {
    if (history[currentCycle]?.halted) return; // don't play a finished sim
    setIsPlaying(true);
  }, [history, currentCycle]);

  const pause = useCallback(() => {
    setIsPlaying(false);
  }, []);

  const stepForward = useCallback(() => {
    pause();
    // If there's pre-computed history ahead (time-travel), just move cursor
    if (currentCycle < history.length - 1) {
      setCurrentCycle((c) => c + 1);
    } else {
      advanceOneCycle();
    }
  }, [pause, currentCycle, history.length, advanceOneCycle]);

  const stepBackward = useCallback(() => {
    pause();
    setCurrentCycle((c) => Math.max(0, c - 1));
  }, [pause]);

  const reset = useCallback(() => {
    pause();
    setHistory([makeInitialSnapshot(inputsRef.current)]);
    setCurrentCycle(0);
    setOverrides({});
  }, [pause]);

  /** Force a control signal for the NEXT cycle computation. */
  const setOverride = useCallback((signalName, value) => {
    setOverrides((prev) => ({ ...prev, [signalName]: value }));
  }, []);

  /** Remove a single override. */
  const clearOverride = useCallback((signalName) => {
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[signalName];
      return next;
    });
  }, []);

  /** Remove all overrides. */
  const clearAllOverrides = useCallback(() => {
    setOverrides({});
  }, []);

  /**
   * Update the external input values (r_in, b_in, e_in).
   * Resets the simulation so changes take effect from the start.
   */
  const setInputs = useCallback((r_in, b_in, e_in) => {
    const newInputs = { r_in, b_in, e_in };
    setInputsState(newInputs);
    inputsRef.current = newInputs;
    // Reset so new inputs are loaded in LD_R / LD_B / LD_E states
    pause();
    setHistory([makeInitialSnapshot(newInputs)]);
    setCurrentCycle(0);
    setOverrides({});
  }, [pause]);

  // ── Derived convenience values ───────────────────────────────────────────────
  const currentState = history[currentCycle] ?? history[0];

  return {
    // State
    state:        currentState,
    currentCycle,
    isPlaying,
    history,
    overrides,
    inputs,

    // Hardware spec (handy for UI rendering)
    hardwareSpec,

    // Playback controls
    play,
    pause,
    stepForward,
    stepBackward,
    reset,

    // Fault injection
    setOverride,
    clearOverride,
    clearAllOverrides,

    // Input configuration
    setInputs,
  };
}