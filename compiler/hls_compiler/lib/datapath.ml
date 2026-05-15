(* lib/datapath.ml *)
open Ast

(* ---------------------------------------------------------------------------
   Physical RTL component taxonomy
   ---------------------------------------------------------------------------
   Register v        – standard D flip-flop bank storing variable [v]
   ShiftRegister v   – register whose primary write path is a right-shift
                       operation; maps to an SREG primitive in the backend
   Mux inputs        – N-to-1 data-selector feeding a register or ALU input
   ALU op            – combinational arithmetic / logic unit for [op]
   Comparator id     – dedicated comparator exposing named status wires;
                       [id] is the variable it watches (e.g. "e")
   Constant i        – hardwired literal value
   --------------------------------------------------------------------------- *)
type component_type =
  | Register      of string        (* variable name *)
  | ShiftRegister of string        (* variable name – written via Shr *)
  | Mux           of string list   (* list of logical input port names *)
  | ALU           of op            (* operation this unit implements *)
  | Comparator    of string        (* variable whose value is inspected *)
  | Constant      of int

type component = {
  id   : string;
  kind : component_type;
}

(* A directed wire between two component ports *)
type connection = {
  src  : string;
  dest : string;
}

type t = {
  components  : component list;
  connections : connection list;
}

(* ---------------------------------------------------------------------------
   AST analysis helpers
   --------------------------------------------------------------------------- *)

(* Return true iff the top-level operation of [expr] is a right-shift.
   We inspect only the outermost node; nested shifts still store their
   *result* in a normal register (the shift ALU is a separate component). *)
let expr_is_shr = function
  | BinOp (Shr, _, _) -> true
  | _                 -> false

(* Collect (variable_name, expr list) for every assignment in the program,
   including those nested inside If / For / While blocks. *)
let analyze_assignments block =
  let rec walk acc = function
    | [] -> acc
    | Assign (id, expr) :: rest ->
        let existing =
          match List.assoc_opt id acc with Some s -> s | None -> []
        in
        let acc' = (id, expr :: existing) :: List.remove_assoc id acc in
        walk acc' rest
    | If (_, tb, fb) :: rest ->
        walk (walk (walk acc tb) fb) rest
    | For (_, _, _, body) :: rest ->
        walk (walk acc body) rest
    | While (_, body) :: rest ->
        walk (walk acc body) rest
  in
  walk [] block

(* Decide whether a variable ever appears on the RHS of a shift that writes
   to *itself* – i.e. [e = e >> 1].  We do this by checking whether any of
   its source expressions is a Shr node. *)
let any_source_is_shr sources = List.exists expr_is_shr sources

(* ---------------------------------------------------------------------------
   Comparator inference
   ---------------------------------------------------------------------------
   For the Square-and-Multiply algorithm we always need a comparator on the
   exponent variable.  We detect the "exponent" heuristically: it is the
   variable that is (a) written by a Shr operation and (b) appears in a
   branch condition using Gt / Lt / Eq.
   
   For generality we collect every variable that feeds a comparison anywhere
   in the program; we then intersect with shift-register candidates. *)
