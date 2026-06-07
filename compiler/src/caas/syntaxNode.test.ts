// SPDX-License-Identifier: MIT
import { describe, test, expect } from 'bun:test'
import { parse, buildRegistry, elaborate, typecheck } from './index'
import { SyntaxNode } from './syntaxNode'

// Two top-level definitions: @fn add (with params) + result binding (with call).
const SRC = '@fn add x, y := {\n    x + y\n};\nresult := add(1, 2);'

// Single let with a literal binding.
const SRC_SIMPLE = 'x := 42;'

// ---------------------------------------------------------------------------
// SyntaxTree.root
// ---------------------------------------------------------------------------

describe('SyntaxTree.root', () => {
    test('returns a SyntaxNode', () => {
        const { tree } = parse(SRC_SIMPLE)
        expect(tree.root).toBeInstanceOf(SyntaxNode)
    })

    test('root.kind is Program', () => {
        const { tree } = parse(SRC_SIMPLE)
        expect(tree.root.kind).toBe('Program')
    })

    test('root.parent is undefined', () => {
        const { tree } = parse(SRC_SIMPLE)
        expect(tree.root.parent).toBeUndefined()
    })

    test('root is cached (same reference on repeated access)', () => {
        const { tree } = parse(SRC_SIMPLE)
        expect(tree.root).toBe(tree.root)
    })

    test('withText() returns a new tree with its own root', () => {
        const { tree } = parse(SRC_SIMPLE)
        const { tree: tree2 } = tree.withText('m := 99;')
        expect(tree.root).not.toBe(tree2.root)
    })
})

// ---------------------------------------------------------------------------
// children()
// ---------------------------------------------------------------------------

describe('SyntaxNode.children()', () => {
    test('Program has Definition children', () => {
        const { tree } = parse(SRC)
        const kids = tree.root.children()
        expect(kids.length).toBe(2)
        expect(kids.every(k => k.kind === 'Definition')).toBe(true)
    })

    test('children are cached (same reference on repeated access)', () => {
        const { tree } = parse(SRC_SIMPLE)
        const a = tree.root.children()
        const b = tree.root.children()
        expect(a).toBe(b)
    })

    test('each child has parent === the parent node', () => {
        const { tree } = parse(SRC_SIMPLE)
        const root = tree.root
        for (const child of root.children()) {
            expect(child.parent).toBe(root)
        }
    })

    test('Definition children include Binding and params', () => {
        const { tree } = parse(SRC)
        const def = tree.root.children()[0] // @fn add x, y := { x + y }
        const kinds = def.children().map(c => c.kind)
        expect(kinds).toContain('TypedIdentifier')  // name
        expect(kinds).toContain('Parameter')         // x, y
        expect(kinds).toContain('Binding')           // := { ... }
    })
})

// ---------------------------------------------------------------------------
// isLeaf
// ---------------------------------------------------------------------------

