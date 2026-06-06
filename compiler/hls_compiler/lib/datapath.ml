(* lib/datapath.ml *)
open Ast

(* ─────────────────────────────────────────────────────────────────────────────
   RTL Component taxonomy
   ─────────────────────────────────────────────────────────────────────────────
   Every component maps 1-to-1 onto a primitive in the generated netlist.

   Register v        – edge-triggered D flip-flop bank for variable [v].
                       Receives a load-enable signal (Ld_<v>) from the FSM.
   Mux inputs        – N-to-1 data selector feeding a Register or ALU input.
                       Receives a select signal (MuxSel_<v>) from the FSM.
                       Allocated automatically whenever a variable is written
                       from more than one source expression.
   ALU op            – combinational functional unit implementing [op].
                       One ALU is instantiated per unique operator that appears
                       in any assignment in the program.
   Comparator var    – dedicated 1-bit output unit watching Register [var].
                       Allocated for every variable that feeds a conditional
                       expression (If / While / For guard).  Exposes a generic
                       status wire ("cmp_<var>") to the FSM.
   Constant i        – hardwired literal; no storage needed.

   Note: ShiftRegister is no longer a special primitive.  A right-shift is
   modelled as a generic ALU(Shr) whose output feeds a standard Register.
   This is functionally equivalent and avoids hard-coding any algorithm.
   ───────────────────────────────────────────────────────────────────────────── *)
type component_type =
  | Register    of string        (* variable name                         *)
  | Mux         of int           (* fan-in (number of input ports)        *)
  | ALU         of op            (* operation this unit implements        *)
  | Comparator  of string        (* variable name this unit watches       *)
  | Constant    of int           (* literal value                         *)

type component = {
  id   : string;
  kind : component_type;
}

(* A directed data wire between two component ports *)
type connection = {
  src  : string;   (* "CompId.port" or just "CompId" for single-output units *)
  dest : string;
}

type t = {
  components  : component list;
  connections : connection list;
}

(* ─────────────────────────────────────────────────────────────────────────────
   AST analysis helpers
   ───────────────────────────────────────────────────────────────────────────── *)

(* Collect (variable_name × expr list) for every assignment reachable in the
   AST, including those inside nested If / For / While blocks.
   The expr list records every distinct source expression written to that var. *)
let analyze_assignments block =
  let rec walk acc = function
    | []                          -> acc
    | Assign (id, expr) :: rest   ->
        let prev  = Option.value ~default:[] (List.assoc_opt id acc) in
        let acc'  = (id, expr :: prev) :: List.remove_assoc id acc in
        walk acc' rest
    | If (_, tb, fb) :: rest      -> walk (walk (walk acc tb) fb) rest
    | For (v, init, _, body) :: rest ->
        (* Treat the loop-variable initialisation as a synthetic assignment *)
        walk (walk (walk acc [Assign (v, init)]) body) rest
    | While (_, body) :: rest     -> walk (walk acc body) rest
    | Return _ :: rest            -> walk acc rest
  in
  walk [] block

(* Collect every operator that appears anywhere in the program (recursively). *)
let collect_operators block =
  let seen = Hashtbl.create 16 in
  let add op = Hashtbl.replace seen op () in
  let rec walk_expr = function
    | Const _ | Var _ -> ()
    | BinOp (op, e1, e2) -> add op; walk_expr e1; walk_expr e2
  in
  let rec walk_stmts = function
    | []                       -> ()
    | Assign (_, e)  :: rest   -> walk_expr e; walk_stmts rest
    | If (c, tb, fb) :: rest   -> walk_expr c; walk_stmts tb; walk_stmts fb; walk_stmts rest
    | For (_, s, stop, b) :: rest -> walk_expr s; walk_expr stop; walk_stmts b; walk_stmts rest
    | While (c, b)   :: rest   -> walk_expr c; walk_stmts b; walk_stmts rest
    | Return e       :: rest   -> walk_expr e; walk_stmts rest
  in
  walk_stmts block;
  Hashtbl.fold (fun op () acc -> op :: acc) seen []

(* Collect every variable name that appears in any conditional position
   (If condition, While guard, For bound) throughout the program.
   These variables may need a hardware Comparator. *)
