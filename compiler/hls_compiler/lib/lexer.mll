(* lib/lexer.mll *)
{
  open Parser
  exception SyntaxError of string
}

let white   = [' ' '\t']+
let newline = '\r' | '\n' | "\r\n"
let id      = ['a'-'z' 'A'-'Z' '_'] ['a'-'z' 'A'-'Z' '0'-'9' '_']*
let int     = ['0'-'9']+

rule read = parse
  | white    { read lexbuf }
  | newline  { Lexing.new_line lexbuf; read lexbuf }
  (* single-line comments *)
  | "//" [^ '\n']* { read lexbuf }

  (* Keywords — must precede the generic [id] rule *)
  | "if"     { IF }
  | "else"   { ELSE }
  | "for"    { FOR }
  | "while"  { WHILE }
  | "return" { RETURN }

  | int      { INT (int_of_string (Lexing.lexeme lexbuf)) }
  | id       { IDENT (Lexing.lexeme lexbuf) }

  (* Multi-char operators must appear before their single-char prefixes *)
  | "=="     { EQEQ }
  | "!="     { NEQ }
  | "<="     { LTE }
  | ">="     { GTE }
  | ">>"     { SHR }
  | ">>>"    { SAR }
  | "<<"     { SHL }
  | "<"      { LT }
  | ">"      { GT }
  | "="      { EQUALS }
  | "&&"     { BAND }
  | "||"     { BOR }
  | "^"      { BXOR }
  | "&"      { AMP }
  | "|"      { PIPE }

  (* Arithmetic *)
  | "+"      { PLUS }
  | "-"      { MINUS }
  | "*"      { STAR }
  | "/"      { SLASH }
  | "%"      { PERCENT }

  (* Punctuation *)
  | ";"      { SEMICOLON }
  | "("      { LPAREN }
  | ")"      { RPAREN }
  | "{"      { LBRACE }
  | "}"      { RBRACE }

  | eof      { EOF }
  | _        { raise (SyntaxError ("Unexpected character: '" ^ Lexing.lexeme lexbuf ^ "'")) }
