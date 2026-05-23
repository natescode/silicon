/**
 * Strata Body Interpreter Tests
 *
 * Exercises isRichBody detection, the body interpreter's evaluation rules,
 * and the integration path that compiles a rich body into an IRDefExpander
 * registered into the ElaboratorRegistry.
 */

import { test, expect } from 'bun:test'
import { isRichBody, compileBodyToDefExpander, StrataBodyError } from './strataBody'
import { buildStrataRegistry } from './strataLoader'
import { ASTFactory } from '../ast/astNodes'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'
import type { CompilerAPI } from '../compiler-api'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a Silicon source and return the first Elaboration node. */
function parseStrata(source: string): any {
    const match = parse(source)
    const ast = addToAstSemantics(siliconGrammar)(match).toAst() as any
    return ast.elements.find((el: any) =>
        el.type === 'Elaboration' || (el.type === 'Element' && el.kind === 'elaboration')
    )
}

/** Build a minimal CompilerAPI mock that records all method calls. */
function mockApi() {
    const calls: Array<{ path: string; args: any[] }> = []
    const locals  = new Map<string, string>()
    const globals = new Map<string, string>()
    const pendingLocals: any[] = []
    const varNames = new Set<string>()

    function record<T>(path: string, fn: (...args: any[]) => T) {
        return (...args: any[]) => {
            calls.push({ path, args })
            return fn(...args)
        }
    }

    const api = {
        ctx: {
            locals:  { get: record('ctx.locals.get',  (n: string) => locals.get(n)),
                       set: record('ctx.locals.set',  (n: string, t: string) => { locals.set(n, t) }) },
            globals: { get: record('ctx.globals.get', (n: string) => globals.get(n)),
                       set: record('ctx.globals.set', (n: string, t: string) => { globals.set(n, t) }) },
            varNames: { has: record('ctx.varNames.has', (n: string) => varNames.has(n)),
                        add: record('ctx.varNames.add', (n: string) => { varNames.add(n) }) },
            pendingLocals: { push: record('ctx.pendingLocals.push', (l: any) => { pendingLocals.push(l) }) },
        },
        ir: {
            makeLocal:  record('ir.makeLocal',  (name: string, wasmType: string) => ({ name, wasmType })),
            makeConst:  record('ir.makeConst',  (value: number, wasmType: string) => ({ kind: 'Const', wasmType, value })),
            makeGlobal: record('ir.makeGlobal', (name: string, wasmType: string, mutable: boolean, init: any) => ({ kind: 'Global', name, wasmType, mutable, init })),
            null:       record('ir.null',       () => null),
        },
        resolveType:     record('resolveType',     (annotation: any) => annotation?.typename === 'Float' ? 'f32' : 'i32'),
        resolveTypeName: record('resolveTypeName', (n: string) => n === 'Float' ? 'f32' : 'i32'),
        watId:           record('watId',           (s: string) => s.replace(/::/g, '_')),
    }

    return { api: api as unknown as CompilerAPI, calls, locals, globals, pendingLocals, varNames }
}

// ---------------------------------------------------------------------------
// isRichBody
// ---------------------------------------------------------------------------

test('isRichBody: simple intrinsic-only body returns false', () => {
    const elab = parseStrata(`@stratum_keyword Foo ('@foo', Node) = { &IR::def_function; };`)
    expect(isRichBody(elab.semantics)).toBe(false)
})

test('isRichBody: operator-style body with Node refs returns false', () => {
    const elab = parseStrata(`@stratum_operator Bar ('+', Node) = { &IR::i32_add Node.left, Node.right; };`)
    expect(isRichBody(elab.semantics)).toBe(false)
})

test('isRichBody: body with &Compiler:: call returns true', () => {
    const elab = parseStrata(`
        @stratum_keyword Baz ('@baz', Node) = {
            &Compiler::ctx::globals::set Node.name, Node.name;
            &IR::null;
        };
    `)
    expect(isRichBody(elab.semantics)).toBe(true)
})

test('isRichBody: body with @local definition returns true', () => {
    const elab = parseStrata(`
        @stratum_keyword Qux ('@qux', Node) = {
            @local x := Node.name;
            &IR::null;
        };
    `)
    expect(isRichBody(elab.semantics)).toBe(true)
})

// ---------------------------------------------------------------------------
// Interpreter end-to-end
// ---------------------------------------------------------------------------

test('compileBodyToDefExpander: &Compiler::ctx::globals::set is invoked with Node fields', () => {
    const elab = parseStrata(`
        @stratum_keyword RegisterGlobal ('@register_global', Node) = {
            &Compiler::ctx::globals::set Node.name, Node.typeName;
            &IR::null;
        };
    `)
    const expander = compileBodyToDefExpander(elab.semantics, elab.nodeParamName)
    const { api, calls, globals } = mockApi()

    const def = { name: 'my_global', typeName: 'i32' }
    const result = expander.expand(def, 'my_global', api)

    expect(result).toBeNull()
    expect(globals.get('my_global')).toBe('i32')
    expect(calls.find(c => c.path === 'ctx.globals.set')).toEqual({
        path: 'ctx.globals.set',
        args: ['my_global', 'i32'],
    })
})

