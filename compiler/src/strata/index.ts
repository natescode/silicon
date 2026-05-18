import { readdirSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Built-in strata .si files were moved from src/strata/ to
// boot/strata/builtin/ so the bootstrap tree owns the source of truth
// and a Silicon-side regenerator can rebuild boot/embedded_bundle.si
// without needing this TS loader.  Stage 0 reads from the new path
// here so both pipelines share one canonical source.
const BUILTIN_STRATA_DIR = join(__dirname, '../../boot/strata/builtin')

/**
 * Load all builtin strata from .si files in boot/strata/builtin/.
 * Any .si file dropped there is automatically registered — no explicit list needed.
 */
export function loadBuiltinStrata(): string {
    const files = readdirSync(BUILTIN_STRATA_DIR)
        .filter(f => f.endsWith('.si'))
        .sort()
    return files.map(f => readFileSync(join(BUILTIN_STRATA_DIR, f), 'utf-8')).join('\n')
}
