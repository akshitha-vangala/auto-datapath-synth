/**
 * useSimulationEngine.js  — FIXED REVISION
 *
 * Bug fixes applied:
 *  1. play() previously captured stale `history` / `currentCycle` from the
 *     closure formed at call-time.  All interval callbacks now exclusively
 *     read from refs so they always see the latest state.
 *  2. stepForward() referenced `history.length` directly from the closure;
 *     it now reads `historyRef.current.length` so it never goes stale.
 *  3. The playback setInterval was cleared and re-created every time isPlaying
 *     changed, but the returned cleanup occasionally double-fired and cancelled
 *     a freshly started interval.  The effect now owns one interval slot via
 *     `intervalRef` and the cleanup only clears *that* ref.
 *  4. advanceOneCycle was declared with useCallback([]) which meant it could
 *     never read updated `fsmMapRef` / `inputsRef` — confirmed fine because it
 *     only touches refs, but added the empty-dep comment for clarity.
 *  5. Added defensive halted-state guard inside the setInterval tick so that
 *     auto-play stops immediately when the FSM reaches Done without waiting
 *     for the next tick.
 */

import { useState, useEffect, useRef, useCallback } from 'react';

// ─── Constants ───────────────────────────────────────────────────────────────

const PLAYBACK_INTERVAL_MS = 800; // ms per auto-advance step (snappier than original 2500 ms)

// ─── Pure helpers ─────────────────────────────────────────────────────────────

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

function mergeSignals(fsmSignals, overrides) {
  return { ...fsmSignals, ...overrides };
}

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

// ─── Spec-dependent helpers ───────────────────────────────────────────────────

function buildFsmMap(hardwareSpec) {
  return Object.fromEntries(
    (hardwareSpec?.fsm ?? []).map((s) => [s.id, s])
  );
}

