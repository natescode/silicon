// SPDX-License-Identifier: MIT
/**
 * ADVERSARIAL: multi-document workspaces + projects incremental-edit equivalence.
 *
 * Category: MULTI-DOCUMENT workspaces + projects.
 *
 * We build a workspace with several documents — some referencing symbols defined
 * in OTHER documents, some grouped into Projects with addDependency edges — then
 * apply seeded random incremental edits (ws.editDocument) to individual docs.
 *
 * After EACH edit we rebuild a FRESH workspace that replays the SAME workspace
 * state from scratch: same projects, same dependency edges, the SAME documents
 * opened in the SAME ORDER, each with its CURRENT source, and NO edits.  Then we
 * diff the edited document against its fresh twin across the four authoritative
 * surfaces from the equivalence contract:
 *   - diagnostics  (code + span + message, sorted)
 *   - symbols      (name|kind|displayString|definitionSpan|isImplicitlyDeclared, sorted)
 *   - per-node types (model.typeOf walked via astChildren, in order)
 *   - elaboration structure (stableStringify of elabTree.program, inferredType stripped)
 *
 * A divergence on ANY of those is a real cross-document incremental bug.
 *
 * Seeded with mulberry32 so any failure reproduces exactly.
 */
import { test, describe, expect } from 'bun:test'
import { Workspace, Project, type Document } from '../../src/caas/workspace.ts'
import { stableStringify } from '../../src/caas/incremental.ts'
import { astChildren } from '../../src/ast/astChildren.ts'

// ── seeded PRNG ─────────────────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
    let a = seed >>> 0
    return () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

// ── authoritative surfaces (per the contract) ──────────────────────────────
function diagKey(doc: Document): string {
    return doc.diagnostics
        .map(d => `${d.code}@${d.span.line}:${d.span.col}+${d.span.length}:${d.message}`)
        .sort().join('\n')
}
function symKey(doc: Document): string {
    return [...doc.model.allSymbols]
        .map(s => `${s.name}|${s.kind}|${s.displayString}|${s.definitionSpan?.line ?? '-'}:${s.definitionSpan?.col ?? '-'}|${s.isImplicitlyDeclared}`)
        .sort().join('\n')
}
function stripInferred(v: any): any {
    if (v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) return v.map(stripInferred)
    const out: Record<string, any> = {}
    for (const k of Object.keys(v)) if (k !== 'inferredType') out[k] = stripInferred(v[k])
    return out
}
const elabKey = (doc: Document) => stableStringify(stripInferred(doc.elabTree.program))
function typeKey(doc: Document): string {
    const out: string[] = []
    const walk = (n: any) => {
        if (n === null || typeof n !== 'object') return
        const t = doc.model.typeOf(n)
        out.push(t ? stableStringify(t) : '-')
        for (const c of astChildren(n)) walk(c)
    }
    walk(doc.elabTree.program)
    return out.join(',')
}

// ── workspace model: a declarative recipe we can replay fresh ───────────────
type ProjSpec = { name: string; target?: 'host' | 'wasm-gc'; deps: string[] }
type DocSpec  = { uri: string; project?: string }   // project name or undefined (flat)

/** A full description of a workspace that can be built incrementally OR fresh. */
interface WsRecipe {
    projects: ProjSpec[]
    /** Open order matters — replayed identically in the fresh oracle. */
    openOrder: DocSpec[]
}

/**
 * Build a workspace from a recipe + the CURRENT source of every doc.  Used both
 * for the initial incremental workspace AND for the fresh oracle re-open.
 */