let collect_condition_vars block =
  (* Extract variable names referenced directly in a comparison expression *)
  let rec vars_in_cond acc = function
    | BinOp ((Eq | NEq | Lt | Lte | Gt | Gte), e1, e2) ->
        let rec vars_of = function
          | Var v            -> [v]
          | BinOp (_, a, b)  -> vars_of a @ vars_of b
          | Const _          -> []
        in
        acc @ vars_of e1 @ vars_of e2
    | BinOp (_, e1, e2) -> vars_in_cond (vars_in_cond acc e1) e2
    | _                  -> acc
  in
  let rec walk acc = function
    | []                           -> acc
    | Assign _         :: rest     -> walk acc rest
    | If (cond, tb, fb) :: rest    ->
        walk (walk (walk (vars_in_cond acc cond) tb) fb) rest
    | For (_, s, stop, b) :: rest  ->
        walk (walk (vars_in_cond (vars_in_cond acc s) stop) b) rest
    | While (cond, b)  :: rest     ->
        walk (walk (vars_in_cond acc cond) b) rest
    | Return _         :: rest     -> walk acc rest
  in
  walk [] block

(* ─────────────────────────────────────────────────────────────────────────────
   Connection inference
   ─────────────────────────────────────────────────────────────────────────────
   We walk each assignment expression and emit wires from source components
   (Registers, Constants, ALU outputs) to destination ALU inputs and Registers.
   The traversal is recursive so nested expressions chain ALUs correctly.
   ───────────────────────────────────────────────────────────────────────────── *)

let string_of_op = function
  | Add  -> "Add"  | Sub  -> "Sub"  | Mul  -> "Mul"
  | Div  -> "Div"  | Mod  -> "Mod"
  | Shl  -> "Shl"  | Shr  -> "Shr"  | Sar  -> "Sar"
  | BAnd -> "BAnd" | BOr  -> "BOr"  | BXor -> "BXor"
  | Eq   -> "Eq"   | NEq  -> "NEq"
  | Lt   -> "Lt"   | Lte  -> "Lte"
  | Gt   -> "Gt"   | Gte  -> "Gte"

(* For a given expression return the component id whose output carries the
   value of that expression, generating intermediate connection records as a
   side-effect.  [conns] is an accumulator (reversed). *)
let rec infer_connections_for_expr expr conns =
  match expr with
  | Const i ->
      let id = Printf.sprintf "Const_%d" i in
      id, conns
  | Var v ->
      let id = "Reg_" ^ v in
      id, conns
  | BinOp (op, e1, e2) ->
      let alu_id    = "ALU_" ^ string_of_op op in
      let src1, c1  = infer_connections_for_expr e1 conns in
      let src2, c2  = infer_connections_for_expr e2 c1 in
      let wire1     = { src = src1; dest = alu_id ^ ".in0" } in
      let wire2     = { src = src2; dest = alu_id ^ ".in1" } in
      alu_id, wire2 :: wire1 :: c2

let infer_connections assignments =
  List.fold_left (fun acc_conns (var_name, sources) ->
    let dest_id =
      if List.length sources > 1
      then "Mux_" ^ var_name   (* goes through mux before register *)
      else "Reg_" ^ var_name
    in
    List.fold_left (fun conns src_expr ->
      let src_id, conns' = infer_connections_for_expr src_expr conns in
      { src = src_id; dest = dest_id } :: conns'
    ) acc_conns sources
  ) [] assignments

(* ─────────────────────────────────────────────────────────────────────────────
   Core allocation pass
   ─────────────────────────────────────────────────────────────────────────────
   Strategy
   ─────────
   1. Walk the AST to collect (var → [source exprs]) and the full operator set.
   2. Allocate one Register per variable.
      Add a Mux in front of any register that has more than one write site.
   3. Allocate one ALU per distinct operator that appears in any expression.
      ALUs are shared across all uses of the same operator (resource sharing).
   4. Allocate a Comparator for every variable that feeds a conditional.
   5. Allocate a Constant component for every distinct integer literal.
   6. Infer wiring between components from the assignment expressions.
   ───────────────────────────────────────────────────────────────────────────── *)

