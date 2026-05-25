/**
 * QBE type system and Silicon → QBE type mapping.
 *
 * QBE base types used by Silicon:
 *   w  — word     (32-bit integer; Silicon Int, Bool, u8/u16/u32, pointers on 32-bit)
 *   l  — long     (64-bit integer; Silicon Int64, u64)
 *   s  — single   (32-bit float;   Silicon Float)
 *
 * This module is the single source of truth for type decisions in the QBE
 * lowering pass. No WasmValType or wasmTypeOf() here — we reason about
 * SiliconType directly.
 */

import type { SiliconType } from '../../types/types'

export type QbeType = 'w' | 'l' | 's'
export type QbeReturnType = QbeType | 'void'

/**
 * Map a SiliconType to its QBE base type.
 *
 * String and Array are pointer-sized — 'w' for the current 32-bit flat-memory
 * model (matching the WASM32 target). When a 64-bit native target is added,
 * this becomes 'l' for pointer kinds.
 *
 * Returns 'w' for unknown / unresolved types so callers always get a valid
 * QBE type and the compiler produces output even for partially-typed programs.
 */
export function siliconTypeToQbe(t: SiliconType | undefined): QbeType {
    if (!t) return 'w'
    switch (t.kind) {
        case 'Int':    return 'w'
        case 'Int64':  return 'l'
        case 'Float':  return 's'
        case 'Bool':   return 'w'
        case 'String': return 'w'   // pointer
        case 'Array':  return 'w'   // pointer
        case 'UInt8':  return 'w'
        case 'UInt16': return 'w'
        case 'UInt32': return 'w'
        case 'UInt64': return 'l'
        case 'Sum':    return 'w'   // tag word; payloads via heap pointer
        case 'Distinct': return siliconTypeToQbe(t.underlying)
        case 'Function': return 'w' // funcref table index
        case 'Void':     return 'w' // should not appear in value position
        case 'Variable': return 'w' // unresolved generic — best effort
        case 'Unknown':  return 'w'
    }
}

export function siliconTypeToQbeReturn(t: SiliconType | undefined): QbeReturnType {
    if (!t || t.kind === 'Void' || t.kind === 'Unknown') return 'void'
    return siliconTypeToQbe(t)
}

// ---------------------------------------------------------------------------
// Operator → QBE instruction mapping
//
// The strata registry resolves operators to their intrinsic names at the WAT
// level (e.g. '+' on Int → 'i32.add').  The QBE lowerer reads the intrinsic
// name returned by lookupTypedOperator and converts it here — never storing
// the WAT string in any intermediate node.
//
// Key: the WAT instruction string from the strata registry.
// Value: the QBE instruction mnemonic.
// ---------------------------------------------------------------------------

const WAT_TO_QBE_INSTR: Record<string, string> = {
    // i32 arithmetic
    'i32.add':   'add',  'i32.sub':   'sub',  'i32.mul':   'mul',
    'i32.div_s': 'div',  'i32.div_u': 'udiv',
    'i32.rem_s': 'rem',  'i32.rem_u': 'urem',
    // i32 bitwise
    'i32.and':   'and',  'i32.or':    'or',   'i32.xor':   'xor',
    'i32.shl':   'shl',  'i32.shr_s': 'sar',  'i32.shr_u': 'shr',
    // i32 comparisons → result is always 'w' (0 or 1)
    'i32.eq':    'ceqw', 'i32.ne':    'cnew',
    'i32.lt_s':  'csltw','i32.gt_s':  'csgtw',
    'i32.le_s':  'cslew','i32.ge_s':  'csgew',
    'i32.lt_u':  'cultw','i32.gt_u':  'cugtw',
    'i32.le_u':  'culew','i32.ge_u':  'cugew',

    // i64 arithmetic
    'i64.add':   'add',  'i64.sub':   'sub',  'i64.mul':   'mul',
    'i64.div_s': 'div',  'i64.div_u': 'udiv',
    'i64.rem_s': 'rem',  'i64.rem_u': 'urem',
    // i64 bitwise
    'i64.and':   'and',  'i64.or':    'or',   'i64.xor':   'xor',
    'i64.shl':   'shl',  'i64.shr_s': 'sar',  'i64.shr_u': 'shr',
    // i64 comparisons → result is 'w'
    'i64.eq':    'ceql', 'i64.ne':    'cnel',
    'i64.lt_s':  'csltl','i64.gt_s':  'csgtl',
    'i64.le_s':  'cslel','i64.ge_s':  'csgel',

    // f32 arithmetic (QBE appends 's' for single-precision)
    'f32.add':   'adds', 'f32.sub':   'subs',
    'f32.mul':   'muls', 'f32.div':   'divs',
    // f32 comparisons → result is 'w'
    'f32.eq':    'ceqs', 'f32.ne':    'cnes',
    'f32.lt':    'clts', 'f32.gt':    'cgts',
    'f32.le':    'cles', 'f32.ge':    'cges',
}

