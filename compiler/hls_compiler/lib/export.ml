(* lib/export.ml *)
open Datapath
open Fsm

(* ─────────────────────────────────────────────────────────────────────────────
   Datapath → JSON
   ─────────────────────────────────────────────────────────────────────────────
   Delegates to the canonical serialisers in [Datapath] so component JSON is
   always consistent between the terminal printer and the file output.
   ───────────────────────────────────────────────────────────────────────────── *)

(* ─────────────────────────────────────────────────────────────────────────────
   FSM → JSON
   ─────────────────────────────────────────────────────────────────────────────
   Each state exports:
     id       – integer state identifier
     label    – human-readable name (e.g. "LD_X", "WHILE_CHECK", "HALT")
     signals  – JSON object: {"Ld_X": 1, "ALU_Add": 1, ...}
                Signals absent from the list are implicitly 0 in the RTL.
     next     – transition descriptor (Goto / Branch / Done)

   Branch conditions export either:
     {"kind": "wire",  "wire": "cmp_<var>"}   – for Comparator status wires
     {"kind": "expr",  "expr": "<text>"}       – for generic expression labels
   ───────────────────────────────────────────────────────────────────────────── *)

let json_of_signals signals =
  if signals = [] then "{}"
  else begin
    let pairs =
      List.map (fun sg ->
        Printf.sprintf {|"%s": %d|} sg.name (if sg.value then 1 else 0)
      ) signals
    in
    "{" ^ String.concat ", " pairs ^ "}"
  end

let rec json_of_expr = function
  | Ast.Var v              -> v
  | Ast.Const i            -> string_of_int i
  | Ast.BinOp (op, e1, e2) ->
      let op_str = match op with
        | Ast.Add  -> "+"   | Ast.Sub  -> "-"   | Ast.Mul  -> "*"
        | Ast.Div  -> "/"   | Ast.Mod  -> "%"
        | Ast.Shl  -> "<<"  | Ast.Shr  -> ">>"  | Ast.Sar  -> ">>>"
        | Ast.BAnd -> "&"   | Ast.BOr  -> "|"   | Ast.BXor -> "^"
        | Ast.Eq   -> "=="  | Ast.NEq  -> "!="
        | Ast.Lt   -> "<"   | Ast.Lte  -> "<="
        | Ast.Gt   -> ">"   | Ast.Gte  -> ">="
      in
      Printf.sprintf "(%s %s %s)" (json_of_expr e1) op_str (json_of_expr e2)

let json_of_condition = function
  | CmpWire  w ->
      Printf.sprintf {|{"kind": "wire", "wire": "%s"}|} w
  | ExprCond e ->
      Printf.sprintf {|{"kind": "expr", "expr": "%s"}|} (json_of_expr e)

let json_of_transition = function
  | Goto id ->
      Printf.sprintf {|{"type": "Goto", "target_id": %d}|} id
  | Branch (cond, t, f) ->
      Printf.sprintf
        {|{"type": "Branch", "condition": %s, "true_id": %d, "false_id": %d}|}
        (json_of_condition cond) t f
  | Done ->
      {|{"type": "Done"}|}

let json_of_state s =
  Printf.sprintf
    {|{"id": %d, "label": "%s", "signals": %s, "next": %s}|}
    s.id
    s.label
    (json_of_signals s.signals)
    (json_of_transition s.next)

(* ─────────────────────────────────────────────────────────────────────────────
   Top-level export
   ─────────────────────────────────────────────────────────────────────────────
   Output schema:
     meta      – compiler provenance; algorithm field is intentionally absent
                 (the compiler is algorithm-agnostic)
     datapath  – array of component objects
     wires     – array of connection objects {src, dest}
     fsm       – array of state objects with RTL control-signal dicts
   ───────────────────────────────────────────────────────────────────────────── *)
let to_json datapath fsm =
  let dp_entries =
    List.map Datapath.json_of_component datapath.components
  in
  let dp_json =
    "[\n    " ^ String.concat ",\n    " dp_entries ^ "\n  ]"
  in

  let wire_entries =
    List.map Datapath.json_of_connection datapath.connections
  in
  let wire_json =
    if wire_entries = [] then "[]"
    else "[\n    " ^ String.concat ",\n    " wire_entries ^ "\n  ]"
  in

  let fsm_json =
    "[\n    " ^ String.concat ",\n    " (List.map json_of_state fsm) ^ "\n  ]"
  in

  (* Note: no "algorithm" field — the compiler is fully generic *)
  Printf.sprintf
    "{\n\
    \  \"meta\": {\n\
    \    \"compiler\": \"hls_compiler\",\n\
    \    \"version\": \"2.0\",\n\
    \    \"description\": \"Generic HLS datapath and FSM synthesis\"\n\
    \  },\n\
    \  \"datapath\": %s,\n\
    \  \"wires\": %s,\n\
    \  \"fsm\": %s\n\
    }"
    dp_json
    wire_json
    fsm_json
