(* lib/fsm.ml *)
open Ast

(* ─────────────────────────────────────────────────────────────────────────────
   Generic RTL Control-Signal Model
   ─────────────────────────────────────────────────────────────────────────────
   Every FSM state carries a dictionary of boolean control signals that map
   1-to-1 onto physical wires in the generated RTL netlist.

   Signal vocabulary is derived *entirely* from the input AST; no signal name
   is hard-coded to a specific algorithm.  The naming convention is:

     Ld_<Var>        – rising-edge load enable for Register Reg_<Var>
     MuxSel_<Var>    – mux-select for the N-to-1 mux feeding Reg_<Var>
                       (present only when the variable has >1 write site)
     ALU_<Op>        – combinational enable for the named ALU unit
     Cmp_<Var>       – read the comparator watching Reg_<Var>

   The FSM compiler inspects every Assign node to decide the minimal set of
   signals that must assert in that clock cycle.

   Condition translation  (condition_of_expr):
   ─────────────────────────────────────────────
   Every conditional expression (from If / While / For) is translated to a
   generic [ExprCond] record that carries the original AST expression.
   The React visualiser can render it as a truth-condition label on the
   branch arc.  We no longer pattern-match specific variable names or
   algorithm-specific wire names.
   ───────────────────────────────────────────────────────────────────────────── *)

(* ── Signal record ──────────────────────────────────────────────────────────── *)
type signal = {
  name  : string;
  value : bool;   (* always true in synthesised output; kept for extensibility *)
}

(* ── Branch condition ────────────────────────────────────────────────────────
   Every conditional in the AST lowers to an ExprCond that carries the
   original AST expression.  The JSON serialiser turns it into a readable
   string label; the visualiser can evaluate or annotate it.

   CmpWire is used when a Comparator component was allocated for a variable
   and the branch is a simple relational check on that variable — the FSM
   reads a status wire instead of recomputing the comparison combinatorially.
   ─────────────────────────────────────────────────────────────────────────── *)
type condition =
  | CmpWire  of string        (* named comparator status wire: "cmp_<var>" *)
  | ExprCond of expr          (* generic expression condition               *)

type transition =
  | Goto   of int
  | Branch of condition * int * int   (* condition, true_id, false_id *)
  | Done

type state = {
  id      : int;
  label   : string;
  signals : signal list;
  next    : transition;
}

(* ─────────────────────────────────────────────────────────────────────────────
   State-counter  (reset on each [generate] call)
   ───────────────────────────────────────────────────────────────────────────── *)
let state_counter = ref 0
let new_id () = let i = !state_counter in incr state_counter; i

let sig_ name = { name; value = true }

(* ─────────────────────────────────────────────────────────────────────────────
   Context record  (passed through recursive compilation)
   ─────────────────────────────────────────────────────────────────────────────
   [multi_write_vars] — set of variable names that have more than one write
   site in the entire program.  Used to decide whether a MuxSel signal must
   fire alongside the load enable.
   ───────────────────────────────────────────────────────────────────────────── *)
type ctx = {
  multi_write_vars : string list;
}

(* ─────────────────────────────────────────────────────────────────────────────
   Variable write-site analysis
   ───────────────────────────────────────────────────────────────────────────── *)
let count_writes block =
  let tbl : (string, int) Hashtbl.t = Hashtbl.create 16 in
  let bump v =
    Hashtbl.replace tbl v (1 + Option.value ~default:0 (Hashtbl.find_opt tbl v))
  in
  let rec walk = function
    | []                      -> ()
    | Assign (v, _)  :: rest  -> bump v; walk rest
    | If (_, tb, fb) :: rest  -> walk tb; walk fb; walk rest
    | For (v, _, _, b):: rest -> bump v; walk b; walk rest
    | While (_, b)   :: rest  -> walk b; walk rest
    | Return _       :: rest  -> walk rest
  in
  walk block; tbl

(* ─────────────────────────────────────────────────────────────────────────────
   Control-signal derivation
   ─────────────────────────────────────────────────────────────────────────────
   For a single [Assign(var, expr)] node we derive the list of RTL control
   signals that must assert in that clock cycle:

     Ld_<Var>        always — enables the register load
     MuxSel_<Var>    when the variable has multiple write sites AND the source
                     expression is not a trivial init (Var/Const) — indicates
                     the ALU result path is selected
     ALU_<Op>        for every operator that appears in [expr]
   ───────────────────────────────────────────────────────────────────────────── *)

let rec collect_ops_in_expr = function
  | Const _ | Var _ -> []
  | BinOp (op, e1, e2) -> op :: collect_ops_in_expr e1 @ collect_ops_in_expr e2

let string_of_op = function
  | Add  -> "Add"  | Sub  -> "Sub"  | Mul  -> "Mul"
  | Div  -> "Div"  | Mod  -> "Mod"
  | Shl  -> "Shl"  | Shr  -> "Shr"  | Sar  -> "Sar"
  | BAnd -> "BAnd" | BOr  -> "BOr"  | BXor -> "BXor"
  | Eq   -> "Eq"   | NEq  -> "NEq"
  | Lt   -> "Lt"   | Lte  -> "Lte"
  | Gt   -> "Gt"   | Gte  -> "Gte"

