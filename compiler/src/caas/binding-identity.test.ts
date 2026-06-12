// SPDX-License-Identifier: MIT
/**
 * S1 — binding identity (`containingSymbol`) and scope-correct
 * rename/references.
 *
 * Before S1, references were aggregated by bare NAME: renaming a parameter
 * `x` in one function rewrote every `x` in the workspace.  The binder
 * (`ast/binder.ts`) assigns each local occurrence to its concrete binding,
 * the SemanticModel surfaces those bindings as Symbols with a populated
 * `containingSymbol`, and Workspace.findReferences/rename consume them.
 */
import { describe, test, expect } from 'bun:test'
import { Workspace } from './workspace'

// Column map (1-based) for the two-function fixture:
//   @fn add x, y := { x + y };     x: def col 9, use col 19; y: def 12, use 23
//   @fn mul x, y := { x * y };     (line 2, same columns)
//   s := add(1, 2);
const TWO_FNS = '@fn add x, y := { x + y };\n@fn mul x, y := { x * y };\ns := add(1, 2);'

describe('S1 — parameter binding identity', () => {
    test('a parameter resolves to a parameter symbol with containingSymbol', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', TWO_FNS)
        const model = ws.getDocument('f.si')!.model

        const onDef = model.symbolAtPosition(1, 9)    // `x` in add's param list
        expect(onDef?.kind).toBe('parameter')
        expect(onDef?.name).toBe('x')
        expect(onDef?.containingSymbol?.name).toBe('add')

        const onUse = model.symbolAtPosition(1, 19)   // `x` in add's body
        expect(onUse).toBe(onDef)                      // same binding, same Symbol
    })

    test("two functions' same-named params are distinct bindings", () => {
        const ws = new Workspace()
        ws.openDocument('f.si', TWO_FNS)
        const model = ws.getDocument('f.si')!.model
        const addX = model.symbolAtPosition(1, 9)
        const mulX = model.symbolAtPosition(2, 9)
        expect(addX).toBeDefined()
        expect(mulX).toBeDefined()
        expect(addX).not.toBe(mulX)
        expect(addX!.containingSymbol?.name).toBe('add')
        expect(mulX!.containingSymbol?.name).toBe('mul')
    })

    test('findReferences on a param returns only that binding (one function, one doc)', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', TWO_FNS)
        ws.openDocument('g.si', '@fn neg x := { 0 - x };')   // another `x` elsewhere

        const refs = ws.findReferences('f.si', 1, 19)        // `x` use in add's body
        expect(refs.map(s => `${s.file}:${s.line}:${s.col}`)).toEqual(['f.si:1:19'])
    })

    test('rename of a param touches only its own occurrences', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', TWO_FNS)
        const edit = ws.rename('f.si', 1, 9, 'lhs')          // add's `x` (definition site)
        const spans = [...(edit.get('f.si') ?? [])].map(e => `${e.span.line}:${e.span.col}`).sort()
        expect(spans).toEqual(['1:19', '1:9'])               // def + body use; NOT mul's x
        expect(edit.uris).toEqual(['f.si'])
    })

    test('parameter symbol reads its type off the function signature', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '\\\\ add (Int, Int) -> Int\n@fn add x, y := { x + y };\ns := add(1, 2);')
        const sym = ws.getDocument('f.si')!.model.symbolAtPosition(2, 9)
        expect(sym?.kind).toBe('parameter')
        expect(sym?.displayString).toBe('(param x) Int')
    })
})

describe('S1 — shadowing: top-level vs local', () => {
    //   g := 1;                       g def line 1 col 1
    //   @fn f g, y := { g + y };      param g: def col 7, use col 17
    //   h := g + 2;                   top-level g use: col 6
    const SHADOW = 'g := 1;\n@fn f g, y := { g + y };\nh := g + 2;'

    test('top-level references EXCLUDE occurrences claimed by a shadowing param', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', SHADOW)
        const refs = ws.findReferences('f.si', 3, 6)         // top-level `g` use
        const keys = refs.map(s => `${s.line}:${s.col}`)
        expect(keys).toContain('3:6')
        expect(keys).not.toContain('2:17')                   // shadowed by param g
    })

    test('renaming the top-level binding leaves the shadowing param alone', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', SHADOW)
        const edit = ws.rename('f.si', 3, 6, 'base')
        const spans = [...(edit.get('f.si') ?? [])].map(e => `${e.span.line}:${e.span.col}`).sort()
        expect(spans).not.toContain('2:7')
        expect(spans).not.toContain('2:17')
        expect(spans).toContain('3:6')
    })

    test('references on the shadowing param stay inside the function', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', SHADOW)
        const refs = ws.findReferences('f.si', 2, 17)        // `g` use in f's body
        expect(refs.map(s => `${s.line}:${s.col}`)).toEqual(['2:17'])
    })

    test('cross-document: top-level rename never rewrites another doc\'s local', () => {
        const ws = new Workspace()
        ws.openDocument('lib.si', '@fn scale x := { x * 2 };')
        ws.openDocument('main.si', 's := scale(3);\n@fn local_shadow scale := { scale };')

        const edit = ws.rename('lib.si', 1, 5, 'double')     // top-level `scale`
        const mainSpans = [...(edit.get('main.si') ?? [])].map(e => `${e.span.line}:${e.span.col}`)
        expect(mainSpans).toContain('1:6')                   // the call site
        // the shadowing param + its use in line 2 must be untouched
        expect(mainSpans.every(k => !k.startsWith('2:'))).toBe(true)
    })
})

describe('S1 — local definitions and @match pattern fields', () => {
    test('a local binding is scoped to its function', () => {
        //   @fn f x := { t := x + 1; t };      t def col 14, use col 26
        //   @fn g x := { t := x + 2; t };
        const src = '@fn f x := { t := x + 1; t };\n@fn g x := { t := x + 2; t };'
        const ws = new Workspace()
        ws.openDocument('f.si', src)
        const model = ws.getDocument('f.si')!.model

        const tInF = model.symbolAtPosition(1, 14)
        expect(tInF?.kind).toBe('variable')
        expect(tInF?.containingSymbol?.name).toBe('f')

        const refs = ws.findReferences('f.si', 1, 14)
        expect(refs.map(s => `${s.line}:${s.col}`)).toEqual(['1:26'])
    })

    test('a @match pattern field binds only in its arm', () => {
        //   @type Opt := $Some v Int | $None;
        //   r := @match(Some(1), $Some v, { v }, $None, { 0 });
        //                              def ^28  ^33 use
        const src = '@type Opt := $Some v Int | $None;\nr := @match(Some(1), $Some v, { v }, $None, { 0 });'
        const ws = new Workspace()
        ws.openDocument('f.si', src)
        const model = ws.getDocument('f.si')!.model

        const v = model.symbolAtPosition(2, 33)              // `v` in the arm body
        expect(v?.kind).toBe('variable')
        expect(v?.name).toBe('v')

        const refs = ws.findReferences('f.si', 2, 28)        // from the pattern field
        expect(refs.map(s => `${s.line}:${s.col}`)).toEqual(['2:33'])
    })

    test('top-level symbols keep containingSymbol === undefined', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', TWO_FNS)
        for (const sym of ws.getDocument('f.si')!.model.allSymbols) {
            expect(sym.containingSymbol).toBeUndefined()
        }
    })
})