function buildEntryStateId(hardwareSpec) {
  return hardwareSpec?.fsm?.[0]?.id ?? 0;
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

export default function useSimulationEngine(
  hardwareSpec,
  initialInputs = { r_in: 1, b_in: 3, e_in: 4 }
) {
  // Derived spec (recalculated when hardwareSpec changes)
  const fsmMap  = buildFsmMap(hardwareSpec);
  const entryId = buildEntryStateId(hardwareSpec);

  // Always-current refs — interval callbacks MUST use these, never closed-over state
  const fsmMapRef       = useRef(fsmMap);
  const entryIdRef      = useRef(entryId);
  const overridesRef    = useRef({});
  const historyRef      = useRef([]);
  const currentCycleRef = useRef(0);
  const inputsRef       = useRef(initialInputs);

  // Keep refs in sync every render (no dep array — unconditional sync)
  useEffect(() => { fsmMapRef.current  = fsmMap;  });
  useEffect(() => { entryIdRef.current = entryId; });

  // ── State ────────────────────────────────────────────────────────────────
  const [inputs,       setInputsState]  = useState(initialInputs);
  const [history,      setHistory]      = useState(() =>
    hardwareSpec ? [makeInitialSnapshot(initialInputs, fsmMap, entryId)] : []
  );
  const [currentCycle, setCurrentCycle] = useState(0);
  const [isPlaying,    setIsPlaying]    = useState(false);
  const [overrides,    setOverrides]    = useState({});

  // Keep mutable refs in sync with state (for interval callbacks)
  useEffect(() => { overridesRef.current    = overrides;    }, [overrides]);
  useEffect(() => { historyRef.current      = history;      }, [history]);
  useEffect(() => { currentCycleRef.current = currentCycle; }, [currentCycle]);
  useEffect(() => { inputsRef.current       = inputs;       }, [inputs]);

  // Interval handle
  const intervalRef = useRef(null);

  // ── Reset on new hardwareSpec ────────────────────────────────────────────
  useEffect(() => {
    if (!hardwareSpec) return;
    const newFsmMap  = buildFsmMap(hardwareSpec);
    const newEntryId = buildEntryStateId(hardwareSpec);
    clearInterval(intervalRef.current);
    intervalRef.current = null;
    setIsPlaying(false);
    const snap = makeInitialSnapshot(inputsRef.current, newFsmMap, newEntryId);
    historyRef.current = [snap];
    setHistory([snap]);
    currentCycleRef.current = 0;
    setCurrentCycle(0);
    overridesRef.current = {};
    setOverrides({});
  }, [hardwareSpec]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Core: advance one clock cycle ────────────────────────────────────────
  // useCallback with empty deps is intentional — this function only touches refs
  const advanceOneCycle = useCallback(() => {
    const hist   = historyRef.current;
    const cursor = currentCycleRef.current;
    const ov     = overridesRef.current;
    const inp    = inputsRef.current;
    const fMap   = fsmMapRef.current;

    // Bounds check: do nothing if already beyond known history and halted
    const current = hist[cursor];
    if (!current || current.halted) return false;

    const fsmState = fMap[current.fsmStateId];
    if (!fsmState) return false;

    const fsmSignals    = fsmState.signals ?? {};
    const mergedSignals = mergeSignals(fsmSignals, ov);

    const prevRegs = {
      Reg_r: current.Reg_r,
      Reg_b: current.Reg_b,
      Reg_e: current.Reg_e,
      Reg_i: current.Reg_i,
    };
    const nextRegs    = computeNextRegisters(prevRegs, mergedSignals, inp);
    const nextFsmId   = resolveNextFsmState(fsmState, nextRegs);
    const halted      = nextFsmId === null;
    const nextFsm     = halted ? fsmState : (fMap[nextFsmId] ?? fsmState);

    const nextSnapshot = {
      cycle:            current.cycle + 1,
      fsmStateId:       halted ? fsmState.id : nextFsmId,
      fsmLabel:         nextFsm.label,
      signals:          mergedSignals,
      appliedOverrides: { ...ov },
      ...nextRegs,
      halted,
    };

    // Truncate any "future" history beyond cursor, then append
    const newHistory = hist.slice(0, cursor + 1).concat(nextSnapshot);
    historyRef.current      = newHistory;
    currentCycleRef.current = cursor + 1;
    setHistory(newHistory);
    setCurrentCycle(cursor + 1);

    // Overrides are consumed after one cycle
    overridesRef.current = {};
    setOverrides({});

    return !halted; // return false when we just halted → interval should stop
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Playback setInterval ──────────────────────────────────────────────────
  useEffect(() => {
    if (!isPlaying) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
      return;
    }

    // Guard: don't start a new interval if one is already running
    if (intervalRef.current) return;

    intervalRef.current = setInterval(() => {
      const current = historyRef.current[currentCycleRef.current];
      if (!current || current.halted) {
        // FSM finished — stop playback automatically
        clearInterval(intervalRef.current);
        intervalRef.current = null;
        setIsPlaying(false);
        return;
      }
      const stillRunning = advanceOneCycle();
      if (!stillRunning) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
        setIsPlaying(false);
      }
    }, PLAYBACK_INTERVAL_MS);

    return () => {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  }, [isPlaying, advanceOneCycle]);

  // ── Public controls ───────────────────────────────────────────────────────

  const play = useCallback(() => {
    // Read current state from refs to avoid stale closure
    const current = historyRef.current[currentCycleRef.current];
    if (current?.halted) return;
    setIsPlaying(true);
  }, []);

  const pause = useCallback(() => {
    setIsPlaying(false);
  }, []);

  const stepForward = useCallback(() => {
    // Stop playback first
    setIsPlaying(false);
    clearInterval(intervalRef.current);
    intervalRef.current = null;

    const hist   = historyRef.current;
    const cursor = currentCycleRef.current;

    if (cursor < hist.length - 1) {
      // Already-computed future step — just move the cursor forward
      currentCycleRef.current = cursor + 1;
      setCurrentCycle(cursor + 1);
    } else {
      // At the frontier — compute the next cycle
      advanceOneCycle();
    }
  }, [advanceOneCycle]);

  const stepBackward = useCallback(() => {
    setIsPlaying(false);
    clearInterval(intervalRef.current);
    intervalRef.current = null;

    const cursor = currentCycleRef.current;
    if (cursor <= 0) return; // Already at cycle 0 — nothing to do

    const prev = Math.max(0, cursor - 1);
    currentCycleRef.current = prev;
    setCurrentCycle(prev);
  }, []);

  const reset = useCallback(() => {
    setIsPlaying(false);
    clearInterval(intervalRef.current);
    intervalRef.current = null;

    const fMap   = fsmMapRef.current;
    const eId    = entryIdRef.current;
    const snap   = makeInitialSnapshot(inputsRef.current, fMap, eId);
    historyRef.current      = [snap];
    currentCycleRef.current = 0;
    overridesRef.current    = {};
    setHistory([snap]);
    setCurrentCycle(0);
    setOverrides({});
  }, []);

  const setOverride = useCallback((signalName, value) => {
    setOverrides((prev) => {
      const next = { ...prev, [signalName]: value };
      overridesRef.current = next;
      return next;
    });
  }, []);

  const clearOverride = useCallback((signalName) => {
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[signalName];
      overridesRef.current = next;
      return next;
    });
  }, []);

  const clearAllOverrides = useCallback(() => {
    overridesRef.current = {};
    setOverrides({});
  }, []);

  const setInputs = useCallback((r_in, b_in, e_in) => {
    const newInputs = { r_in, b_in, e_in };
    inputsRef.current = newInputs;
    setInputsState(newInputs);

    // Full reset with new inputs
    setIsPlaying(false);
    clearInterval(intervalRef.current);
    intervalRef.current = null;

    const fMap = fsmMapRef.current;
    const eId  = entryIdRef.current;
    const snap = makeInitialSnapshot(newInputs, fMap, eId);
    historyRef.current      = [snap];
    currentCycleRef.current = 0;
    overridesRef.current    = {};
    setHistory([snap]);
    setCurrentCycle(0);
    setOverrides({});
  }, []);

  // ── Derived ───────────────────────────────────────────────────────────────
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