/* lib/parser.mly */
%{
  open Ast
%}

/* ── Literals & identifiers ── */
%token <int>    INT
%token <string> IDENT

/* ── Arithmetic operators ── */
%token PLUS MINUS STAR SLASH PERCENT

/* ── Shift operators ── */
%token SHL SHR SAR

/* ── Bitwise operators ── */
%token AMP PIPE BXOR

/* ── Comparison operators ── */
%token EQEQ NEQ LT LTE GT GTE

/* ── Logical operators ── */
%token BAND BOR

/* ── Assignment & punctuation ── */
%token EQUALS SEMICOLON
%token LPAREN RPAREN LBRACE RBRACE

/* ── Keywords ── */
%token IF ELSE FOR WHILE RETURN

%token EOF

/* ── Operator precedence (lowest → highest) ──────────────────────────────
   Mirrors C/Java precedence so user programs behave as expected.
   All operators are left-associative unless noted.              ─────────── */
%left  BOR                                  /* ||  */
%left  BAND                                 /* &&  */
%left  PIPE                                 /* |   */
%left  BXOR                                 /* ^   */
%left  AMP                                  /* &   */
%left  EQEQ NEQ                             /* == != */
%left  LT LTE GT GTE                        /* < <= > >= */
%left  SHL SHR SAR                          /* << >> >>> */
%left  PLUS MINUS                           /* + -  */
%left  STAR SLASH PERCENT                   /* * / % */

%start <Ast.block> prog

%%

prog:
  | stmts = list(stmt); EOF { stmts }
  ;

block:
  | LBRACE; stmts = list(stmt); RBRACE { stmts }
  ;

stmt:
  /* variable assignment */
  | id = IDENT; EQUALS; e = expr; SEMICOLON
      { Assign (id, e) }

  /* if / else-if / else */
  | IF; LPAREN; cond = expr; RPAREN; tb = block; ELSE; fb = block
      { If (cond, tb, fb) }
  | IF; LPAREN; cond = expr; RPAREN; tb = block
      { If (cond, tb, []) }

  /* for (id = start; id < stop) { … }  ── canonical form for HLS loops */
  | FOR; LPAREN; id = IDENT; EQUALS; start_e = expr; SEMICOLON;
         IDENT; LT; stop_e = expr; RPAREN; b = block
      { For (id, start_e, stop_e, b) }

  /* while (cond) { … } */
  | WHILE; LPAREN; cond = expr; RPAREN; b = block
      { While (cond, b) }

  /* return expr; */
  | RETURN; e = expr; SEMICOLON
      { Return e }
  ;

expr:
  /* Atoms */
  | i  = INT                               { Const i }
  | id = IDENT                             { Var id }

  /* Arithmetic */
  | e1 = expr; PLUS;    e2 = expr          { BinOp (Add,  e1, e2) }
  | e1 = expr; MINUS;   e2 = expr          { BinOp (Sub,  e1, e2) }
  | e1 = expr; STAR;    e2 = expr          { BinOp (Mul,  e1, e2) }
  | e1 = expr; SLASH;   e2 = expr          { BinOp (Div,  e1, e2) }
  | e1 = expr; PERCENT; e2 = expr          { BinOp (Mod,  e1, e2) }

  /* Shifts */
  | e1 = expr; SHL;     e2 = expr          { BinOp (Shl,  e1, e2) }
  | e1 = expr; SHR;     e2 = expr          { BinOp (Shr,  e1, e2) }
  | e1 = expr; SAR;     e2 = expr          { BinOp (Sar,  e1, e2) }

  /* Bitwise */
  | e1 = expr; AMP;     e2 = expr          { BinOp (BAnd, e1, e2) }
  | e1 = expr; PIPE;    e2 = expr          { BinOp (BOr,  e1, e2) }
  | e1 = expr; BXOR;    e2 = expr          { BinOp (BXor, e1, e2) }

  /* Comparisons */
  | e1 = expr; EQEQ;    e2 = expr          { BinOp (Eq,   e1, e2) }
  | e1 = expr; NEQ;     e2 = expr          { BinOp (NEq,  e1, e2) }
  | e1 = expr; LT;      e2 = expr          { BinOp (Lt,   e1, e2) }
  | e1 = expr; LTE;     e2 = expr          { BinOp (Lte,  e1, e2) }
  | e1 = expr; GT;      e2 = expr          { BinOp (Gt,   e1, e2) }
  | e1 = expr; GTE;     e2 = expr          { BinOp (Gte,  e1, e2) }

  /* Logical */
  | e1 = expr; BAND;    e2 = expr          { BinOp (BAnd, e1, e2) }
  | e1 = expr; BOR;     e2 = expr          { BinOp (BOr,  e1, e2) }

  /* Grouping */
  | LPAREN; e = expr; RPAREN               { e }
  ;