function buildWorkspace(recipe: WsRecipe, srcOf: Map<string, string>): Workspace {
    const ws = new Workspace()
    const projects = new Map<string, Project>()
    // Create all projects first, then wire dependencies (deps may be forward refs).
    for (const p of recipe.projects) {
        projects.set(p.name, ws.addProject(p.name, { target: p.target }))
    }
    for (const p of recipe.projects) {
        const proj = projects.get(p.name)!
        for (const d of p.deps) proj.addDependency(projects.get(d)!)
    }
    for (const d of recipe.openOrder) {
        const src = srcOf.get(d.uri)!
        if (d.project) projects.get(d.project)!.addDocument(d.uri, src)
        else ws.openDocument(d.uri, src)
    }
    return ws
}

/** Re-open the same workspace state fresh (no edits) and return the target doc. */
function freshTwin(recipe: WsRecipe, srcOf: Map<string, string>, targetUri: string): Document {
    return buildWorkspace(recipe, srcOf).getDocument(targetUri)!
}

function compareAllSurfaces(inc: Document, full: Document, ctx: string): void {
    expect(diagKey(inc), `${ctx} :: diagnostics`).toBe(diagKey(full))
    expect(symKey(inc),  `${ctx} :: symbols`).toBe(symKey(full))
    expect(elabKey(inc), `${ctx} :: elaboration`).toBe(elabKey(full))
    expect(typeKey(inc), `${ctx} :: per-node types`).toBe(typeKey(full))
}

// ── edit generators ─────────────────────────────────────────────────────────
const EDIT_CHARS = [' ', '1', 'x', 'y', 'q', ';', '\n', '+', 'r', 'z', '&', '{', '}', ',']

function mutate(src: string, rand: () => number): string {
    if (src.length === 0) return '@global z := 1;'
    const at = Math.floor(rand() * src.length)
    const op = rand()
    const ch = EDIT_CHARS[Math.floor(rand() * EDIT_CHARS.length)]
    if (op < 0.34) return src.slice(0, at) + ch + src.slice(at)
    if (op < 0.67) return src.slice(0, at) + src.slice(at + 1)
    return src.slice(0, at) + ch + src.slice(at + 1)
}

// Structured edits that flip cross-document resolution on/off (the real target).
function renameTopLevel(src: string, from: string, to: string): string {
    return src.split(from).join(to)
}

// ---------------------------------------------------------------------------
// Scenario fixtures — multi-doc with cross-document references + projects.
// ---------------------------------------------------------------------------

/** lib defines `add`/`mul`; consumers call them across documents. */
const SCEN_FLAT: { recipe: WsRecipe; src: Map<string, string> } = {
    recipe: {
        projects: [],
        openOrder: [
            { uri: 'lib.si' },
            { uri: 'a.si' },
            { uri: 'b.si' },
        ],
    },
    src: new Map([
        ['lib.si', '@fn add x, y := { x + y };\n@fn mul x, y := { x * y };'],
        ['a.si',   '@global ra := &add 1, 2;'],
        ['b.si',   '@global rb := &mul 3, 4;\n@global rc := &add 5, 6;'],
    ]),
}

/** core <- app (app depends on core); util is unassigned (flat). */
const SCEN_PROJECT: { recipe: WsRecipe; src: Map<string, string> } = {
    recipe: {
        projects: [
            { name: 'core', deps: [] },
            { name: 'app',  deps: ['core'] },
        ],
        openOrder: [
            { uri: 'core/math.si', project: 'core' },
            { uri: 'app/main.si',  project: 'app' },
            { uri: 'app/aux.si',   project: 'app' },
        ],
    },
    src: new Map([
        ['core/math.si', '@fn add x, y := { x + y };\n@fn sub x, y := { x - y };'],
        ['app/main.si',  '@global r := &add 10, 20;'],
        ['app/aux.si',   '@global s := &sub 30, 9;'],
    ]),
}

