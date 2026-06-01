// SPDX-License-Identifier: MIT
// Browser variant of grammarSource.ts — returns the inlined grammar, no fs.
import { GRAMMAR } from '../assets.generated'

export function loadGrammarSource(): string {
    return GRAMMAR
}
