(* lib/ast.ml *)

(* Expanded to include comparators for if-statements and loops *)
type op = 
  | Add  (* Maps to hardware Adder *)
  | Sub  (* Maps to hardware Subtractor *)
  | Mul  (* Maps to hardware Multiplier *)
  | Eq   (* Maps to Comparator (==) *)
  | Lt   (* Maps to Comparator (<) *)
  | Gt   (* Maps to Comparator (>) *)

type expr =
  | Var of string
  | Const of int
  | BinOp of op * expr * expr

(* A program block is a list of statements *)
type block = stmt list

and stmt = 
  | Assign of string * expr
  
  (* if (condition) { true_block } else { false_block } *)
  | If of expr * block * block 
  
  (* for (iterator = start; iterator < end) { loop_block } *)
  | For of string * expr * expr * block