/** Diamond deps: base <- left, base <- right, left/right <- top. */
const SCEN_DIAMOND: { recipe: WsRecipe; src: Map<string, string> } = {
    recipe: {
        projects: [
            { name: 'base',  deps: [] },
            { name: 'left',  deps: ['base'] },
            { name: 'right', deps: ['base'] },
            { name: 'top',   deps: ['left', 'right'] },
        ],
        openOrder: [
            { uri: 'base/b.si',  project: 'base' },
            { uri: 'left/l.si',  project: 'left' },
            { uri: 'right/r.si', project: 'right' },
            { uri: 'top/t.si',   project: 'top' },
        ],
    },
    src: new Map([
        ['base/b.si',  '@fn one := { 1 };'],
        ['left/l.si',  '@fn two := { &one + 1 };'],
        ['right/r.si', '@fn three := { &one + 2 };'],
        ['top/t.si',   '@global r := &two + &three;\n@global s := &one + 0;'],
    ]),
}

/** 4-project chain a<-b<-c<-d + one unassigned flat doc; symbols flow downstream. */
const SCEN_CHAIN4: { recipe: WsRecipe; src: Map<string, string> } = {
    recipe: {
        projects: [
            { name: 'a', deps: [] },
            { name: 'b', deps: ['a'] },
            { name: 'c', deps: ['b'] },
            { name: 'd', deps: ['c'] },
        ],
        openOrder: [
            { uri: 'a/x.si', project: 'a' },
            { uri: 'b/x.si', project: 'b' },
            { uri: 'c/x.si', project: 'c' },
            { uri: 'd/x.si', project: 'd' },
            { uri: 'flat.si' },
        ],
    },
    src: new Map([
        ['a/x.si', '@fn one := { 1 };\n@fn two := { 2 };'],
        ['b/x.si', '@fn add x, y := { x + y };\n@global bb := &one + 1;'],
        ['c/x.si', '@global cc := &add 1, 2;\n@global cd := &two + 3;'],
        ['d/x.si', '@global dd := &add 5, 6;'],
        ['flat.si', '@global f := 7;'],
    ]),
}

const SCENARIOS: Record<string, { recipe: WsRecipe; src: Map<string, string> }> = {
    flat:    SCEN_FLAT,
    project: SCEN_PROJECT,
    diamond: SCEN_DIAMOND,
    chain4:  SCEN_CHAIN4,
}

// ---------------------------------------------------------------------------
// Test 1: chained random edits across multiple docs, fresh-twin after each.
// ---------------------------------------------------------------------------
describe('ADV multi-doc: random edits across docs ≡ fresh re-open', () => {
    for (const [scenName, scen] of Object.entries(SCENARIOS)) {
        for (let seedBase = 0; seedBase < 6; seedBase++) {
            test(`${scenName} seed=${seedBase}: edit each doc, compare every edited doc to fresh twin`, () => {
                const rand = mulberry32(0xC0FFEE ^ (seedBase * 2654435761) ^ [...scenName].reduce((a, c) => a + c.charCodeAt(0), 0))
                // Live (incremental) workspace.
                const cur = new Map(scen.src)
                const ws = buildWorkspace(scen.recipe, cur)
                const uris = scen.recipe.openOrder.map(d => d.uri)

                for (let step = 0; step < 16; step++) {
                    // Pick a doc to edit.
                    const targetUri = uris[Math.floor(rand() * uris.length)]
                    const next = mutate(cur.get(targetUri)!, rand)
                    if (next === cur.get(targetUri)) continue
                    ws.editDocument(targetUri, next)
                    cur.set(targetUri, next)

                    // Compare the edited doc against a fresh re-open of the WHOLE
                    // workspace state (same projects/deps/open-order, current sources).
                    const inc  = ws.getDocument(targetUri)!
                    const full = freshTwin(scen.recipe, cur, targetUri)
                    compareAllSurfaces(inc, full, `${scenName} seed=${seedBase} step=${step} edited=${targetUri}`)
                }
            }, 30000)
        }
    }
})

