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

let () =
  Printf.printf "--- READING FROM input.txt ---\n";
  
  (* 1. Open the file created by the Node.js API *)
  let in_channel = open_in "input.txt" in
  
  (* 2. Tell the lexer to read from this file *)
  let lexbuf = Lexing.from_channel in_channel in
  
  try
    let ast = Parser.prog Lexer.read lexbuf in
    
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
    
    (* 4. Close the input file *)
    close_in in_channel;
    
    Printf.printf "\n[SUCCESS] Hardware synthesized and exported to output.json!\n";

  with
  | Lexer.SyntaxError msg -> 
      close_in_noerr in_channel; (* Make sure file closes even on error *)
      Printf.printf "Lexer Error: %s\n" msg
  | Parser.Error -> 
      close_in_noerr in_channel;
      Printf.printf "Parser Error near character %d\n" (Lexing.lexeme_start lexbuf)
  | e -> 
      close_in_noerr in_channel;
      raise e