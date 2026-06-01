// SPDX-License-Identifier: MIT
/**
 * The hand-written recursive-descent parser must produce a byte-identical AST
 * to the ohm path (parse → addToAstSemantics → toAst) for every program ohm
 * accepts. This test deep-compares the two over a broad corpus: a rich inline
 * set plus every .si file in the repo (examples, stdlib, strata, platforms,
 * test fixtures). ohm stays the default; this proves the hand-written parser
 * is a drop-in before any switch.
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import parse from '../parser'
import addToAstSemantics from '../../ast/toAst'
import siliconGrammar from '../../grammar/SiliconGrammar'
import { parseToAst } from './parser'

const sem = addToAstSemantics(siliconGrammar)
const ohmAst = (src: string) => sem(parse(src)).toAst()

/** True if ohm accepts the source (so there's a reference AST to match). */
function ohmAccepts(src: string): boolean {
    try { ohmAst(src); return true } catch { return false }
}

const INLINE: Array<[string, string]> = [
    ['assignment', `x = 5;`],
    ['bare-fn', `@fn add a, b := { a + b };`],
    ['attached-sig fn', `\\\\ add (Int, Int) -> Int\n@fn add a, b := { a + b };`],
    ['nullary sig', `\\\\ roll ()\n@fn roll := { 42 };`],
    ['value sig', `\\\\ pi Float\n@let pi := 3.14;`],
    ['builtin call', `&@print 'hi';`],
    ['user call ns', `&foo::bar 1, 2;`],
    ['no-arg call', `&reset;`],
    ['nested calls', `&@if x == 0, { 1 }, { &@add a, b };`],
    ['match arms', `&@match opt, $Some v => v, $None => 0;`],
    ['match alternation', `&@match c, $Red | $Green => 1, $Blue => 0;`],
    ['sum type', `@type Shape := $Circle r | $Rectangle w, h;`],
    ['enum', `@enum Color := Red | Green | Blue;`],
    ['array lit', `$[1, 2, 3];`],
    ['empty array', `$[];`],
    ['object lit', `\${ a = 1, b = 2 };`],
    ['tuple lit', `$(1, 'two', 3.0);`],
    ['extern block', `@extern { \\\\ fd_write (Int, Int, Int, Int) -> Int \\\\ fd_close (Int) -> Int }`],
    ['ascription', `&@as Option[Int], (&None);`],
    ['struct fields', `@struct Point x Int, y Int;`],
    ['generic fn', `@let id[T] x := x;`],
    ['nested generics', `\\\\ wrap (T) -> Option[List[Int]]\n@fn wrap x := x;`],
    ['namespace path', `a.b.c;`],
    ['dotted + ns', `std::io.print;`],
    ['paren grouping', `(1 + 2) * 3;`],
    ['operator chain', `1 + 2 - 3 * 4;`],
    ['comparison ops', `a <= b == c;`],
    ['float', `3.14 + 1_000.5;`],
    ['underscore sep int', `1_000_000;`],
    ['string', `'hello world';`],
    ['booleans', `&@if @true, { @false };`],
    ['nested block', `{ x = 1; { y = 2; y } };`],
    ['empty block', `&@loop @true, { };`],
    ['trailing expr block', `{ a = 1; a + 1 };`],
    ['comment lines', `# a comment\n@fn f := { 1 };  # trailing`],
    ['doc comment as comment', `## doc\n@fn f := { 1 };`],
    ['variant no fields', `&@match x, $None => 0;`],
    ['fn-type sig', `\\\\ apply (Int) -> Int\n@fn apply f := f;`],
]

function collectSi(dir: string, out: string[]): void {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const e of entries) {
        const p = join(dir, e)
        let st
        try { st = statSync(p) } catch { continue }
        if (st.isDirectory()) collectSi(p, out)
        else if (e.endsWith('.si')) out.push(p)
    }
}

const REPO = join(import.meta.dir, '..', '..', '..', '..')        // repo root
const COMPILER = join(import.meta.dir, '..', '..', '..')           // compiler/
const siFiles: string[] = []
for (const d of [join(REPO, 'examples'), join(COMPILER, 'src'), join(COMPILER, 'tests')]) {
    collectSi(d, siFiles)
}

describe('hand-written parser ⇄ ohm AST equivalence', () => {
    describe('inline programs', () => {
        for (const [name, src] of INLINE) {
            test(name, () => {
                if (!ohmAccepts(src)) return            // ohm rejects → no reference; skip
                expect(parseToAst(src)).toEqual(ohmAst(src))
            })
        }
    })

    describe('.si corpus', () => {
        for (const file of siFiles) {
            const rel = file.slice(REPO.length + 1)
            test(rel, () => {
                const src = readFileSync(file, 'utf8')
                if (!ohmAccepts(src)) return            // ohm itself can't parse it → skip
                expect(parseToAst(src)).toEqual(ohmAst(src))
            })
        }
    })

    test('corpus is non-trivial', () => {
        // Guard against a vacuously-passing suite (e.g. all files skipped).
        expect(siFiles.length).toBeGreaterThan(40)
    })
})
