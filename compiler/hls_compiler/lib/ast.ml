(* lib/ast.ml *)

(* ─────────────────────────────────────────────────────────────────────────────
   Generic Binary Operator set.
   Every entry maps directly to a canonical RTL primitive; no operator is tied
   to any particular algorithm or usage pattern.

   Arithmetic   : Add, Sub, Mul, Div, Mod
   Shift        : Shl (logical left), Shr (logical right), Sar (arithmetic right)
   Bitwise      : BAnd, BOr, BXor, BNot (unary — encoded as BinOp with dummy rhs)
   Comparison   : Eq, NEq, Lt, Lte, Gt, Gte   →  output is a 1-bit predicate
   ───────────────────────────────────────────────────────────────────────────── *)
type op =
  | Add                  (* +  → Adder unit            *)
  | Sub                  (* -  → Subtractor unit        *)
  | Mul                  (* *  → Multiplier unit        *)
  | Div                  (* /  → Divider unit           *)
  | Mod                  (* %  → Modulo / remainder     *)
  | Shl                  (* << → Left-shift unit        *)
  | Shr                  (* >> → Right-shift unit       *)
  | Sar                  (* >>> → Arithmetic right-shift *)
  | BAnd                 (* &  → Bitwise AND            *)
  | BOr                  (* |  → Bitwise OR             *)
  | BXor                 (* ^  → Bitwise XOR            *)
  | Eq                   (* == → Comparator (equal)     *)
  | NEq                  (* != → Comparator (not equal) *)
  | Lt                   (* <  → Comparator (less-than) *)
  | Lte                  (* <= → Comparator (≤)         *)
  | Gt                   (* >  → Comparator (greater)   *)
  | Gte                  (* >= → Comparator (≥)         *)

(* ─────────────────────────────────────────────────────────────────────────────
   Expression language — pure and side-effect-free.
   ───────────────────────────────────────────────────────────────────────────── *)
type expr =
  | Var    of string                  (* variable reference              *)
  | Const  of int                     (* integer literal                 *)
  | BinOp  of op * expr * expr        (* binary operator application     *)

(* ─────────────────────────────────────────────────────────────────────────────
   Statement / control-flow language.
   A program is a flat [block] (list of statements); control structures nest
   by embedding sub-blocks.
   ───────────────────────────────────────────────────────────────────────────── *)
type block = stmt list

and stmt =
  | Assign of string * expr                        (* id = expr;                        *)
  | If     of expr * block * block                 (* if (cond) { … } else { … }        *)
  | For    of string * expr * expr * block         (* for (id = start; id < stop) { … } *)
  | While  of expr * block                         (* while (cond) { … }                *)
  | Return of expr                                  (* return expr;  (optional)          *)
