/**
 * Registry Unit Tests
 *
 * Tests basic registry operations:
 * - Create empty registry
 * - Register and lookup operators/keywords
 * - Handle missing entries gracefully
 */

import {
    createElaboratorRegistry,
    registerElaborator,
    lookupOperator,
    lookupKeyword,
    listOperators,
    listKeywords,
    hasOperator,
    hasKeyword,
    mergeRegistries,
    type ElaboratorRegistry
} from './registry'
import { type StrataNode, StrataType } from './strataenum'

// Test fixture: create a dummy StrataNode for testing
function createTestOperatorNode(symbol: string): StrataNode {
    return {
        type: StrataType.Operator,
        discriminant: symbol,
        data: { test: true }
    }
}

function createTestKeywordNode(name: string): StrataNode {
    return {
        type: StrataType.Keyword,
        discriminant: name,
        data: { test: true }
    }
}

describe('Elaborator Registry', () => {
    describe('createElaboratorRegistry', () => {
        test('creates an empty registry', () => {
            const registry = createElaboratorRegistry()
            expect(registry.operators).toEqual({})
            expect(registry.keywords).toEqual({})
        })
    })

    describe('registerElaborator', () => {
        test('registers an operator', () => {
            const registry = createElaboratorRegistry()
            const node = createTestOperatorNode('+')
            registerElaborator(registry, 'operator', '+', node)
            expect(registry.operators['+']).toBe(node)
        })

        test('registers a keyword', () => {
            const registry = createElaboratorRegistry()
            const node = createTestKeywordNode('@fn')
            registerElaborator(registry, 'keyword', '@fn', node)
            expect(registry.keywords['@fn']).toBe(node)
        })

        test('overwrites same operator on re-registration', () => {
            const registry = createElaboratorRegistry()
            const node1 = createTestOperatorNode('+')
            const node2 = createTestOperatorNode('+')
            registerElaborator(registry, 'operator', '+', node1)
            registerElaborator(registry, 'operator', '+', node2)
            expect(registry.operators['+']).toBe(node2)
        })

        test('registers multiple operators', () => {
            const registry = createElaboratorRegistry()
            const plus = createTestOperatorNode('+')
            const minus = createTestOperatorNode('-')
            registerElaborator(registry, 'operator', '+', plus)
            registerElaborator(registry, 'operator', '-', minus)
            expect(registry.operators['+']).toBe(plus)
            expect(registry.operators['-']).toBe(minus)
        })
    })

    describe('lookupOperator', () => {
        test('returns registered operator', () => {
            const registry = createElaboratorRegistry()
            const node = createTestOperatorNode('+')
            registerElaborator(registry, 'operator', '+', node)
            expect(lookupOperator(registry, '+')).toBe(node)
        })

        test('returns undefined for unregistered operator', () => {
            const registry = createElaboratorRegistry()
            expect(lookupOperator(registry, '+')).toBeUndefined()
        })
    })

    describe('lookupKeyword', () => {
        test('returns registered keyword', () => {
            const registry = createElaboratorRegistry()
            const node = createTestKeywordNode('@fn')
            registerElaborator(registry, 'keyword', '@fn', node)
            expect(lookupKeyword(registry, '@fn')).toBe(node)
        })

        test('returns undefined for unregistered keyword', () => {
            const registry = createElaboratorRegistry()
            expect(lookupKeyword(registry, '@fn')).toBeUndefined()
        })
    })

    describe('listOperators', () => {
        test('returns empty list for empty registry', () => {
            const registry = createElaboratorRegistry()
            expect(listOperators(registry)).toEqual([])
        })

        test('lists all registered operators', () => {
            const registry = createElaboratorRegistry()
            registerElaborator(registry, 'operator', '+', createTestOperatorNode('+'))
            registerElaborator(registry, 'operator', '-', createTestOperatorNode('-'))
            registerElaborator(registry, 'operator', '*', createTestOperatorNode('*'))
            const ops = listOperators(registry)
            expect(ops).toHaveLength(3)
            expect(ops).toContain('+')
            expect(ops).toContain('-')
            expect(ops).toContain('*')
        })
    })

    describe('listKeywords', () => {
        test('returns empty list for empty registry', () => {
            const registry = createElaboratorRegistry()
            expect(listKeywords(registry)).toEqual([])
        })

        test('lists all registered keywords', () => {
            const registry = createElaboratorRegistry()
            registerElaborator(registry, 'keyword', '@fn', createTestKeywordNode('@fn'))
            registerElaborator(registry, 'keyword', '@let', createTestKeywordNode('@let'))
            const kws = listKeywords(registry)
            expect(kws).toHaveLength(2)
            expect(kws).toContain('@fn')
            expect(kws).toContain('@let')
        })
    })

    describe('hasOperator', () => {
        test('returns true for registered operator', () => {
            const registry = createElaboratorRegistry()
            registerElaborator(registry, 'operator', '+', createTestOperatorNode('+'))
            expect(hasOperator(registry, '+')).toBe(true)
        })

        test('returns false for unregistered operator', () => {
            const registry = createElaboratorRegistry()
            expect(hasOperator(registry, '+')).toBe(false)
        })
    })

    describe('hasKeyword', () => {
        test('returns true for registered keyword', () => {
            const registry = createElaboratorRegistry()
            registerElaborator(registry, 'keyword', '@fn', createTestKeywordNode('@fn'))
            expect(hasKeyword(registry, '@fn')).toBe(true)
        })

        test('returns false for unregistered keyword', () => {
            const registry = createElaboratorRegistry()
            expect(hasKeyword(registry, '@fn')).toBe(false)
        })
    })

    describe('mergeRegistries', () => {
        test('merges operators and keywords', () => {
            const reg1 = createElaboratorRegistry()
            registerElaborator(reg1, 'operator', '+', createTestOperatorNode('+'))
            registerElaborator(reg1, 'keyword', '@fn', createTestKeywordNode('@fn'))

            const reg2 = createElaboratorRegistry()
            registerElaborator(reg2, 'operator', '-', createTestOperatorNode('-'))
            registerElaborator(reg2, 'keyword', '@let', createTestKeywordNode('@let'))

            const merged = mergeRegistries(reg1, reg2)
            expect(hasOperator(merged, '+')).toBe(true)
            expect(hasOperator(merged, '-')).toBe(true)
            expect(hasKeyword(merged, '@fn')).toBe(true)
            expect(hasKeyword(merged, '@let')).toBe(true)
        })

        test('source overwrites target on conflicts', () => {
            const reg1 = createElaboratorRegistry()
            const node1 = createTestOperatorNode('+')
            registerElaborator(reg1, 'operator', '+', node1)

            const reg2 = createElaboratorRegistry()
            const node2 = createTestOperatorNode('+')
            registerElaborator(reg2, 'operator', '+', node2)

            const merged = mergeRegistries(reg1, reg2)
            expect(merged.operators['+']).toBe(node2)
        })

        test('does not mutate input registries', () => {
            const reg1 = createElaboratorRegistry()
            registerElaborator(reg1, 'operator', '+', createTestOperatorNode('+'))

            const reg2 = createElaboratorRegistry()
            registerElaborator(reg2, 'operator', '-', createTestOperatorNode('-'))

            const merged = mergeRegistries(reg1, reg2)
            expect(hasOperator(reg1, '-')).toBe(false)
            expect(hasOperator(reg2, '+')).toBe(false)
        })
    })
})
