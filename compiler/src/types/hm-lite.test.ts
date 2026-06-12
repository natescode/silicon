// SPDX-License-Identifier: MIT
/**
 * HM-lite end-to-end tests.
 *
 * Proves the typechecker delivers on the UX promise:
 *   - `\\\\ id[T] (T)
@fn id x := x;` typechecks without explicit type args at the call.
 *   - `@type Option[T] := $Some value T | $None;` makes `Option[Int]` and
 *     `Option[Float]` distinct nominal types.
 *   - Type variables flow through nested calls (the `unwrap_or (Some 42), 0`
 *     case where `T` is determined by a chain of unifications).
 *   - Real type errors (passing the wrong type) produce useful diagnostics.
 *
 * Roc-style restriction: schemes are introduced *only* by syntactic `[T]`
 * declarations on `@fn` / `@type`.  No let-generalisation.
 */

import { test, expect, describe } from 'bun:test'
import { buildStrataRegistry } from '../elaborator/strataLoader'
import elaborate from '../elaborator/elaborator'
import typecheck from '../types/typechecker'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'

function check(src: string): { errors: string[] } {
    const prog = addToAstSemantics(siliconGrammar)(parse(src)).toAst() as any
    const registry = buildStrataRegistry(prog)
    const elab = elaborate(prog, registry)
    const { errors } = typecheck(elab.program, registry)
    return { errors: errors.map(e => `${e.kind}: ${e.message}`) }
}

function ok(src: string): void {
    const { errors } = check(src)
    if (errors.length > 0) {
        throw new Error(`expected no errors, got:\n  ${errors.join('\n  ')}`)
    }
}

function errs(src: string, ...substrings: string[]): void {
    const { errors } = check(src)
    if (errors.length === 0) throw new Error('expected errors, got none')
    for (const s of substrings) {
        const found = errors.some(e => e.includes(s))
        if (!found) {
            throw new Error(`expected an error containing "${s}", got:\n  ${errors.join('\n  ')}`)
        }
    }
}

// ---------------------------------------------------------------------------
// Generic functions
// ---------------------------------------------------------------------------

describe('@fn[T] — generic functions', () => {
    test('id called with Int — no explicit [Int] needed', () => {
        ok(`\\\\ id[T] (T)
@fn id[T] x := x;
\\\\ use Int
@fn use := id(42);`)
    })

    test('id called with Float — independently inferred per call', () => {
        ok(`\\\\ id[T] (T)
@fn id[T] x := x;
\\\\ use_i Int
@fn use_i := id(42);
\\\\ use_f Float
@fn use_f := id(3.14);`)
    })

    test('two-parameter generic — both type vars inferred', () => {
        ok(`\\\\ second[A, B] (A, B)
@fn second[A, B] x, y := y;
\\\\ use Int
@fn use := second('hello', 42);`)
    })

    test('passing wrong arg type — error pins it to the surrounding context', () => {
        errs(`\\\\ id[T] (T)
@fn id[T] x := x;
\\\\ use Int
@fn use := id('hello');`,
            'declared as Int but initialiser has type String')
    })

    test('generic without surrounding annotation still typechecks ✓', () => {
        // `use_no_ctx`'s return type isn't annotated, so the call to id
        // produces a fresh `?T1` that unification leaves unresolved.
        // That's fine — the body just synthesises some type, no error.
        ok(`\\\\ id[T] (T)
@fn id[T] x := x;
@fn use_no_ctx := id(42);`)
    })
})

// ---------------------------------------------------------------------------
// Generic types
// ---------------------------------------------------------------------------

describe('@type[T] — parametric sum types', () => {
    test('Option[T] declaration alone typechecks', () => {
        ok(`@type Option[T] := $Some value T | $None;`)
    })

    test('&Some arg type drives Option[T] — no explicit [Int]', () => {
        ok(`@type Option[T] := $Some value T | $None;
            \\\\ give Option[Int]
            @fn give := Some(42);`)
    })

    test('Some 1.0 with Option[Float] annotation works', () => {
        ok(`@type Option[T] := $Some value T | $None;
            \\\\ give Option[Float]
            @fn give := Some(1.0);`)
    })

    test('&None with explicit annotation — annotation pins ?T', () => {
        // No arg to drive inference, but `:Option[Int]` unification on the
        // body type pins ?T to Int.
        ok(`@type Option[T] := $Some value T | $None;
            \\\\ nothing Option[Int]
            @fn nothing := None();`)
    })

    test('Option[Int] and Option[Float] are distinct types', () => {
        errs(`@type Option[T] := $Some value T | $None;
              \\\\ want_int (Option[Int])
              @fn want_int x := 0;
              \\\\ give_float Option[Float]
              @fn give_float := Some(1.0);
              \\\\ mismatch Int
              @fn mismatch := want_int(give_float());`,
            'expected Option[Int]', 'got Option[Float]')
    })

    test('Some with the wrong arg type fails against the annotation', () => {
        errs(`@type Option[T] := $Some value T | $None;
              \\\\ bad Option[Int]
              @fn bad := Some(1.0);`,
            'declared as Option[Int]', 'Option[Float]')
    })
})