/**
 * Convert a WAT instruction name (as returned by the strata registry's
 * intrinsic field) to the equivalent QBE instruction mnemonic.
 *
 * Returns undefined for instructions with no QBE equivalent (memory ops,
 * type casts, WASM-specific instructions) — callers should emit a TODO
 * placeholder and continue.
 */
export function watInstrToQbeInstr(watInstr: string): string | undefined {
    return WAT_TO_QBE_INSTR[watInstr]
}

// ---------------------------------------------------------------------------
// Direct (operator, typeKind) → QBE instruction lookup
//
// Strata 2.0 operators use on::lower handlers — the strata registry no longer
// stores WAT intrinsic strings in stratum.data.intrinsic for them.  The QBE
// lowerer must resolve operator→instruction independently of the WASM IR path.
//
// Result type ('qt') is the type of the instruction's *result* in QBE.
// Comparisons always return 'w' regardless of operand width.
// ---------------------------------------------------------------------------

interface QbeOpEntry { instr: string; qt: QbeType }

const INT_OPS: Record<string, QbeOpEntry> = {
    '+':  { instr: 'add',   qt: 'w' }, '-':  { instr: 'sub',   qt: 'w' },
    '*':  { instr: 'mul',   qt: 'w' }, '/':  { instr: 'div',   qt: 'w' },
    '%':  { instr: 'rem',   qt: 'w' }, '|':  { instr: 'or',    qt: 'w' },
    '^':  { instr: 'xor',   qt: 'w' }, '<<': { instr: 'shl',   qt: 'w' },
    '>>': { instr: 'sar',   qt: 'w' },
    '==': { instr: 'ceqw',  qt: 'w' }, '!=': { instr: 'cnew',  qt: 'w' },
    '<':  { instr: 'csltw', qt: 'w' }, '>':  { instr: 'csgtw', qt: 'w' },
    '<=': { instr: 'cslew', qt: 'w' }, '>=': { instr: 'csgew', qt: 'w' },
}

const INT64_OPS: Record<string, QbeOpEntry> = {
    '+':  { instr: 'add',   qt: 'l' }, '-':  { instr: 'sub',   qt: 'l' },
    '*':  { instr: 'mul',   qt: 'l' }, '/':  { instr: 'div',   qt: 'l' },
    '%':  { instr: 'rem',   qt: 'l' }, '|':  { instr: 'or',    qt: 'l' },
    '^':  { instr: 'xor',   qt: 'l' }, '<<': { instr: 'shl',   qt: 'l' },
    '>>': { instr: 'sar',   qt: 'l' },
    '==': { instr: 'ceql',  qt: 'w' }, '!=': { instr: 'cnel',  qt: 'w' },
    '<':  { instr: 'csltl', qt: 'w' }, '>':  { instr: 'csgtl', qt: 'w' },
    '<=': { instr: 'cslel', qt: 'w' }, '>=': { instr: 'csgel', qt: 'w' },
}

const FLOAT_OPS: Record<string, QbeOpEntry> = {
    '+':  { instr: 'adds', qt: 's' }, '-':  { instr: 'subs', qt: 's' },
    '*':  { instr: 'muls', qt: 's' }, '/':  { instr: 'divs', qt: 's' },
    '==': { instr: 'ceqs', qt: 'w' }, '!=': { instr: 'cnes', qt: 'w' },
    '<':  { instr: 'clts', qt: 'w' }, '>':  { instr: 'cgts', qt: 'w' },
    '<=': { instr: 'cles', qt: 'w' }, '>=': { instr: 'cges', qt: 'w' },
}

export function lookupOpToQbe(op: string, typeKind: string): QbeOpEntry | undefined {
    switch (typeKind) {
        case 'Float':                         return FLOAT_OPS[op]
        case 'Int64': case 'UInt64':          return INT64_OPS[op]
        default:                              return INT_OPS[op]
    }
}
