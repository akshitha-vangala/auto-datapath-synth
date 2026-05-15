/* lib/parser.mly */
%{
  open Ast
%}

%token <int> INT
%token <string> IDENT
%token PLUS MINUS STAR PERCENT
%token EQ LT GT SHR
%token EQUALS SEMICOLON
%token LPAREN RPAREN LBRACE RBRACE
%token IF ELSE FOR WHILE
%token EOF

/* Operator precedence — lowest to highest.
   Comparisons bind most loosely, then additive, then multiplicative,
   then shift, then modulo (same level as MUL in most languages). *)
%left EQ LT GT
%left PLUS MINUS
%left STAR PERCENT
%left SHR

%start <Ast.block> prog

%%

prog:
  | stmts = list(stmt); EOF { stmts }
  ;

/* A block is a list of statements wrapped in curly braces */
block:
  | LBRACE; stmts = list(stmt); RBRACE { stmts }
  ;

stmt:
  | id = IDENT; EQUALS; e = expr; SEMICOLON
      { Assign (id, e) }

  /* if/else — both branches are required to keep the grammar unambiguous */
  | IF; LPAREN; cond = expr; RPAREN; true_b = block; ELSE; false_b = block
      { If (cond, true_b, false_b) }

  /* if without else — synthesised as If(cond, true_b, []) */
  | IF; LPAREN; cond = expr; RPAREN; true_b = block
      { If (cond, true_b, []) }

  /* for (id = start; id < end) { ... } */
  | FOR; LPAREN; id = IDENT; EQUALS; start_val = expr; SEMICOLON;
         IDENT; LT; end_val = expr; RPAREN; b = block
      { For (id, start_val, end_val, b) }

  /* while (cond) { ... } */
  | WHILE; LPAREN; cond = expr; RPAREN; b = block
      { While (cond, b) }
  ;

expr:
  | i = INT                            { Const i }
  | id = IDENT                         { Var id }
  | e1 = expr; PLUS;    e2 = expr      { BinOp (Add, e1, e2) }
  | e1 = expr; MINUS;   e2 = expr      { BinOp (Sub, e1, e2) }
  | e1 = expr; STAR;    e2 = expr      { BinOp (Mul, e1, e2) }
  | e1 = expr; PERCENT; e2 = expr      { BinOp (Mod, e1, e2) }
  | e1 = expr; SHR;     e2 = expr      { BinOp (Shr, e1, e2) }
  | e1 = expr; EQ;      e2 = expr      { BinOp (Eq,  e1, e2) }
  | e1 = expr; LT;      e2 = expr      { BinOp (Lt,  e1, e2) }
  | e1 = expr; GT;      e2 = expr      { BinOp (Gt,  e1, e2) }
  | LPAREN; e = expr; RPAREN           { e }
  ;