let is_trivial_expr = function
  | Var _ | Const _ -> true
  | _               -> false

(* Derive signals for one assignment.  [in_loop] is true when the statement
   is inside a While or For body — used to set MuxSel correctly. *)
let signals_of_assign ctx var expr ~in_loop =
  (* Load enable: always required *)
  let ld_sig    = sig_ ("Ld_" ^ String.capitalize_ascii var) in

  (* MuxSel: only for multi-write variables when routing the ALU output path *)
  let mux_sigs  =
    if List.mem var ctx.multi_write_vars && in_loop && not (is_trivial_expr expr) then
      [ sig_ ("MuxSel_" ^ String.capitalize_ascii var) ]
    else
      []
  in

  (* ALU enables: one per distinct operator used in the expression *)
  let ops_used  = List.sort_uniq compare (collect_ops_in_expr expr) in
  let alu_sigs  = List.map (fun op -> sig_ ("ALU_" ^ string_of_op op)) ops_used in

  ld_sig :: mux_sigs @ alu_sigs

(* ─────────────────────────────────────────────────────────────────────────────
   Condition translation
   ─────────────────────────────────────────────────────────────────────────────
   Every conditional expression is lowered to a [condition] value.

   If the expression is a simple relational comparison on a single variable
   (e.g. [x > 0], [count < limit], [flag == 1]) we map it to a [CmpWire]
   referencing the Comparator allocated for that variable.  This avoids
   re-instantiating comparison logic inside the FSM.

   All other expressions (compound conditions, nested arithmetic) fall back
   to [ExprCond] which is serialised as a readable string in the JSON output.
   ───────────────────────────────────────────────────────────────────────────── *)

(* Extract the single "watched" variable if this is a simple cmp expression *)
let simple_cmp_var = function
  | BinOp ((Eq | NEq | Lt | Lte | Gt | Gte), Var v, _) -> Some v
  | BinOp ((Eq | NEq | Lt | Lte | Gt | Gte), _, Var v) -> Some v
  | _ -> None

let condition_of_expr expr =
  match simple_cmp_var expr with
  | Some v -> CmpWire ("cmp_" ^ v)
  | None   -> ExprCond expr

(* ─────────────────────────────────────────────────────────────────────────────
   AST → FSM compiler
   ─────────────────────────────────────────────────────────────────────────────
   [compile_block] returns a flat list of [state] records.

   [start_id] and [exit_id] are pre-allocated by the caller so that forward
   and backward edges can be wired without a second pass.

   The [~in_loop] flag propagates through For/While bodies so that MuxSel
   signals are correctly generated for variables updated inside loops.
   ───────────────────────────────────────────────────────────────────────────── *)
