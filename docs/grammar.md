# Silicon PEG Grammar

```ohm
Silicon {
    
  Program   = SourceElement*
  
  SourceElement = STATEMENT | DEF | EXP
  
  STATEMENT = Assign
  			| EXP "==" EXP --compare
        
  DEF = | TypedIdentifier Params ":=" EXP -- gopher
  		|"@type" TypedIdentifier Params  --typeDef 
  		| "@let" TypedIdentifier Params --letDef 
        | "@fn" TypedIdentifier Args --fnDef 
        
  EXP = KeywordExpression
 		| EXP ("+"| "-") EXP -- addExp
  		| EXP "<=" EXP -- lteEXP
        | "#" EXP ("|>" identifier)+ --pipeExp
  		
        | "#" (identifier | EXP) ("." identifier)+ --methodChainExp
        | TypedIdentifier
        | identifier
        | num
        | "\"" stringChar*  "\"" --stringLit
        | "{" EXP "}" --block
        | "(" EXP* ")" -- parens
        | "[" ListOf<EXP,","> "]" --arrayLit
        | "#" identifier Args --fnCall
     
      
  KeywordExpression = "@if" Args -- ifExp 
  					| "@for" Args -- forExp
                    | "@while" Args -- whileExp
                    | "@match" Args -- matchExp
                    | "@open" namespace --open
                   // | "@open" Args ("=" namespace)? -- openAlias
                    | "@import" Args "@from" EXP_stringLit --import
                    | booleanLiteral --booleanLit
                   
             
  stringChar = ~("\"" | "\\" | lineTerminator) any
  lineTerminator = "\n" | "\r" | "\u2028" | "\u2029"
  booleanLiteral = "@true" | "@false"
  namespace = identifier ("::" identifier)+
  num = digit+
  identifier = letter+
  TypedIdentifier = identifier+ #((":" identifier+)+)?
  Args  = ListOf<EXP+, ",">
  Params = ListOf<TypedIdentifier+,",">
  Assign = (identifier | DEF) "=" EXP --id
  comment = multiLineComment | singleLineComment
  sourceCharacter = any
  multiLineComment = "/*" (~"*/" sourceCharacter)* "*/"
  singleLineComment = "//" (~lineTerminator sourceCharacter)*
  space := whitespace | lineTerminator | comment
  unicodeSpaceSeparator = "\u2000".."\u200B" | "\u3000"
  whitespace = "\t"
             | "\x0B"    -- verticalTab
             | "\x0C"    -- formFeed
             | " "
             | "\u00A0"  -- noBreakSpace
             | "\uFEFF"  -- byteOrderMark
             | unicodeSpaceSeparator
  
  
}

/*

@open std::fs @use fileWrite, fileRead

*/

```