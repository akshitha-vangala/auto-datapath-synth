(* lib/synthesis.ml *)
open Ast

(* --- TYPES --- *)

type opt_mode = 
  | Performance            (* Prioritize Time: Infinite ALUs *)
  | Efficiency of int      (* Prioritize Hardware: Strict ALU limit per cycle *)

type config = {
  mode: opt_mode;
}

type scheduled_op = {
  cycle : int;
  target : string;
  expr : expr;
}

(* --- HELPER FUNCTIONS --- *)

(* Extracts all variable dependencies from an expression *)
let rec get_deps = function
  | Const _ -> []
  | Var v -> [v]
  | BinOp (_, e1, e2) -> (get_deps e1) @ (get_deps e2)

(* Checks if all dependencies of an expression are in the available list *)
(* Variables not defined in the program are assumed to be external inputs (always ready) *)
let is_ready expr avail_vars all_targets =
  let deps = get_deps expr in
  List.for_all (fun d -> 
    (List.mem d avail_vars) || not (List.mem d all_targets)
  ) deps

(* --- PERFORMANCE MODE (ASAP) --- *)

let get_cycle env var =
  match List.assoc_opt var env with
  | Some c -> c
  | None -> 0 (* Assume external inputs are ready at cycle 0 *)

let rec eval_cycle env = function
  | Const _ -> 0
  | Var v -> get_cycle env v
  | BinOp (_, e1, e2) ->
      let c1 = eval_cycle env e1 in
      let c2 = eval_cycle env e2 in
      max c1 c2 + 1

let schedule_asap prog =
  let rec walk env acc = function
    | [] -> List.rev acc
    | Assign (id, expr) :: rest ->
        let cycle = eval_cycle env expr in
        let new_env = (id, cycle) :: env in
        let op = { cycle; target = id; expr } in
        walk new_env (op :: acc) rest
    | (If _ | For _) :: _ -> 
        failwith "FSM logic not yet implemented for ASAP"
  in
  walk [] [] prog

(* --- EFFICIENCY MODE (List Scheduling) --- *)

let schedule_constrained limit prog =
  let all_targets = List.map (fun stmt -> 
    match stmt with
    | Assign (id, _) -> id
    | If _ | For _ -> failwith "FSM logic not yet implemented"
  ) prog in

  let rec step cycle avail pending acc =
    match pending with
    | [] -> List.rev acc
    | _ ->
        let ready, blocked = List.partition (fun stmt -> 
          match stmt with
          | Assign (_, expr) -> is_ready expr avail all_targets
          | If _ | For _ -> failwith "FSM logic not yet implemented"
        ) pending in
        
        if ready = [] then
          failwith "Scheduling deadlock: Unresolvable cyclic dependency detected."
        else
          
        let rec split_at n lst =
          match n, lst with
          | 0, _ | _, [] -> [], lst
          | n, x::xs -> 
              let l1, l2 = split_at (n-1) xs in 
              x::l1, l2
        in
        let to_schedule, pushed_back = split_at limit ready in
        let next_pending = pushed_back @ blocked in
        
        let new_ops = List.map (fun stmt -> 
          match stmt with
          | Assign (id, expr) -> { cycle; target = id; expr }
          | If _ | For _ -> failwith "FSM logic not yet implemented"
        ) to_schedule in
        
        let new_avail = avail @ (List.map (fun op -> op.target) new_ops) in
        
        step (cycle + 1) new_avail next_pending (new_ops @ acc)
  in
  step 1 [] prog []

(* --- MAIN ENTRY POINT --- *)

let schedule config prog =
  match config.mode with
  | Performance -> schedule_asap prog
  | Efficiency limit -> schedule_constrained limit prog