let rec compile_block ctx ?(in_loop = false) stmts start_id exit_id =
  match stmts with
  (* ── Empty block: thread through to exit ─────────────────────────────────── *)
  | [] ->
      [ { id = start_id; label = "PASS"; signals = []; next = Goto exit_id } ]

  (* ── Assign ──────────────────────────────────────────────────────────────── *)
  | Assign (var, expr) :: rest ->
      let next_id  = if rest = [] then exit_id else new_id () in
      let sigs     = signals_of_assign ctx var expr ~in_loop in
      let label    = "LD_" ^ String.uppercase_ascii var in
      let cur      = { id = start_id; label; signals = sigs; next = Goto next_id } in
      let rest_sts =
        if rest = [] then []
        else compile_block ctx ~in_loop rest next_id exit_id
      in
      cur :: rest_sts

  (* ── Return ──────────────────────────────────────────────────────────────── *)
  | Return expr :: rest ->
      (* Treat as an assignment to a synthetic "result" variable, then halt *)
      let next_id  = if rest = [] then exit_id else new_id () in
      let sigs     = signals_of_assign ctx "result" expr ~in_loop in
      let cur      = { id = start_id; label = "RETURN"; signals = sigs; next = Goto next_id } in
      let rest_sts =
        if rest = [] then []
        else compile_block ctx ~in_loop rest next_id exit_id
      in
      cur :: rest_sts

  (* ── If / else ───────────────────────────────────────────────────────────── *)
  | If (cond, true_blk, false_blk) :: rest ->
      let true_start  = new_id () in
      let false_start = new_id () in
      let merge_id    = if rest = [] then exit_id else new_id () in
      let hw_cond     = condition_of_expr cond in

      let branch_st   = {
        id = start_id; label = "BRANCH";
        signals = [];
        next    = Branch (hw_cond, true_start, false_start);
      } in

      let true_sts    = compile_block ctx ~in_loop true_blk  true_start  merge_id in
      let false_sts   = compile_block ctx ~in_loop false_blk false_start merge_id in
      let rest_sts    =
        if rest = [] then []
        else compile_block ctx ~in_loop rest merge_id exit_id
      in
      branch_st :: (true_sts @ false_sts @ rest_sts)

  (* ── While ───────────────────────────────────────────────────────────────── *)
  | While (cond, body) :: rest ->
      (*  check_id  – comparator check; branch to body or exit
          body_start – first state of loop body (loops back to check_id)   *)
      let check_id   = new_id () in
      let body_start = new_id () in
      let merge_id   = if rest = [] then exit_id else new_id () in
      let hw_cond    = condition_of_expr cond in

      let entry_st   = {
        id = start_id; label = "WHILE_ENTRY";
        signals = []; next = Goto check_id;
      } in
      let check_st   = {
        id = check_id; label = "WHILE_CHECK";
        signals = [];
        next    = Branch (hw_cond, body_start, merge_id);
      } in

      (* Body compiles with in_loop=true so MuxSels are set correctly *)
      let body_sts   = compile_block ctx ~in_loop:true body body_start check_id in
      let rest_sts   =
        if rest = [] then []
        else compile_block ctx ~in_loop rest merge_id exit_id
      in
      entry_st :: check_st :: body_sts @ rest_sts

  (* ── For ─────────────────────────────────────────────────────────────────── *)
  | For (var, start_e, stop_e, body) :: rest ->
      let check_id   = new_id () in
      let body_start = new_id () in
      let inc_id     = new_id () in
      let merge_id   = if rest = [] then exit_id else new_id () in

      (* Initialise the loop variable *)
      let init_sigs  = signals_of_assign ctx var start_e ~in_loop:false in
      let init_st    = {
        id = start_id;
        label = "FOR_INIT_" ^ String.uppercase_ascii var;
        signals = init_sigs;
        next    = Goto check_id;
      } in

      (* Check loop bound: var < stop_e *)
      let loop_cond  = ExprCond (BinOp (Lt, Var var, stop_e)) in
      let check_st   = {
        id = check_id; label = "FOR_CHECK";
        signals = [];
        next    = Branch (loop_cond, body_start, merge_id);
      } in

      let body_sts   = compile_block ctx ~in_loop:true body body_start inc_id in

      (* Increment: var = var + 1 *)
      let inc_expr   = BinOp (Add, Var var, Const 1) in
      let inc_sigs   = signals_of_assign ctx var inc_expr ~in_loop:true in
      let inc_st     = {
        id = inc_id;
        label = "FOR_INC_" ^ String.uppercase_ascii var;
        signals = inc_sigs;
        next    = Goto check_id;
      } in

      let rest_sts   =
        if rest = [] then []
        else compile_block ctx ~in_loop rest merge_id exit_id
      in
      init_st :: check_st :: body_sts @ [ inc_st ] @ rest_sts

(* ─────────────────────────────────────────────────────────────────────────────
   Public entry point
   ───────────────────────────────────────────────────────────────────────────── *)
let generate ast =
  state_counter := 0;

  (* Build context: find variables with multiple write sites *)
  let write_counts = count_writes ast in
  let multi_write_vars =
    Hashtbl.fold (fun v cnt acc ->
      if cnt > 1 then v :: acc else acc
    ) write_counts []
  in
  let ctx = { multi_write_vars } in

  let start_id = new_id () in
  let exit_id  = new_id () in
  let states   = compile_block ctx ast start_id exit_id in
  let halt     = { id = exit_id; label = "HALT"; signals = []; next = Done } in
  states @ [ halt ]

(* ─────────────────────────────────────────────────────────────────────────────
   Printer
   ───────────────────────────────────────────────────────────────────────────── *)

let rec string_of_expr_cond = function
  | Var v              -> v
  | Const i            -> string_of_int i
  | BinOp (op, e1, e2) ->
      let op_str = match op with
        | Add -> "+"  | Sub -> "-"  | Mul -> "*"  | Div -> "/"  | Mod -> "%"
        | Shl -> "<<" | Shr -> ">>" | Sar -> ">>>"
        | BAnd-> "&"  | BOr -> "|"  | BXor-> "^"
        | Eq  -> "==" | NEq -> "!=" | Lt  -> "<"  | Lte -> "<="
        | Gt  -> ">"  | Gte -> ">="
      in
      Printf.sprintf "(%s %s %s)"
        (string_of_expr_cond e1) op_str (string_of_expr_cond e2)

let string_of_condition = function
  | CmpWire  w -> w
  | ExprCond e -> string_of_expr_cond e

let print_fsm states =
  Printf.printf "\n--- GENERATED CONTROL PATH (FSM) ---\n";
  List.iter (fun s ->
    Printf.printf "State %d [%s]:\n" s.id s.label;
    if s.signals = [] then
      Printf.printf "  [Signals]  (none — control-only state)\n"
    else
      List.iter (fun sg ->
        Printf.printf "  [Signal]   %s = %d\n" sg.name (if sg.value then 1 else 0)
      ) s.signals;
    (match s.next with
     | Goto id ->
         Printf.printf "  [Next]     Goto State %d\n" id
     | Branch (cond, t, f) ->
         Printf.printf "  [Next]     if (%s) → State %d else → State %d\n"
           (string_of_condition cond) t f
     | Done ->
         Printf.printf "  [Next]     HALT\n")
  ) states
