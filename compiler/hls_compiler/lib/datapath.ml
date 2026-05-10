(* lib/datapath.ml *)
open Ast

(* Physical hardware components *)
type component_type = 
  | Register of string       (* A storage element *)
  | Mux of string list       (* A N-to-1 selector *)
  | ALU of op                (* A mathematical unit *)
  | Constant of int          (* A hardwired value *)

type component = {
  id : string;
  kind : component_type;
}

(* A wire connecting two components *)
type connection = {
  src : string;
  dest : string;
}

type t = {
  components : component list;
  connections : connection list;
}

(* Helper: Find all unique variables and their assignment sources *)
let analyze_assignments block =
  let rec walk acc = function
    | [] -> acc
    | Assign (id, expr) :: rest ->
        let existing_sources = match List.assoc_opt id acc with Some s -> s | None -> [] in
        let new_acc = (id, expr :: existing_sources) :: (List.remove_assoc id acc) in
        walk new_acc rest
    | If (_, tb, fb) :: rest ->
        walk (walk (walk acc tb) fb) rest
    | For (_, _, _, body) :: rest ->
        walk (walk acc body) rest
  in
  walk [] block

(* The core Allocation & Binding algorithm *)
let allocate ast =
  let assignments = analyze_assignments ast in
  
  (* Generate components *)
  let components = List.fold_left (fun acc (var_name, sources) ->
    let reg = { id = "Reg_" ^ var_name; kind = Register var_name } in
    if List.length sources > 1 then
      (* If multiple sources, we MUST have a Mux *)
      let mux = { id = "Mux_" ^ var_name; kind = Mux (List.init (List.length sources) (fun i -> "in" ^ string_of_int i)) } in
      reg :: mux :: acc
    else
      reg :: acc
  ) [] assignments in

  { components; connections = [] (* Connections will be derived during FSM mapping *) }

let print_datapath dp =
  Printf.printf "\n--- GENERATED DATAPATH (RTL STRUCTURE) ---\n";
  List.iter (fun c ->
    match c.kind with
    | Register v -> Printf.printf "Component: Register [%s]\n" v
    | Mux inputs -> Printf.printf "Component: %d-to-1 Mux [Targeting Reg_%s]\n" (List.length inputs) (String.sub c.id 4 (String.length c.id - 4))
    | _ -> ()
  ) dp.components