```lezer
@top Program {
  Program {
    SourceElement*
  }
}

SourceElement {
  STATEMENT --sourceStatement
  EXP ";" --sourceExp
}

@tokens {
  docComment { "###" (~"###" sourceCharacter)* "###" }
  multiLineComment { "##" (~"##" sourceCharacter)* "##" }
  singleLineComment { "#" (~[\n\r\u2028\u2029] sourceCharacter)* }
  lineTerminator { "\n" | "\r" | "\u2028" | "\u2029" }
  sourceCharacter { any }
  identifier { "_" | letter (letter | "_" | digit)* }
  keyword { "@" identifier }
  stringChar { ~[""\\\n\r\u2028\u2029] any }
  bit { "0" | "1" }
  octDigit { "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" }
  hexDigit { digit | "a".."f" | "A".."F" }
  BinOp {
    "++" --concat
    "+" --add
    "-" --sub
    "*" --mult
    "/" --div
    "..." --spread
    ".." --series
    "|>" --pipe
    keyword --keywordOp
  }
}

@skip { space | comment }

comment {
  docComment
  multiLineComment
  singleLineComment
}

EXP {
  BinaryExp
  Definition
  FunctionCall
  Literal
  Name
  OptionalWrapped<EXP>
}

BinaryExp {
  EXP BinOp (Literal | Name) --bin
}

Definition {
  keyword TypedIdentifier Params Assign?
}

FunctionCall {
  evalSigil Name Args NamedArg*
}

evalSigil {
  runtimeSigil
  comptimeSigil
}

runtimeSigil {
  "&"
}

comptimeSigil {
  "&&"
}

Literal {
  StringLiteral
  BlockLiteral
  MapLiteral
  ArrayTupleLiteral
  NumericLiteral
  BooleanLiteral
}

StringLiteral {
  "\"" stringChar* "\""
}

BlockLiteral {
  "{" ListOf<EXP, ";"> ";"? "}"
}

MapLiteral {
  "${" ListOf<MapEntry, ";"> "}"
}

MapEntry {
  TypedIdentifier "=" EXP
}

ArrayTupleLiteral {
  "[" ListOf<EXP, ","> "]"
}

NumericLiteral {
  BinLiteral
  HexLiteral
  OctLiteral
  FloatLiteral
  IntLiteral
}

BooleanLiteral {
  "$true"
  "$false"
}

BinLiteral {
  "0b" bit+ ("_" bit+)*
}

HexLiteral {
  "0x" hexDigit+ ("_" hexDigit+)*
}

OctLiteral {
  "0c" octDigit+ ("_" octDigit+)*
}

FloatLiteral {
  digit+ ("_" digit+)* "." digit+
}

IntLiteral {
  digit+ ("_" digit+)*
}

Name {
  idenKeyword "::" identifier* "." identifier*
}

idenKeyword {
  identifier
  keyword
}

TypedIdentifier {
  identifier Type?
}

Type {
  ":" OptionalWrapped<IdenParams>
}

IdenParams {
  idenKeyword Params
}

Params {
  ListOf<TypedIdentifier, ",">
}

Assign {
  "=" EXP
}

Args {
  ListOf<EXP, ",">
}

NamedArg {
  "$" identifier EXP
}

OptionalWrapped<rule> {
  rule
}


```