let allocate ast =
  let assignments = analyze_assignments ast in
  let operators   = collect_operators   ast in
  let cond_vars   = collect_condition_vars ast in

  (* ── Registers & Muxes ── *)
  let storage_components =
    List.concat_map (fun (var_name, sources) ->
      let reg  = { id = "Reg_" ^ var_name; kind = Register var_name } in
      if List.length sources > 1 then
        let mux = { id = "Mux_" ^ var_name; kind = Mux (List.length sources) } in
        [ reg; mux ]
      else
        [ reg ]
    ) assignments
  in

  (* ── ALUs: one per unique operator ── *)
  let alu_components =
    List.map (fun op ->
      { id = "ALU_" ^ string_of_op op; kind = ALU op }
    ) operators
  in

  (* ── Comparators: one per variable appearing in any condition ── *)
  let all_reg_vars = List.map fst assignments in
  let comparator_components =
    let unique_cond_vars =
      List.sort_uniq String.compare
        (List.filter (fun v -> List.mem v all_reg_vars) cond_vars)
    in
    List.map (fun v ->
      { id = "Cmp_" ^ v; kind = Comparator v }
    ) unique_cond_vars
  in

  (* ── Constants: one per distinct literal in the entire program ── *)
  let collect_constants block =
    let tbl = Hashtbl.create 8 in
    let rec walk_expr = function
      | Const i           -> Hashtbl.replace tbl i ()
      | Var _             -> ()
      | BinOp (_, e1, e2) -> walk_expr e1; walk_expr e2
    in
    let rec walk_stmts = function
      | []                       -> ()
      | Assign (_, e)  :: rest   -> walk_expr e; walk_stmts rest
      | If (c, tb, fb) :: rest   -> walk_expr c; walk_stmts tb; walk_stmts fb; walk_stmts rest
      | For (_, s, st, b) :: rest -> walk_expr s; walk_expr st; walk_stmts b; walk_stmts rest
      | While (c, b)   :: rest   -> walk_expr c; walk_stmts b; walk_stmts rest
      | Return e       :: rest   -> walk_expr e; walk_stmts rest
    in
    walk_stmts block;
    Hashtbl.fold (fun i () acc -> i :: acc) tbl []
  in
  let constant_components =
    List.map (fun i ->
      { id = Printf.sprintf "Const_%d" i; kind = Constant i }
    ) (collect_constants ast)
  in

  let components =
    storage_components @ alu_components @ comparator_components @ constant_components
  in

  (* ── Connections ── *)
  let raw_conns = infer_connections assignments in
  (* Deduplicate: same (src, dest) pair may appear from multiple analysis paths *)
  let connections =
    List.sort_uniq (fun a b ->
      let c = String.compare a.src b.src in
      if c <> 0 then c else String.compare a.dest b.dest
    ) raw_conns
  in

  { components; connections }

(* ─────────────────────────────────────────────────────────────────────────────
   Printer
   ───────────────────────────────────────────────────────────────────────────── *)

let print_datapath dp =
  Printf.printf "\n--- GENERATED DATAPATH (RTL STRUCTURE) ---\n";
  List.iter (fun c ->
    match c.kind with
    | Register v ->
        Printf.printf "  Register    [Reg_%-12s]  ← stores variable '%s'\n" v v
    | Mux n ->
        let var = String.sub c.id 4 (String.length c.id - 4) in
        Printf.printf "  Mux         [%-16s]  %d-to-1 selector → Reg_%s\n"
          c.id n var
    | ALU op ->
        Printf.printf "  ALU         [%-16s]  implements '%s'\n"
          c.id (string_of_op op)
    | Comparator v ->
        Printf.printf "  Comparator  [%-16s]  watches Reg_%s → status wire cmp_%s\n"
          c.id v v
    | Constant i ->
        Printf.printf "  Constant    [%-16s]  hardwired value %d\n" c.id i
  ) dp.components;
  if dp.connections <> [] then begin
    Printf.printf "\n  Connections:\n";
    List.iter (fun w ->
      Printf.printf "    %s → %s\n" w.src w.dest
    ) dp.connections
  end

(* ─────────────────────────────────────────────────────────────────────────────
   JSON serialisation  (consumed by export.ml and the React visualiser)
   ───────────────────────────────────────────────────────────────────────────── *)

let json_of_component c =
  match c.kind with
  | Register v ->
      Printf.sprintf
        {|{"id": "Reg_%s", "type": "Register", "label": "%s"}|} v v
  | Mux n ->
      let var = String.sub c.id 4 (String.length c.id - 4) in
      Printf.sprintf
        {|{"id": "%s", "type": "Mux", "inputs": %d, "target": "Reg_%s"}|}
        c.id n var
  | ALU op ->
      Printf.sprintf
        {|{"id": "ALU_%s", "type": "ALU", "operation": "%s"}|}
        (string_of_op op) (string_of_op op)
  | Comparator v ->
      Printf.sprintf
        {|{"id": "Cmp_%s", "type": "Comparator", "watches": "Reg_%s", "status_wire": "cmp_%s"}|}
        v v v
  | Constant i ->
      Printf.sprintf
        {|{"id": "Const_%d", "type": "Constant", "value": %d}|} i i

let json_of_connection w =
  Printf.sprintf {|{"src": "%s", "dest": "%s"}|} w.src w.dest
