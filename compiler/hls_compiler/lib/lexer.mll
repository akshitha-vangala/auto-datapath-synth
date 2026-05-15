(* lib/lexer.mll *)
{
  open Parser
  exception SyntaxError of string
}

let white = [' ' '\t']+
let newline = '\r' | '\n' | "\r\n"
let id = ['a'-'z' 'A'-'Z' '_'] ['a'-'z' 'A'-'Z' '0'-'9' '_']*
let int = ['0'-'9']+

rule read = parse
  | white    { read lexbuf }
  | newline  { Lexing.new_line lexbuf; read lexbuf }
  
  (* Keywords must come BEFORE the 'id' rule *)
  | "if"     { IF }
  | "else"   { ELSE }
  | "for"    { FOR }
  | "while"  { WHILE }
  
  | int      { INT (int_of_string (Lexing.lexeme lexbuf)) }
  | id       { IDENT (Lexing.lexeme lexbuf) }
  
  (* Multi-character operators MUST be matched before single-char prefixes.
     ">>" must be tried before ">", "==" must be tried before "=". *)
  | "=="     { EQ }
  | ">>"     { SHR }
  | "<"      { LT }
  | ">"      { GT }
  | "="      { EQUALS }
  
  (* Math & Logic *)
  | "+"      { PLUS }
  | "-"      { MINUS }
  | "*"      { STAR }
  | "%"      { PERCENT }
  
  (* Syntax & Brackets *)
  | ";"      { SEMICOLON }
  | "("      { LPAREN }
  | ")"      { RPAREN }
  | "{"      { LBRACE }
  | "}"      { RBRACE }
  
  | eof      { EOF }
  | _        { raise (SyntaxError ("Unexpected char: " ^ Lexing.lexeme lexbuf)) }
