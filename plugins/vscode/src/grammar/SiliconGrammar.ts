/**
 * Silicon Grammar Loader
 *
 * Loads and parses the Ohm grammar definition for Silicon.
 *
 * Runtime-agnostic: works under both bun and plain node because we
 * read the grammar via `fs.readFileSync` relative to this module's
 * own location.  Originally `Bun.file(...)` which kept the bundled
 * LSP from running under node — see silicon-vscode build pipeline.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ohm from 'ohm-js'

const __dir = dirname(fileURLToPath(import.meta.url))
const grammarSource = readFileSync(join(__dir, 'silicon-official.ohm'), 'utf-8')
const siliconGrammar = ohm.grammar(grammarSource)

export default siliconGrammar
