import { readdirSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Load all builtin strata from .si files in this directory.
 * Any .si file dropped here is automatically registered — no explicit list needed.
 */
export function loadBuiltinStrata(): string {
    const files = readdirSync(__dirname)
        .filter(f => f.endsWith('.si'))
        .sort()
    return files.map(f => readFileSync(join(__dirname, f), 'utf-8')).join('\n')
}
