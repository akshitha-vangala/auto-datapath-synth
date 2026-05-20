/**
 * useSimulationEngine.js
 *
 * Custom React hook that drives a cycle-accurate simulation of the RTL
 * hardware datapath described in output.json.
 *
 * CHANGE: hardwareSpec is now passed as a parameter instead of being
 * statically imported. When hardwareSpec changes (e.g. after a new
 * synthesis run), the simulation resets automatically.
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

// ─── Constants ───────────────────────────────────────────────────────────────

const PLAYBACK_INTERVAL_MS = 2500; // one clock cycle per second — readable pace

// ─── Pure helpers (no dependency on hardwareSpec) ────────────────────────────

/**
 * Evaluate an FSM branch condition string against the current register values.
 * The only condition in output.json is "i < 8".
 */
function evaluateCondition(conditionExpr, regs) {
  if (!conditionExpr) return false;

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
 */
function mergeSignals(fsmSignals, overrides) {
  return { ...fsmSignals, ...overrides };
}

/**
 * Compute the next register values for one rising clock edge.
 */
function computeNextRegisters(regs, signals, inputs) {
  let { Reg_r, Reg_b, Reg_e, Reg_i } = regs;

  const alu_mul_active = Boolean(signals['ALU_Mul']);
  const alu_out_r = alu_mul_active ? Reg_r * Reg_r : 0;
  const alu_out_b = alu_mul_active ? Reg_b * Reg_b : 0;

  if (signals['Ld_R']) {
    const muxSel_r = signals['MuxSel_R'] ?? 0;
    Reg_r = muxSel_r ? alu_out_r : inputs.r_in;
  }

  if (signals['Ld_B']) {
    const muxSel_b = signals['MuxSel_B'] ?? 0;
    Reg_b = muxSel_b ? alu_out_b : inputs.b_in;
  }

  if (signals['Ld_E']) {
    Reg_e = inputs.e_in;
  } else if (signals['Shift_E']) {
    Reg_e = Math.floor(Reg_e / 2);
  }

  if (signals['Ld_I']) {
    const muxSel_i = signals['MuxSel_I'] ?? 0;
    Reg_i = muxSel_i ? Reg_i + 1 : 0;
  }

  return { Reg_r, Reg_b, Reg_e, Reg_i };
}

/**
 * Given a current FSM state and the current register values, resolve
 * which state comes next.
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
        if (cond.wire === 'eqz')    taken = regs.Reg_e === 0;
        if (cond.wire === 'is_odd') taken = regs.Reg_e % 2 !== 0;
      }

      return taken ? next.true_id : next.false_id;
    }

    case 'Done':
    default:
      return null;
  }
}

// ─── Helpers that DO depend on the spec (built per render) ───────────────────

function buildFsmMap(hardwareSpec) {
  return Object.fromEntries(
    (hardwareSpec?.fsm ?? []).map((s) => [s.id, s])
  );
}

function buildEntryStateId(hardwareSpec) {
  return hardwareSpec?.fsm?.find((s) => s.next?.type !== 'Done')?.id ?? 0;
}

function makeInitialSnapshot(inputs, fsmMap, entryStateId) {
  const firstState = fsmMap[entryStateId];
  return {
    cycle:            0,
    fsmStateId:       entryStateId,
    fsmLabel:         firstState?.label ?? 'UNKNOWN',
    signals:          {},
    appliedOverrides: {},
    Reg_r:            0,
    Reg_b:            0,
    Reg_e:            0,
    Reg_i:            0,
    halted:           false,
  };
}

// ─── Hook ────────────────────────────────────────────────────────────────────

/**
 * @param {Object} hardwareSpec   Parsed output.json (the full { meta, datapath, fsm } object).
 *                                May be null while no synthesis has run yet.
 * @param {Object} initialInputs  { r_in, b_in, e_in }
 */
export default function useSimulationEngine(
  hardwareSpec,
  initialInputs = { r_in: 1, b_in: 3, e_in: 4 }
) {
  // ── Derived spec values (recalculated when hardwareSpec changes) ─────────────
  const fsmMap     = buildFsmMap(hardwareSpec);
  const entryId    = buildEntryStateId(hardwareSpec);

  // Keep a ref so the interval callback sees the latest spec without re-subscribe
  const fsmMapRef  = useRef(fsmMap);
  const entryIdRef = useRef(entryId);
  useEffect(() => { fsmMapRef.current  = fsmMap;  });   // no dep array — always sync
  useEffect(() => { entryIdRef.current = entryId; });

  // ── Inputs ───────────────────────────────────────────────────────────────────
  const [inputs, setInputsState] = useState(initialInputs);

  // ── History ──────────────────────────────────────────────────────────────────
  const [history, setHistory] = useState(() =>
    hardwareSpec
      ? [makeInitialSnapshot(initialInputs, fsmMap, entryId)]
      : []
  );

  // ── Cursor ───────────────────────────────────────────────────────────────────
  const [currentCycle, setCurrentCycle] = useState(0);

  // ── Playback ─────────────────────────────────────────────────────────────────
  const [isPlaying, setIsPlaying] = useState(false);

  // ── Overrides ────────────────────────────────────────────────────────────────
  const [overrides, setOverrides] = useState({});

  // Refs for interval callbacks
  const intervalRef     = useRef(null);
  const overridesRef    = useRef(overrides);
  const historyRef      = useRef(history);
  const currentCycleRef = useRef(currentCycle);
  const inputsRef       = useRef(inputs);

  useEffect(() => { overridesRef.current    = overrides;    }, [overrides]);
  useEffect(() => { historyRef.current      = history;      }, [history]);
  useEffect(() => { currentCycleRef.current = currentCycle; }, [currentCycle]);
  useEffect(() => { inputsRef.current       = inputs;       }, [inputs]);

  // ── Reset whenever hardwareSpec changes (new synthesis result) ───────────────
  useEffect(() => {
    if (!hardwareSpec) return;
    const newFsmMap  = buildFsmMap(hardwareSpec);
    const newEntryId = buildEntryStateId(hardwareSpec);
    setIsPlaying(false);
    clearInterval(intervalRef.current);
    setHistory([makeInitialSnapshot(inputsRef.current, newFsmMap, newEntryId)]);
    setCurrentCycle(0);
    setOverrides({});
  }, [hardwareSpec]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Core: advance one clock cycle ───────────────────────────────────────────
  const advanceOneCycle = useCallback(() => {
    const hist   = historyRef.current;
    const cursor = currentCycleRef.current;
    const ov     = overridesRef.current;
    const inp    = inputsRef.current;
    const fMap   = fsmMapRef.current;

    const current = hist[cursor];
    if (!current || current.halted) return;

    const fsmState = fMap[current.fsmStateId];
    if (!fsmState) return;

    const fsmSignals    = fsmState.signals ?? {};
    const mergedSignals = mergeSignals(fsmSignals, ov);

    const prevRegs = {
      Reg_r: current.Reg_r,
      Reg_b: current.Reg_b,
      Reg_e: current.Reg_e,
      Reg_i: current.Reg_i,
    };
    const nextRegs = computeNextRegisters(prevRegs, mergedSignals, inp);

    const nextFsmId = resolveNextFsmState(fsmState, nextRegs);
    const halted    = nextFsmId === null;
    const nextFsm   = halted ? fsmState : (fMap[nextFsmId] ?? fsmState);

    const nextSnapshot = {
      cycle:            current.cycle + 1,
      fsmStateId:       halted ? fsmState.id : nextFsmId,
      fsmLabel:         nextFsm.label,
      signals:          mergedSignals,
      appliedOverrides: { ...ov },
      ...nextRegs,
      halted,
    };

    const newHistory = hist.slice(0, cursor + 1).concat(nextSnapshot);
    setHistory(newHistory);
    setCurrentCycle(cursor + 1);
    setOverrides({});
  }, []);

  // ── Playback interval ────────────────────────────────────────────────────────
  useEffect(() => {
    if (isPlaying) {
      intervalRef.current = setInterval(() => {
        const current = historyRef.current[currentCycleRef.current];
        if (current?.halted) {
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
    if (history[currentCycle]?.halted) return;
    setIsPlaying(true);
  }, [history, currentCycle]);

  const pause = useCallback(() => setIsPlaying(false), []);

  const stepForward = useCallback(() => {
    pause();
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
    const fMap   = fsmMapRef.current;
    const eId    = entryIdRef.current;
    setHistory([makeInitialSnapshot(inputsRef.current, fMap, eId)]);
    setCurrentCycle(0);
    setOverrides({});
  }, [pause]);

  const setOverride = useCallback((signalName, value) => {
    setOverrides((prev) => ({ ...prev, [signalName]: value }));
  }, []);

  const clearOverride = useCallback((signalName) => {
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[signalName];
      return next;
    });
  }, []);

  const clearAllOverrides = useCallback(() => setOverrides({}), []);

  const setInputs = useCallback((r_in, b_in, e_in) => {
    const newInputs = { r_in, b_in, e_in };
    setInputsState(newInputs);
    inputsRef.current = newInputs;
    pause();
    const fMap = fsmMapRef.current;
    const eId  = entryIdRef.current;
    setHistory([makeInitialSnapshot(newInputs, fMap, eId)]);
    setCurrentCycle(0);
    setOverrides({});
  }, [pause]);

  // ── Derived ──────────────────────────────────────────────────────────────────
  const currentState = history[currentCycle] ?? history[0] ?? null;

  return {
    state:        currentState,
    currentCycle,
    isPlaying,
    history,
    overrides,
    inputs,
    hardwareSpec,
    play,
    pause,
    stepForward,
    stepBackward,
    reset,
    setOverride,
    clearOverride,
    clearAllOverrides,
    setInputs,
  };
}