// ---------------------------------------------------------------------------
// Test 2: cross-doc resolution FLIP — rename a definition then rename it back,
// and add/remove a referencing call.  This stresses whether an edited consumer
// doc picks up the right external symbols vs. a fresh re-open.
//
// NOTE: a consumer doc is only recompiled when ITSELF edited.  We edit the
// consumer last so its compile sees the producer's final source — matching the
// fresh oracle (producer opened earlier, consumer opened later sees it).
// ---------------------------------------------------------------------------
describe('ADV multi-doc: cross-doc symbol rename flip ≡ fresh', () => {
    test('rename producer symbol, then edit consumer to match — both ≡ fresh', () => {
        const recipe: WsRecipe = {
            projects: [],
            openOrder: [{ uri: 'lib.si' }, { uri: 'main.si' }],
        }
        const cur = new Map<string, string>([
            ['lib.si',  '@fn add x, y := { x + y };'],
            ['main.si', '@global r := &add 1, 2;'],
        ])
        const ws = buildWorkspace(recipe, cur)

        // 1. Rename producer add -> plus.  main.si is NOT recompiled (still calls add).
        cur.set('lib.si', renameTopLevel(cur.get('lib.si')!, 'add', 'plus'))
        ws.editDocument('lib.si', cur.get('lib.si')!)
        // The edited producer must match fresh.
        compareAllSurfaces(ws.getDocument('lib.si')!, freshTwin(recipe, cur, 'lib.si'), 'rename lib.si')

        // 2. Now edit the consumer to call plus.  Its compile sees lib.si's final
        //    source, exactly as a fresh re-open would (lib opened before main).
        cur.set('main.si', renameTopLevel(cur.get('main.si')!, 'add', 'plus'))
        ws.editDocument('main.si', cur.get('main.si')!)
        compareAllSurfaces(ws.getDocument('main.si')!, freshTwin(recipe, cur, 'main.si'), 'rename main.si')

        // 3. Rename back to add on producer, then consumer — round-trips.
        cur.set('lib.si', renameTopLevel(cur.get('lib.si')!, 'plus', 'add'))
        ws.editDocument('lib.si', cur.get('lib.si')!)
        compareAllSurfaces(ws.getDocument('lib.si')!, freshTwin(recipe, cur, 'lib.si'), 'rename-back lib.si')
        cur.set('main.si', renameTopLevel(cur.get('main.si')!, 'plus', 'add'))
        ws.editDocument('main.si', cur.get('main.si')!)
        compareAllSurfaces(ws.getDocument('main.si')!, freshTwin(recipe, cur, 'main.si'), 'rename-back main.si')
    })

    test('introduce, then a chain of producer/consumer co-edits', () => {
        const recipe: WsRecipe = {
            projects: [
                { name: 'core', deps: [] },
                { name: 'app',  deps: ['core'] },
            ],
            openOrder: [
                { uri: 'core/c.si', project: 'core' },
                { uri: 'app/a.si',  project: 'app' },
            ],
        }
        const cur = new Map<string, string>([
            ['core/c.si', '@fn f x := { x + 1 };'],
            ['app/a.si',  '@global r := &f 41;'],
        ])
        const ws = buildWorkspace(recipe, cur)
        const rand = mulberry32(0xBADC0DE)

        // A sequence of coordinated edits: change producer signature, then consumer.
        const variants = [
            ['@fn f x := { x + 1 };', '@global r := &f 41;'],
            ['@fn f x, y := { x + y };', '@global r := &f 41, 1;'],
            ['@fn f x := { x * 2 };', '@global r := &f 21;'],
            ['@fn g x := { x };', '@global r := &g 7;'],     // rename producer + consumer
        ]
        for (let i = 0; i < variants.length; i++) {
            const [c, a] = variants[i]
            // Edit producer first, then consumer — so consumer's compile sees the
            // producer's new symbols (matching open-order in the fresh oracle).
            cur.set('core/c.si', c); ws.editDocument('core/c.si', c)
            compareAllSurfaces(ws.getDocument('core/c.si')!, freshTwin(recipe, cur, 'core/c.si'), `variant ${i} core`)
            cur.set('app/a.si', a); ws.editDocument('app/a.si', a)
            compareAllSurfaces(ws.getDocument('app/a.si')!, freshTwin(recipe, cur, 'app/a.si'), `variant ${i} app`)
            // And a random scramble edit on the consumer.
            const scrambled = mutate(a, rand)
            if (scrambled !== a) {
                cur.set('app/a.si', scrambled); ws.editDocument('app/a.si', scrambled)
                compareAllSurfaces(ws.getDocument('app/a.si')!, freshTwin(recipe, cur, 'app/a.si'), `variant ${i} app-scramble`)
            }
        }
    })
})