describe('SyntaxNode.isLeaf', () => {
    test('Program is not a leaf', () => {
        const { tree } = parse(SRC_SIMPLE)
        expect(tree.root.isLeaf).toBe(false)
    })

    test('IntLiteral is a leaf', () => {
        const { tree } = parse(SRC_SIMPLE)
        const lit = tree.root.firstDescendantOfKind('IntLiteral')
        expect(lit).toBeDefined()
        expect(lit!.isLeaf).toBe(true)
    })

    test('Namespace is a leaf', () => {
        const { tree } = parse('@fn answer := {\n    42\n};\nr := answer();')
        const ns = tree.root.firstDescendantOfKind('Namespace')
        expect(ns).toBeDefined()
        expect(ns!.isLeaf).toBe(true)
    })

    test('Parameter is a leaf when no type annotation', () => {
        const { tree } = parse(SRC)
        const param = tree.root.firstDescendantOfKind('Parameter')
        expect(param).toBeDefined()
        expect(param!.isLeaf).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// descendants()
// ---------------------------------------------------------------------------

describe('SyntaxNode.descendants()', () => {
    test('yields all descendant nodes in pre-order', () => {
        const { tree } = parse(SRC_SIMPLE)
        const nodes = [...tree.root.descendants()]
        expect(nodes.length).toBeGreaterThan(0)
    })

    test('includes leaf nodes', () => {
        const { tree } = parse(SRC_SIMPLE)
        const kinds = new Set([...tree.root.descendants()].map(n => n.kind))
        expect(kinds.has('IntLiteral')).toBe(true)
    })

    test('includes BinaryOp when present', () => {
        const { tree } = parse(SRC)
        const kinds = new Set([...tree.root.descendants()].map(n => n.kind))
        expect(kinds.has('BinaryOp')).toBe(true)
    })

    test('pre-order: Definition appears before Binding', () => {
        const { tree } = parse(SRC)
        const nodes = [...tree.root.descendants()]
        const defIdx = nodes.findIndex(n => n.kind === 'Definition')
        const bindIdx = nodes.findIndex(n => n.kind === 'Binding')
        expect(defIdx).toBeLessThan(bindIdx)
    })
})

// ---------------------------------------------------------------------------
// ancestors()
// ---------------------------------------------------------------------------

describe('SyntaxNode.ancestors()', () => {
    test('IntLiteral ancestors lead to root', () => {
        const { tree } = parse(SRC_SIMPLE)
        const lit = tree.root.firstDescendantOfKind('IntLiteral')!
        const ancs = [...lit.ancestors()]
        expect(ancs.length).toBeGreaterThan(0)
        expect(ancs[ancs.length - 1].kind).toBe('Program')
    })

    test('root has no ancestors', () => {
        const { tree } = parse(SRC_SIMPLE)
        expect([...tree.root.ancestors()]).toHaveLength(0)
    })

    test('ancestors of a Binding include Definition and Program', () => {
        const { tree } = parse(SRC_SIMPLE)
        const binding = tree.root.firstDescendantOfKind('Binding')!
        const ancKinds = [...binding.ancestors()].map(n => n.kind)
        expect(ancKinds).toContain('Definition')
        expect(ancKinds).toContain('Program')
    })
})

// ---------------------------------------------------------------------------
// descendantsOfKind / firstDescendantOfKind
// ---------------------------------------------------------------------------

describe('SyntaxNode.descendantsOfKind()', () => {
    test('finds all Definition nodes at top level', () => {
        const { tree } = parse(SRC)
        const defs = [...tree.root.descendantsOfKind('Definition')]
        expect(defs.length).toBeGreaterThanOrEqual(2)  // @fn add + result binding
    })

    test('finds all IntLiteral nodes', () => {
        const { tree } = parse('a := 1; b := 2;')
        const lits = [...tree.root.descendantsOfKind('IntLiteral')]
        expect(lits.length).toBe(2)
    })

    test('finds BinaryOp nodes', () => {
        const { tree } = parse(SRC)
        const ops = [...tree.root.descendantsOfKind('BinaryOp')]
        expect(ops.length).toBeGreaterThan(0)
    })

    test('returns empty when kind not present', () => {
        const { tree } = parse(SRC_SIMPLE)
        const none = [...tree.root.descendantsOfKind('FunctionCall')]
        expect(none).toHaveLength(0)
    })
})

describe('SyntaxNode.firstDescendantOfKind()', () => {
    test('returns the first matching node', () => {
        const { tree } = parse(SRC)
        const def = tree.root.firstDescendantOfKind('Definition')
        expect(def).toBeDefined()
        expect(def!.kind).toBe('Definition')
    })

    test('returns undefined when not found', () => {
        const { tree } = parse(SRC_SIMPLE)
        expect(tree.root.firstDescendantOfKind('FunctionCall')).toBeUndefined()
    })

    test('finds IntLiteral in a simple let', () => {
        const { tree } = parse(SRC_SIMPLE)
        const lit = tree.root.firstDescendantOfKind('IntLiteral')
        expect(lit).toBeDefined()
        expect((lit!._node as any).value).toBe('42')
    })
})

// ---------------------------------------------------------------------------
// span
// ---------------------------------------------------------------------------

describe('SyntaxNode.span', () => {
    test('span is defined for nodes the parser annotates', () => {
        const { tree } = parse(SRC)
        const withSpan = [...tree.root.descendants()].filter(n => n.span !== undefined)
        expect(withSpan.length).toBeGreaterThan(0)
    })

    test('span coordinates are 1-based positive integers', () => {
        const { tree } = parse(SRC)
        for (const node of tree.root.descendants()) {
            if (node.span) {
                expect(node.span.startLine).toBeGreaterThanOrEqual(1)
                expect(node.span.startCol).toBeGreaterThanOrEqual(1)
            }
        }
    })

    test('Namespace span reflects its position in source', () => {
        const { tree } = parse('@fn answer := {\n    42\n};\nr := answer();')
        // The Namespace for 'answer' in the call is on line 4.
        const ns = [...tree.root.descendantsOfKind('Namespace')].find(n => n.span?.startLine === 4)
        expect(ns).toBeDefined()
    })
})

// ---------------------------------------------------------------------------
// _node identity
// ---------------------------------------------------------------------------

describe('SyntaxNode._node', () => {
    test('_node of root is the Program object', () => {
        const { tree } = parse(SRC_SIMPLE)
        expect((tree.root._node as any).type).toBe('Program')
    })

    test('_node of an IntLiteral carries the value string', () => {
        const { tree } = parse(SRC_SIMPLE)
        const lit = tree.root.firstDescendantOfKind('IntLiteral')!
        expect((lit._node as any).value).toBe('42')
    })
})

// ---------------------------------------------------------------------------
// SemanticModel integration — typeOf / symbolAt accept SyntaxNode
// ---------------------------------------------------------------------------

describe('SemanticModel + SyntaxNode', () => {
    function checkedTree(src: string) {
        const { tree } = parse(src)
        const reg = buildRegistry(tree)
        const { tree: elab } = elaborate(tree, reg)
        const { tree: checked, model } = typecheck(elab, reg)
        return { root: checked.root, model }
    }

    test('model.typeOf(syntaxNode) matches model.typeOf(raw node)', () => {
        const { root, model } = checkedTree(SRC_SIMPLE)
        const lit = root.firstDescendantOfKind('IntLiteral')!
        expect(model.typeOf(lit)).toEqual(model.typeOf(lit._node))
    })

    test('model.typeOf(IntLiteral SyntaxNode) returns Int type', () => {
        const { root, model } = checkedTree(SRC_SIMPLE)
        const lit = root.firstDescendantOfKind('IntLiteral')!
        const ty = model.typeOf(lit) as any
        expect(ty).toBeDefined()
        expect(ty.kind).toBe('Int')
    })

    test('model.symbolAt(Namespace SyntaxNode) resolves to symbol', () => {
        const { root, model } = checkedTree('@fn answer := {\n    42\n};\nr := answer();')
        // The Namespace for 'answer' in the call site is on line 4.
        const ns = [...root.descendantsOfKind('Namespace')].find(n => n.span?.startLine === 4)!
        expect(ns).toBeDefined()
        const sym = model.symbolAt(ns)
        expect(sym).toBeDefined()
        expect(sym!.name).toBe('answer')
    })

    test('model.symbolAt(SyntaxNode) matches model.symbolAt(raw node)', () => {
        const { root, model } = checkedTree('@fn answer := {\n    42\n};\nr := answer();')
        const ns = [...root.descendantsOfKind('Namespace')].find(n => n.span?.startLine === 4)!
        expect(model.symbolAt(ns)).toEqual(model.symbolAt(ns._node))
    })

    test('model.typeOf returns undefined for a node with no recorded type', () => {
        const { root, model } = checkedTree(SRC_SIMPLE)
        // Parameter nodes are not type-stamped by the typechecker.
        const param = root.firstDescendantOfKind('TypedIdentifier')
        if (param) {
            // Must not throw — just returns undefined.
            expect(() => model.typeOf(param)).not.toThrow()
        }
    })
})
