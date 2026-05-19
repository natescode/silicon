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

const grammarSource = Bun.file('./src/grammar/silicon-official.ohm')
const siliconGrammar = ohm.grammar(await grammarSource.text())

export default siliconGrammar