/* lib/parser.mly */
%{
  open Ast
%}

%token <int> INT
%token <string> IDENT
%token PLUS MINUS STAR
%token EQ LT GT
%token EQUALS SEMICOLON
%token LPAREN RPAREN LBRACE RBRACE
%token IF ELSE FOR
%token EOF

/* Precedence: comparisons are evaluated after math */
%left EQ LT GT
%left PLUS MINUS
%left STAR

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
  | id = IDENT; EQUALS; e = expr; SEMICOLON { Assign (id, e) }
  
  | IF; LPAREN; cond = expr; RPAREN; true_b = block; ELSE; false_b = block 
      { If (cond, true_b, false_b) }
      
  /* Removed 'id_cond =' and just left 'IDENT' */
  | FOR; LPAREN; id = IDENT; EQUALS; start_val = expr; SEMICOLON; IDENT; LT; end_val = expr; RPAREN; b = block
      { For (id, start_val, end_val, b) }
  ;

expr:
  | i = INT { Const i }
  | id = IDENT { Var id }
  | e1 = expr; PLUS; e2 = expr { BinOp (Add, e1, e2) }
  | e1 = expr; MINUS; e2 = expr { BinOp (Sub, e1, e2) }
  | e1 = expr; STAR; e2 = expr { BinOp (Mul, e1, e2) }
  | e1 = expr; EQ; e2 = expr { BinOp (Eq, e1, e2) }
  | e1 = expr; LT; e2 = expr { BinOp (Lt, e1, e2) }
  | e1 = expr; GT; e2 = expr { BinOp (Gt, e1, e2) }
  ;