let collect_compared_vars block =
  let rec walk_expr acc = function
    | BinOp ((Eq | Lt | Gt), Var v, _) -> v :: acc
    | BinOp ((Eq | Lt | Gt), _, Var v) -> v :: acc
    | BinOp (_, e1, e2) -> walk_expr (walk_expr acc e1) e2
    | _ -> acc
  in
  let rec walk_stmts acc = function
    | [] -> acc
    | Assign (_, e) :: rest           -> walk_stmts (walk_expr acc e) rest
    | If (cond, tb, fb) :: rest       ->
        let acc' = walk_expr acc cond in
        walk_stmts (walk_stmts (walk_stmts acc' tb) fb) rest
    | For (_, s, stop, body) :: rest  ->
        let acc' = walk_expr (walk_expr acc s) stop in
        walk_stmts (walk_stmts acc' body) rest
    | While (cond, body) :: rest      ->
        let acc' = walk_expr acc cond in
        walk_stmts (walk_stmts acc' body) rest
  in
  walk_stmts [] block

(* ---------------------------------------------------------------------------
   Core allocation pass
   ---------------------------------------------------------------------------
   Strategy
   --------
   1.  Walk the AST once to collect all (var -> [source exprs]) pairs.
   2.  For each variable decide its storage component type:
         – ShiftRegister  if any write to it is a Shr expression
         – Register       otherwise
       If a variable has >1 distinct write sites a Mux is added in front.
   3.  For every variable that is BOTH a ShiftRegister AND appears in a
       comparison, allocate a shared Comparator component.  The comparator
       exposes two status wires:
         eqz    – high when the variable equals zero  (controls loop exit)
         is_odd – high when LSB is 1                  (controls if-branch)
   --------------------------------------------------------------------------- *)
let allocate ast =
  let assignments     = analyze_assignments ast in
  let compared        = collect_compared_vars ast in

  (* Pass 1 – storage + mux components *)
  let storage_components =
    List.fold_left (fun acc (var_name, sources) ->
      let needs_mux   = List.length sources > 1 in
      let is_shift    = any_source_is_shr sources in

      (* Primary storage element *)
      let store_kind  =
        if is_shift then ShiftRegister var_name
        else             Register      var_name
      in
      let store_id    = (if is_shift then "SReg_" else "Reg_") ^ var_name in
      let store_comp  = { id = store_id; kind = store_kind } in

      if needs_mux then
        let port_names = List.init (List.length sources)
                           (fun i -> "in" ^ string_of_int i) in
        let mux_comp = { id = "Mux_" ^ var_name;
                         kind = Mux port_names } in
        store_comp :: mux_comp :: acc
      else
        store_comp :: acc
    ) [] assignments
  in

  (* Pass 2 – comparator components.
     Emit one Comparator per variable that is a shift-register AND feeds a
     comparison.  In Square-and-Multiply this will be exactly 'e'. *)
  let shift_vars =
    List.filter_map (fun (var_name, sources) ->
      if any_source_is_shr sources then Some var_name else None
    ) assignments
  in
  let comparator_components =
    List.filter_map (fun var_name ->
      if List.mem var_name compared then
        Some { id = "Cmp_" ^ var_name; kind = Comparator var_name }
      else
        None
    ) shift_vars
  in

  let components = storage_components @ comparator_components in
  { components; connections = [] }

(* ---------------------------------------------------------------------------
   Printer
   --------------------------------------------------------------------------- *)
let string_of_op = function
  | Add -> "Add" | Sub -> "Sub" | Mul -> "Mul"
  | Eq  -> "Eq"  | Lt  -> "Lt"  | Gt  -> "Gt"
  | Shr -> "Shr" | Mod -> "Mod"

let print_datapath dp =
  Printf.printf "\n--- GENERATED DATAPATH (RTL STRUCTURE) ---\n";
  List.iter (fun c ->
    match c.kind with
    | Register v ->
        Printf.printf "Component: Register        [%s]\n" v
    | ShiftRegister v ->
        Printf.printf "Component: ShiftRegister   [%s]  (driven by >> unit)\n" v
    | Mux inputs ->
        (* Strip leading prefix before the first '_' to recover var name *)
        let after_first_underscore s =
          match String.index_opt s '_' with
          | Some i -> String.sub s (i + 1) (String.length s - i - 1)
          | None   -> s
        in
        Printf.printf "Component: %d-to-1 Mux     [Targeting %s]\n"
          (List.length inputs) (after_first_underscore c.id)
    | ALU op ->
        Printf.printf "Component: ALU             [%s]\n" (string_of_op op)
    | Comparator v ->
        Printf.printf
          "Component: Comparator      [watching %s] \
           (status wires: eqz => loop-exit, is_odd => if-branch)\n" v
    | Constant i ->
        Printf.printf "Component: Constant        [%d]\n" i
  ) dp.components

(* ---------------------------------------------------------------------------
   JSON serialisation helper (used by export.ml)
   --------------------------------------------------------------------------- *)
let json_of_component c =
  match c.kind with
  | Register v ->
      Printf.sprintf
        {|{"id": "Reg_%s", "type": "Register", "label": "%s"}|} v v
  | ShiftRegister v ->
      Printf.sprintf
        {|{"id": "SReg_%s", "type": "ShiftRegister", "label": "%s (>>)"}|} v v
  | Mux inputs ->
      (* recover the target variable name from the component id "Mux_<var>" *)
      let var_name =
        let pfx = "Mux_" in
        let plen = String.length pfx in
        if String.length c.id > plen then
          String.sub c.id plen (String.length c.id - plen)
        else c.id
      in
      (* decide whether the target is a ShiftRegister by looking at id prefix *)
      let target_id = "Reg_" ^ var_name in
      Printf.sprintf
        {|{"id": "%s", "type": "Mux", "inputs": %d, "target": "%s"}|}
        c.id (List.length inputs) target_id
  | ALU op ->
      Printf.sprintf
        {|{"id": "ALU_%s", "type": "ALU", "operation": "%s"}|}
        (string_of_op op) (string_of_op op)
  | Comparator v ->
      Printf.sprintf
        {|{"id": "Cmp_%s", "type": "Comparator", "watches": "%s", |}
        v v
      ^ {|"status_wires": ["eqz", "is_odd"]}|}
  | Constant i ->
      Printf.sprintf
        {|{"id": "Const_%d", "type": "Constant", "value": %d}|} i i