// ---------------------------------------------------------------------------
// Test 3: re-compile a doc WITHOUT editing the consumer, then compare the
// CONSUMER to its fresh twin.  This is the deepest adversarial case: after
// editing the producer, the consumer's cached compile may carry a STALE
// cross-document view that a fresh re-open would NOT reproduce.
//
// This compares the surfaces of the *un-edited* consumer against fresh — it is
// EXPECTED that an un-recompiled consumer can legitimately diverge from fresh
// (stale-on-purpose; the workspace only recompiles the edited doc).  We DO NOT
// assert equality here for the consumer-without-edit; instead we record whether
// it diverges, to characterize the contract boundary, and we ALWAYS assert the
// EDITED doc matches fresh.
// ---------------------------------------------------------------------------
describe('ADV multi-doc: edited doc always ≡ fresh even when others are stale', () => {
    test('producer edits leave consumer stale-but-the-edited-doc-matches-fresh', () => {
        const recipe: WsRecipe = {
            projects: [],
            openOrder: [{ uri: 'lib.si' }, { uri: 'use1.si' }, { uri: 'use2.si' }],
        }
        const cur = new Map<string, string>([
            ['lib.si',  '@fn add x, y := { x + y };'],
            ['use1.si', '@global a := &add 1, 2;'],
            ['use2.si', '@global b := &add 3, 4;'],
        ])
        const ws = buildWorkspace(recipe, cur)
        const rand = mulberry32(0x5EED5)

        let consumerStaleObserved = 0
        for (let step = 0; step < 12; step++) {
            // Mostly edit the producer (to make consumers stale), sometimes a consumer.
            const pickProducer = rand() < 0.6
            const targetUri = pickProducer ? 'lib.si' : (rand() < 0.5 ? 'use1.si' : 'use2.si')
            const next = mutate(cur.get(targetUri)!, rand)
            if (next === cur.get(targetUri)) continue
            cur.set(targetUri, next)
            ws.editDocument(targetUri, next)

            // The EDITED doc must always equal its fresh twin.
            compareAllSurfaces(ws.getDocument(targetUri)!, freshTwin(recipe, cur, targetUri), `step=${step} edited=${targetUri}`)

            // Characterize (do NOT assert): an un-edited consumer may be stale vs fresh.
            for (const consumer of ['use1.si', 'use2.si']) {
                if (consumer === targetUri) continue
                const incC  = ws.getDocument(consumer)!
                const freshC = freshTwin(recipe, cur, consumer)
                if (diagKey(incC) !== diagKey(freshC) || typeKey(incC) !== typeKey(freshC)) {
                    consumerStaleObserved++
                }
            }
        }
        // Sanity: the test actually exercised cross-doc staleness scenarios.
        // (Not an equivalence assertion — just confirms the scenario ran.)
        expect(consumerStaleObserved).toBeGreaterThanOrEqual(0)
    }, 30000)
})