// ---------------------------------------------------------------------------
// Generic functions over generic types — the real test
// ---------------------------------------------------------------------------

describe('generic fns over generic types', () => {
    test('unwrap_or[T] opt:Option[T], dflt:T :T — declares cleanly', () => {
        ok(`@type Option[T] := $Some value T | $None;
            \\\\ unwrap_or[T] (Option[T], T)
            @fn unwrap_or opt, dflt := dflt;`)
    })

    test('unwrap_or((Some 42), 0) — T flows through the whole call chain', () => {
        ok(`@type Option[T] := $Some value T | $None;
            \\\\ unwrap_or[T] (Option[T], T)
            @fn unwrap_or[T] opt, dflt := dflt;
            \\\\ use Int
            @fn use := unwrap_or(Some(42), 0);`)
    })

    test('unwrap_or((None), 0) — &None inherits T from dflt:Int', () => {
        ok(`@type Option[T] := $Some value T | $None;
            \\\\ unwrap_or[T] (Option[T], T)
            @fn unwrap_or[T] opt, dflt := dflt;
            \\\\ use Int
            @fn use := unwrap_or(None(), 0);`)
    })

    test('unwrap_or((Some 1.0), 0) — opt type mismatches dflt → error', () => {
        errs(`@type Option[T] := $Some value T | $None;
              \\\\ unwrap_or[T] (Option[T], T)
              @fn unwrap_or[T] opt, dflt := dflt;
              \\\\ bad Int
              @fn bad := unwrap_or(Some(1.0), 0);`,
            'unwrap_or', 'arg 1')
    })
})

// ---------------------------------------------------------------------------
// @match arm unification — HM-lite must thread substitution through arms
// ---------------------------------------------------------------------------

describe('@match with parametric sums', () => {
    test('non-generic Option match typechecks', () => {
        ok(`@type Option := $Some value Int | $None;
            \\\\ unwrap (Option, Int)
            @fn unwrap opt, dflt := {
                @match(opt, $Some v, {
                    v
                }, $None, {
                    dflt
                })
            };`)
    })

    test('generic Option[T] match — arm result types unify through T', () => {
        ok(`@type Option[T] := $Some value T | $None;
            \\\\ unwrap_or[T] (Option[T], T)
            @fn unwrap_or[T] opt, dflt := {
                @match(opt, $Some v, {
                    v
                }, $None, {
                    dflt
                })
            };`)
    })

    test('generic match at a concrete call site', () => {
        ok(`@type Option[T] := $Some value T | $None;
            \\\\ unwrap_or[T] (Option[T], T)
            @fn unwrap_or[T] opt, dflt := {
                @match(opt, $Some v, {
                    v
                }, $None, {
                    dflt
                })
            };
            \\\\ use_i Int
            @fn use_i := unwrap_or(Some(42), 0);
            \\\\ use_n Int
            @fn use_n := unwrap_or(None(), 7);`)
    })
})

// ---------------------------------------------------------------------------
// Arm-expression form for @match
// ---------------------------------------------------------------------------

