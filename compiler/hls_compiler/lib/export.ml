(* lib/export.ml *)
open Datapath
open Fsm

(* Helper to convert Datapath components to JSON strings *)
let json_of_component c =
  match c.kind with
  | Register v -> 
      Printf.sprintf "{\"id\": \"Reg_%s\", \"type\": \"Register\", \"label\": \"%s\"}" v v
  | Mux inputs -> 
      let target_reg = String.sub c.id 4 (String.length c.id - 4) in
      Printf.sprintf "{\"id\": \"%s\", \"type\": \"Mux\", \"inputs\": %d, \"target\": \"Reg_%s\"}" 
        c.id (List.length inputs) target_reg
  | _ -> "{}" (* Skip unhandled components for now *)

(* Helper to convert FSM Actions to JSON *)
let json_of_action (Latch (v, e)) =
  Printf.sprintf "{\"type\": \"Latch\", \"target\": \"Reg_%s\", \"expression\": \"%s\"}" 
    v (Fsm.string_of_expr e)

(* Helper to convert FSM Transitions to JSON *)
let json_of_transition = function
  | Goto id -> 
      Printf.sprintf "{\"type\": \"Goto\", \"target_id\": %d}" id
  | Branch (cond, t, f) -> 
      Printf.sprintf "{\"type\": \"Branch\", \"condition\": \"%s\", \"true_id\": %d, \"false_id\": %d}" 
        (Fsm.string_of_expr cond) t f
  | Done -> 
      Printf.sprintf "{\"type\": \"Done\"}"

(* Convert a full FSM State to JSON *)
let json_of_state s =
  let actions_json = "[" ^ String.concat ", " (List.map json_of_action s.actions) ^ "]" in
  let next_json = json_of_transition s.next in
  Printf.sprintf "{\"id\": %d, \"actions\": %s, \"next\": %s}" s.id actions_json next_json

(* The main export function *)
let to_json datapath fsm =
  (* Filter out empty components and join with commas *)
  let valid_components = List.filter (fun c -> c <> "{}") (List.map json_of_component datapath.components) in
  let dp_json = "[\n    " ^ String.concat ",\n    " valid_components ^ "\n  ]" in
  
  let fsm_json = "[\n    " ^ String.concat ",\n    " (List.map json_of_state fsm) ^ "\n  ]" in
  
  Printf.sprintf "{\n  \"datapath\": %s,\n  \"fsm\": %s\n}" dp_json fsm_json