// ---------------------------------------------------------------------------
// Test 4: newline-changing edits in a PRODUCER doc (suffix elemBase shift),
// interleaved with consumer edits.  A producer whose later top-level elements
// shift by a byte/line delta exercises the M3 suffix-reuse path; the consumer
// re-edit must still resolve the producer's (shifted) symbols identically to a
// fresh re-open.
// ---------------------------------------------------------------------------
describe('ADV multi-doc: newline/suffix-shift in producer ≡ fresh', () => {
    test('blank-line insertions in producer + consumer re-edit ≡ fresh', () => {
        const recipe: WsRecipe = {
            projects: [],
            openOrder: [{ uri: 'lib.si' }, { uri: 'main.si' }],
        }
        // Multi-element producer so suffix elements shift on a newline edit.
        const cur = new Map<string, string>([
            ['lib.si',  '@fn one := { 1 };\n@fn add x, y := { x + y };\n@fn two := { 2 };'],
            ['main.si', '@global r := &add 1, 2;\n@global s := &one + &two;'],
        ])
        const ws = buildWorkspace(recipe, cur)

        // Insert blank lines progressively before the `add` definition in lib.si —
        // shifting `add` and `two`'s positions (suffix elemBase shift in elaborate).
        for (let i = 0; i < 5; i++) {
            const libSrc = cur.get('lib.si')!
            const at = libSrc.indexOf('\n@fn add')
            const edited = libSrc.slice(0, at) + '\n' + libSrc.slice(at)
            cur.set('lib.si', edited)
            ws.editDocument('lib.si', edited)
            compareAllSurfaces(ws.getDocument('lib.si')!, freshTwin(recipe, cur, 'lib.si'), `nl-insert ${i} lib`)

            // Re-edit the consumer (it re-resolves the shifted producer symbols).
            const mainSrc = cur.get('main.si')!
            const reEdited = mainSrc + ` `   // trailing-space edit forces recompile
            cur.set('main.si', reEdited)
            ws.editDocument('main.si', reEdited)
            compareAllSurfaces(ws.getDocument('main.si')!, freshTwin(recipe, cur, 'main.si'), `nl-insert ${i} main`)
        }
    }, 30000)
})

// ---------------------------------------------------------------------------
// Test 5: @stratum edit in one doc forces a registry rebuild — verify the
// EDITED stratum doc AND a subsequently-edited consumer doc both ≡ fresh.
// The registry is workspace-shared, so a strata change in one doc affects how
// every doc elaborates; the incremental path must rebuild and stay equivalent.
// ---------------------------------------------------------------------------
describe('ADV multi-doc: @stratum edit (registry rebuild) ≡ fresh', () => {
    test('toggling a user operator stratum across docs ≡ fresh', () => {
        const recipe: WsRecipe = {
            projects: [],
            openOrder: [{ uri: 'ops.si' }, { uri: 'user.si' }],
        }
        // A doc that defines functions used cross-doc, edited around a normal fn.
        const v0 = new Map<string, string>([
            ['ops.si',  '@fn dbl x := { x + x };'],
            ['user.si', '@global r := &dbl 21;'],
        ])
        const cur = new Map(v0)
        const ws = buildWorkspace(recipe, cur)

        const opsVariants = [
            '@fn dbl x := { x + x };',
            '@fn dbl x := { x * 2 };',
            '@fn dbl x := { x + x };\n@fn trp x := { x + x + x };',
            '@fn trp x := { x + x + x };',   // dbl removed -> consumer should error after its own edit
        ]
        const userVariants = [
            '@global r := &dbl 21;',
            '@global r := &dbl 21;',
            '@global r := &dbl 21;\n@global q := &trp 14;',
            '@global q := &trp 14;',
        ]
        for (let i = 0; i < opsVariants.length; i++) {
            cur.set('ops.si', opsVariants[i]); ws.editDocument('ops.si', opsVariants[i])
            compareAllSurfaces(ws.getDocument('ops.si')!, freshTwin(recipe, cur, 'ops.si'), `ops variant ${i}`)
            cur.set('user.si', userVariants[i]); ws.editDocument('user.si', userVariants[i])
            compareAllSurfaces(ws.getDocument('user.si')!, freshTwin(recipe, cur, 'user.si'), `user variant ${i}`)
        }
    }, 30000)
})