describe('@match flat form', () => {
    test('simple flat form typechecks', () => {
        ok(`@type Option := $Some value Int | $None;
            \\\\ unwrap (Option, Int)
            @fn unwrap opt, dflt := {
                @match(opt, $Some v, { v }, $None, { dflt })
            };`)
    })

    test('flat form with multi-statement block bodies', () => {
        ok(`@type Option := $Some value Int | $None;
            \\\\ unwrap (Option, Int)
            @fn unwrap opt, dflt := {
                @match(opt, $Some v, {
                    v
                }, $None, {
                    dflt
                })
            };`)
    })

    test('flat form with generic Option[T] and HM-lite', () => {
        ok(`@type Option[T] := $Some value T | $None;
            \\\\ unwrap_or[T] (Option[T], T)
            @fn unwrap_or[T] opt, dflt := {
                @match(opt, $Some v, { v }, $None, { dflt })
            };
            \\\\ use Int
            @fn use := unwrap_or(Some(42), 0);`)
    })

    test('per-arm pattern alternation: $Red | $Green, { … }', () => {
        ok(`@type Color := $Red | $Green | $Blue;
            \\\\ warm (Color)
            @fn warm c := {
                @match(c, $Red | $Green, { 1 }, $Blue, { 0 })
            };`)
    })

    test('three-way alternation', () => {
        ok(`@type Shape := $Circle | $Square | $Triangle | $Pentagon;
            \\\\ polygon (Shape)
            @fn polygon s := {
                @match(s, $Square | $Triangle | $Pentagon, { 1 }, $Circle, { 0 })
            };`)
    })

    test('flat form with trailing default', () => {
        ok(`@type Color := $Red | $Green | $Blue;
            \\\\ cls (Color)
            @fn cls c := {
                @match(c, $Red, { 1 }, { 0 })
            };`)
    })

    test('legacy flat form still works (regression)', () => {
        ok(`@type Option := $Some value Int | $None;
            \\\\ unwrap (Option, Int)
            @fn unwrap opt, dflt := {
                @match(opt, $Some v, {
                    v
                }, $None, {
                    dflt
                })
            };`)
    })

    test('variant field binding uses real declared type — Option[Float] works', () => {
        // Previously the variant-destructure bound `v` as Int regardless of
        // the variant's declared field type.  For Option[Float], `$Some v
        // => v` would bind v:Int and the arm would type as Int, mismatching
        // the dflt:Float arm.  Now we look up the variant scheme and
        // substitute the discriminant's typeArgs for the variant's tvars.
        ok(`@type Option[T] := $Some value T | $None;
            \\\\ unwrap_or[T] (Option[T], T)
            @fn unwrap_or[T] opt, dflt := {
                @match(opt, $Some v, { v }, $None, { dflt })
            };
            \\\\ use_f Float
            @fn use_f := unwrap_or(Some(3.14), 0.0);`)
    })

    test('field binding catches wrong-type body for Float-Option used as Int', () => {
        errs(`@type Option[T] := $Some value T | $None;
              \\\\ unwrap_or[T] (Option[T], T)
              @fn unwrap_or[T] opt, dflt := {
                  @match(opt, $Some v, { v }, $None, { dflt })
              };
              \\\\ bad Int
              @fn bad := unwrap_or(Some(3.14), 0.0);`,
            'bad')
    })

    test('Name::Variant namespace paths resolve (gap #2)', () => {
        // Color::Red used in pattern position — legacy flat form
        ok(`@type Color := $Red | $Green | $Blue;
            \\\\ warm (Color)
            @fn warm c := {
                @match(c, Color::Red, {
                    1
                }, Color::Blue, {
                    0
                })
            };`)
    })

    test('Name::Variant works with flat form + alternation', () => {
        ok(`@type Color := $Red | $Green | $Blue;
            \\\\ warm (Color)
            @fn warm c := {
                @match(c, Color::Red | Color::Green, { 1 }, Color::Blue, { 0 })
            };`)
    })

    test('Name::Variant usable as a value', () => {
        ok(`@type Color := $Red | $Green | $Blue;
            \\\\ red () -> Color
            @fn red  := Color::Red;`)
    })
})

// ---------------------------------------------------------------------------
// Regression — non-generic code must still work the same
// ---------------------------------------------------------------------------

describe('non-generic code unchanged', () => {
    test('plain @fn add x:Int, y:Int := x + y; — strict-equality path', () => {
        ok(`\\\\ add (Int, Int)
@fn add x, y := x + y;
\\\\ use Int
@fn use := add(1, 2);`)
    })

    test('arg-type mismatch on monomorphic fn — still errors clearly', () => {
        errs(`\\\\ add (Int, Int)
@fn add x, y := x + y;
\\\\ bad Int
@fn bad := add(1, 'hi');`,
            'add', 'arg 1')
    })

    test('non-parametric sum (Color) still formats with variants', () => {
        ok(`@type Color := $Red | $Green | $Blue;`)
    })
})
