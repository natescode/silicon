# Core IR Boundary

Core IR v0 (stable & minimal)

- Program
- Element (Definition or Expression)
- CoreExp
- Call(callee, args) (args as []ExprId long-term; v0 could temporarily accept binders)
- BinExp(op, lhs, rhs)
- Variable
- Literal
- CoreDecl
- DefKind(kind, binder, params, value)
- Block(items) (even if unreachable today)
- CoreTypeRef (minimal)
- Named(IdentId) only
- Import

## Program

    Contains Elements

## Definition

```
Decl.DefKind {
  kind: IdentId,              // from keyword = "@" identifier
  binder: Binder { name, type? } // from typedIdentifier
  params: []Param,            // from Params? (typedIdentifier list)
  value: ExprId               // from Assign
}
```

## Expr Binary

```
Expr.Binary { op: OpId, lhs: ExprId, rhs: ExprId }
```



# Core Decl

- FnDecl
- VarDecl
- DefDecl
- TypeDecl
- Any/HookDecl


# Core Expr

Literal (int/float/string/bool/atom)

Name (identifier)

Call (your & call form, plus args, plus named args)

Binary (op token + lhs + rhs, no precedence, left-to-right as parsed)

Block (list of statements/decls + optional tail expr)

If (if you have it already)

Record/Tuple (whatever your data literal is)