test('compileBodyToDefExpander: @local binding flows through later API calls', () => {
    const elab = parseStrata(`
        @stratum_keyword WithLocal ('@with_local', Node) = {
            @local sname := &Compiler::watId Node.rawName;
            &Compiler::ctx::globals::set sname, Node.typeName;
            &Compiler::ctx::varNames::add sname;
            &IR::null;
        };
    `)
    const expander = compileBodyToDefExpander(elab.semantics, elab.nodeParamName)
    const { api, calls, globals, varNames } = mockApi()

    const def = { rawName: 'Color::Red', typeName: 'i32' }
    expander.expand(def, 'whatever', api)

    expect(globals.get('Color_Red')).toBe('i32')   // watId replaced :: with _
    expect(varNames.has('Color_Red')).toBe(true)
    // The watId call should have run before the globals.set call.
    const watIdIdx     = calls.findIndex(c => c.path === 'watId')
    const setIdx       = calls.findIndex(c => c.path === 'ctx.globals.set')
    expect(watIdIdx).toBeLessThan(setIdx)
})

test('compileBodyToDefExpander: &Compiler::ir::makeGlobal return value is the def-expander result', () => {
    const elab = parseStrata(`
        @stratum_keyword GlobalDecl ('@global_decl', Node) = {
            @local zero :=&Compiler::ir::makeConst 0, Node.wasmType;
            &Compiler::ir::makeGlobal Node.name, Node.wasmType, Node.mutable, zero;
        };
    `)
    const expander = compileBodyToDefExpander(elab.semantics, elab.nodeParamName)
    const { api } = mockApi()

    const def = { name: 'counter', wasmType: 'i32', mutable: true }
    const result = expander.expand(def, 'counter', api)

    expect(result).toEqual({
        kind: 'Global',
        name: 'counter',
        wasmType: 'i32',
        mutable: true,
        init: { kind: 'Const', wasmType: 'i32', value: 0 },
    } as any)
})

test('compileBodyToDefExpander: unknown identifier throws StrataBodyError', () => {
    const elab = parseStrata(`
        @stratum_keyword Bad ('@bad', Node) = {
            &Compiler::ctx::globals::set ghost, ghost;
            &IR::null;
        };
    `)
    const expander = compileBodyToDefExpander(elab.semantics, elab.nodeParamName)
    const { api } = mockApi()
    expect(() => expander.expand({}, 'bad', api)).toThrow(StrataBodyError)
})

test('compileBodyToDefExpander: any &IR::xxx / &WASM::xxx is a silent dispatch marker', () => {
    // Rich bodies build IR through &Compiler::ir::* constructors — raw
    // intrinsic refs are never invoked at runtime, they only signal the
    // codegen kind to the loader. So &IR::i32_add silently returns null.
    const elab = parseStrata(`
        @stratum_keyword MarkerNoOp ('@marker_noop', Node) = {
            @local v := Node.x;
            &IR::i32_add Node.x, Node.x;
        };
    `)
    const expander = compileBodyToDefExpander(elab.semantics, elab.nodeParamName)
    const { api } = mockApi()
    expect(expander.expand({ x: 1 }, 'noop', api)).toBeNull()
})

// ---------------------------------------------------------------------------
// Integration with buildStrataRegistry
// ---------------------------------------------------------------------------

test('buildStrataRegistry: rich-body strata is registered as an IRDefExpander', () => {
    // The leading &IR::def_local is the dispatch marker — picked up by the
    // loader to bind this strata to the 'local' codegen kind. The marker is a
    // runtime no-op during body execution; the actual lowering happens through
    // the &Compiler::* calls that follow.
    const source = `
        @stratum_keyword MyLocal ('@my_local', Node) = {
            &IR::def_local;
            @local wasmType := &Compiler::resolveType Node.name.typeAnnotation;
            @local sname    := &Compiler::watId Node.name.name;
            @local decl     := &Compiler::ir::makeLocal sname, wasmType;
            &Compiler::ctx::pendingLocals::push decl;
            &Compiler::ctx::locals::set sname, wasmType;
            &IR::null;
        };
    `
    const registry = buildStrataRegistry(ASTFactory.program([]), [source])

    expect(registry.keywords['@my_local']).toBeDefined()
    const exp = registry.defExpanders.get('local')
    expect(exp).toBeDefined()
    expect(typeof exp!.expand).toBe('function')
})

test('buildStrataRegistry: rich-body def-expander is invokable end-to-end', () => {
    const source = `
        @stratum_keyword TestLocal ('@test_local', Node) = {
            &IR::def_local;
            @local wasmType := &Compiler::resolveType Node.name.typeAnnotation;
            @local sname    := &Compiler::watId Node.name.name;
            @local decl     := &Compiler::ir::makeLocal sname, wasmType;
            &Compiler::ctx::pendingLocals::push decl;
            &Compiler::ctx::locals::set sname, wasmType;
            &IR::null;
        };
    `
    const registry = buildStrataRegistry(ASTFactory.program([]), [source])
    const exp = registry.defExpanders.get('local')!

    const { api, pendingLocals, locals } = mockApi()
    const def = {
        type: 'Definition',
        keyword: '@test_local',
        name: { name: 'x', typeAnnotation: { typename: 'Float' } },
    }
    const result = exp.expand(def, 'x', api)

    expect(result).toBeNull()
    expect(pendingLocals).toEqual([{ name: 'x', wasmType: 'f32' }])
    expect(locals.get('x')).toBe('f32')
})

test('strata body: &IR::def_* and &IR::meta_* are silent dispatch markers', () => {
    const elab = parseStrata(`
        @stratum_keyword MarkerOnly ('@marker_only', Node) = {
            &IR::def_global;
            &IR::meta_export;
            &Compiler::ctx::globals::set Node.name, Node.typeName;
            &IR::null;
        };
    `)
    const expander = compileBodyToDefExpander(elab.semantics, elab.nodeParamName)
    const { api, globals } = mockApi()
    expect(() => expander.expand({ name: 'g', typeName: 'i32' }, 'g', api)).not.toThrow()
    expect(globals.get('g')).toBe('i32')
})
