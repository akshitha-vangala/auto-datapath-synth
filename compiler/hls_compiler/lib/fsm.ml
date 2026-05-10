(* lib/fsm.ml *)
open Ast

(* --- FSM DATA TYPES --- *)
type state_id = int

type action =
  | Latch of string * expr

type transition =
  | Goto of state_id
  | Branch of expr * state_id * state_id  (* condition, true_state, false_state *)
  | Done

type state = {
  id : state_id;
  actions : action list;
  next : transition;
}

(* --- FSM GENERATOR --- *)
let state_counter = ref 0

let new_state () =
  let id = !state_counter in
  incr state_counter;
  id

(* Compiles a list of AST statements into a flat list of hardware states *)
let rec compile_block stmts start_id exit_id =
  match stmts with
  | [] -> 
      [{ id = start_id; actions = []; next = Goto exit_id }]
  
  | Assign (var, expr) :: rest ->
      let next_id = if rest = [] then exit_id else new_state () in
      let current_state = { id = start_id; actions = [Latch (var, expr)]; next = Goto next_id } in
      let rest_states = if rest = [] then [] else compile_block rest next_id exit_id in
      current_state :: rest_states

  | If (cond, true_block, false_block) :: rest ->
      let true_start = new_state () in
      let false_start = new_state () in
      let merge_id = if rest = [] then exit_id else new_state () in
      
      let current_state = { id = start_id; actions = []; next = Branch (cond, true_start, false_start) } in
      
      let true_states = compile_block true_block true_start merge_id in
      let false_states = compile_block false_block false_start merge_id in
      let rest_states = if rest = [] then [] else compile_block rest merge_id exit_id in
      
      (current_state :: true_states) @ false_states @ rest_states

  | For (var, start_val, stop_val, body) :: rest ->
      (* Hardware translation of a For loop requires 4 distinct states *)
      let check_id = new_state () in
      let body_start = new_state () in
      let inc_id = new_state () in
      let merge_id = if rest = [] then exit_id else new_state () in

      (* 1. INIT: Latch the start value *)
      let init_state = { id = start_id; actions = [Latch (var, start_val)]; next = Goto check_id } in
      
      (* 2. CHECK: Evaluate the comparator *)
      let cond = BinOp (Lt, Var var, stop_val) in
      let check_state = { id = check_id; actions = []; next = Branch (cond, body_start, merge_id) } in
      
      (* 3. BODY: Execute the inner loop code *)
      let body_states = compile_block body body_start inc_id in
      
      (* 4. INCREMENT: Add 1 to the iterator and loop back to check *)
      let inc_expr = BinOp (Add, Var var, Const 1) in
      let inc_state = { id = inc_id; actions = [Latch (var, inc_expr)]; next = Goto check_id } in
      
      let rest_states = if rest = [] then [] else compile_block rest merge_id exit_id in

      [init_state; check_state] @ body_states @ [inc_state] @ rest_states

let generate ast =
  state_counter := 0; (* Reset counter on new generation *)
  let start_id = new_state () in
  let exit_id = new_state () in
  let states = compile_block ast start_id exit_id in
  let final_state = { id = exit_id; actions = []; next = Done } in
  states @ [final_state]

(* --- FSM PRINTER --- *)
let rec string_of_expr = function
  | Ast.Var v -> v
  | Ast.Const i -> string_of_int i
  | Ast.BinOp (Ast.Add, e1, e2) -> string_of_expr e1 ^ " + " ^ string_of_expr e2
  | Ast.BinOp (Ast.Sub, e1, e2) -> string_of_expr e1 ^ " - " ^ string_of_expr e2
  | Ast.BinOp (Ast.Mul, e1, e2) -> string_of_expr e1 ^ " * " ^ string_of_expr e2
  | Ast.BinOp (Ast.Eq, e1, e2) -> string_of_expr e1 ^ " == " ^ string_of_expr e2
  | Ast.BinOp (Ast.Lt, e1, e2) -> string_of_expr e1 ^ " < " ^ string_of_expr e2
  | Ast.BinOp (Ast.Gt, e1, e2) -> string_of_expr e1 ^ " > " ^ string_of_expr e2

let print_fsm states =
  Printf.printf "\n--- GENERATED CONTROL PATH (FSM) ---\n";
  List.iter (fun s ->
    Printf.printf "State %d:\n" s.id;
    List.iter (fun (Latch (v, e)) -> Printf.printf "  [Datapath] %s = %s\n" v (string_of_expr e)) s.actions;
    match s.next with
    | Goto id -> Printf.printf "  [Control]  Goto State %d\n" id
    | Branch (cond, t, f) -> Printf.printf "  [Control]  If (%s) Goto %d Else Goto %d\n" (string_of_expr cond) t f
    | Done -> Printf.printf "  [Control]  HALT (Execution Complete)\n"
  ) states