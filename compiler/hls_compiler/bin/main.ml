(* bin/main.ml *)
open Hls_compiler

let rec string_of_expr = function
  | Ast.Var v -> "Var(\"" ^ v ^ "\")"
  | Ast.Const i -> "Const(" ^ string_of_int i ^ ")"
  | Ast.BinOp (Ast.Add, e1, e2) -> "BinOp(Add, " ^ string_of_expr e1 ^ ", " ^ string_of_expr e2 ^ ")"
  | Ast.BinOp (Ast.Sub, e1, e2) -> "BinOp(Sub, " ^ string_of_expr e1 ^ ", " ^ string_of_expr e2 ^ ")"
  | Ast.BinOp (Ast.Mul, e1, e2) -> "BinOp(Mul, " ^ string_of_expr e1 ^ ", " ^ string_of_expr e2 ^ ")"
  | Ast.BinOp (Ast.Eq, e1, e2) -> "BinOp(Eq, " ^ string_of_expr e1 ^ ", " ^ string_of_expr e2 ^ ")"
  | Ast.BinOp (Ast.Lt, e1, e2) -> "BinOp(Lt, " ^ string_of_expr e1 ^ ", " ^ string_of_expr e2 ^ ")"
  | Ast.BinOp (Ast.Gt, e1, e2) -> "BinOp(Gt, " ^ string_of_expr e1 ^ ", " ^ string_of_expr e2 ^ ")"
  | Ast.BinOp (Ast.Shr, e1, e2) -> "BinOp(Shr, " ^ string_of_expr e1 ^ ", " ^ string_of_expr e2 ^ ")"
  | Ast.BinOp (Ast.Mod, e1, e2) -> "BinOp(Mod, " ^ string_of_expr e1 ^ ", " ^ string_of_expr e2 ^ ")"

let rec string_of_stmt = function
  | Ast.Assign (id, expr) -> "Assign(\"" ^ id ^ "\", " ^ string_of_expr expr ^ ")"
  | Ast.If (cond, tb, fb) -> "If(" ^ string_of_expr cond ^ ", " ^ string_of_block tb ^ ", " ^ string_of_block fb ^ ")"
  | Ast.For (id, start, stop, blk) -> "For(\"" ^ id ^ "\", " ^ string_of_expr start ^ ", " ^ string_of_expr stop ^ ", " ^ string_of_block blk ^ ")"
  | Ast.While (cond, blk) -> "While(" ^ string_of_expr cond ^ ", " ^ string_of_block blk ^ ")"
and string_of_block blk =
  "[\n    " ^ String.concat "\n    " (List.map string_of_stmt blk) ^ "\n  ]"

let string_of_program prog = string_of_block prog

(* Temporarily commented out until FSM synthesis is ready!
let print_schedule title scheduled =
  Printf.printf "\n--- %s ---\n" title;
  List.iter (fun op ->
    Printf.printf "Cycle %d: Latch Register '%s' = %s\n" 
      op.Synthesis.cycle 
      op.Synthesis.target 
      (string_of_expr op.Synthesis.expr)
  ) scheduled
*)

let () =
  let input = "
    r = 1;
    b = x;
    e = n;
    for (i = 0; i < 8) {
        r = r * b;
        b = b * b;
    }
  " in
  Printf.printf "--- INPUT CODE ---\n%s\n" input;
  
  let lexbuf = Lexing.from_string input in
  try
    let ast = Parser.prog Lexer.read lexbuf in
    
    (* Let's print the AST so string_of_program is used! *)
    Printf.printf "--- GENERATED AST ---\n%s\n" (string_of_program ast);
    
    (* 1. Allocate physical Hardware *)
    let hardware_datapath = Datapath.allocate ast in
    Datapath.print_datapath hardware_datapath;

    (* 2. Generate Control Path *)
    let hardware_fsm = Fsm.generate ast in
    Fsm.print_fsm hardware_fsm;

    (* 3. Export to JSON for the React Visualizer *)
    let json_output = Export.to_json hardware_datapath hardware_fsm in
    
    (* Write to file *)
    let oc = open_out "output.json" in
    Printf.fprintf oc "%s\n" json_output;
    close_out oc;
    
    Printf.printf "\n[SUCCESS] Hardware synthesized and exported to output.json!\n";

  with
  | Lexer.SyntaxError msg -> Printf.printf "Lexer Error: %s\n" msg
  | Parser.Error -> Printf.printf "Parser Error near character %d\n" (Lexing.lexeme_start lexbuf)