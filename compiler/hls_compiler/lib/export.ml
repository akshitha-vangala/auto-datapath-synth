(* lib/export.ml *)
open Datapath
open Fsm

(* ---------------------------------------------------------------------------
   Datapath → JSON
   ---------------------------------------------------------------------------
   Delegates to the canonical serialiser in Datapath so component JSON is
   always consistent between the terminal printer and the file output.
   We filter nothing: every allocated component is exported.
   --------------------------------------------------------------------------- *)
let json_of_dp_component = Datapath.json_of_component

(* ---------------------------------------------------------------------------
   FSM → JSON
   ---------------------------------------------------------------------------
   Each state exports:
     id       – integer state identifier
     label    – human-readable name (e.g. "INIT_R", "WHILE_CHECK")
     signals  – JSON object: { "Ld_R": 1, "ALU_Mul": 1, ... }
                Signals absent from the list are implicitly 0 in the RTL.
     next     – transition descriptor (Goto / Branch / Done)

   Branch conditions export the hardware wire name directly so the React
   visualiser can look up the wire in the datapath without re-parsing math.
   --------------------------------------------------------------------------- *)

(* Serialise the signals dict as a compact JSON object.
   Absent signals are omitted (implicitly 0); present signals carry value 1. *)
let json_of_signals signals =
  if signals = [] then
    "{}"
  else begin
    let pairs =
      List.map (fun sg ->
        Printf.sprintf {|"%s": %d|} sg.name (if sg.value then 1 else 0)
      ) signals
    in
    "{" ^ String.concat ", " pairs ^ "}"
  end

(* Serialise a branch condition.
   WireHigh names map directly to Comparator status wires in the datapath.
   ExprCond is serialised as a plain string for For-loop bounds (numeric). *)
let json_of_condition = function
  | WireHigh w ->
      Printf.sprintf {|{"kind": "wire", "wire": "%s"}|} w
  | ExprCond e ->
      let rec s = function
        | Ast.Var v        -> v
        | Ast.Const i      -> string_of_int i
        | Ast.BinOp (Ast.Add, a, b) -> s a ^ " + " ^ s b
        | Ast.BinOp (Ast.Sub, a, b) -> s a ^ " - " ^ s b
        | Ast.BinOp (Ast.Mul, a, b) -> s a ^ " * " ^ s b
        | Ast.BinOp (Ast.Mod, a, b) -> s a ^ " % " ^ s b
        | Ast.BinOp (Ast.Shr, a, b) -> s a ^ " >> " ^ s b
        | Ast.BinOp (Ast.Eq,  a, b) -> s a ^ " == " ^ s b
        | Ast.BinOp (Ast.Lt,  a, b) -> s a ^ " < "  ^ s b
        | Ast.BinOp (Ast.Gt,  a, b) -> s a ^ " > "  ^ s b
      in
      Printf.sprintf {|{"kind": "expr", "expr": "%s"}|} (s e)

let json_of_transition = function
  | Goto id ->
      Printf.sprintf {|{"type": "Goto", "target_id": %d}|} id
  | Branch (cond, t, f) ->
      Printf.sprintf {|{"type": "Branch", "condition": %s, "true_id": %d, "false_id": %d}|}
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

(* ---------------------------------------------------------------------------
   Top-level export
   --------------------------------------------------------------------------- *)
let to_json datapath fsm =
  let dp_entries =
    List.map json_of_dp_component datapath.components
  in
  let dp_json =
    "[\n    " ^ String.concat ",\n    " dp_entries ^ "\n  ]"
  in

  let fsm_json =
    "[\n    " ^ String.concat ",\n    " (List.map json_of_state fsm) ^ "\n  ]"
  in

  (* Top-level schema:
       datapath – array of component objects (Register, ShiftRegister, Mux,
                  ALU, Comparator, Constant)
       fsm      – array of state objects with RTL control-signal dicts
       meta     – compiler provenance for the React visualiser header *)
  Printf.sprintf
    "{\n  \"meta\": {\"compiler\": \"hls_compiler\", \"algorithm\": \"square_and_multiply\"},\n  \"datapath\": %s,\n  \"fsm\": %s\n}"
    dp_json
    fsm_json