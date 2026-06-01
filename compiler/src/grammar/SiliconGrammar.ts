// SPDX-License-Identifier: MIT
/**
 * Silicon Grammar Loader
 *
 * Loads and parses the Ohm grammar definition for Silicon.
 *
 * The grammar (silicon-official.ohm) defines the syntax rules for the Silicon
 * programming language. This module loads the grammar file and compiles it into
 * an Ohm Grammar object that can be used for parsing.
 *
 * @see silicon-official.ohm - Grammar rule definitions
 */

import * as ohm from 'ohm-js'
import { loadGrammarSource } from './grammarSource'

// The grammar source is read synchronously through grammarSource.ts so this
// module has no top-level await and no Bun-/Node-specific API on its surface.
// Browser builds alias grammarSource → grammarSource.browser (inlined string);
// the Bun/Node toolchain reads silicon-official.ohm from disk.
const siliconGrammar = ohm.grammar(loadGrammarSource())

export default siliconGrammar