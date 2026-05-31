// SPDX-License-Identifier: MIT
/**
 * QBE IR post-processing — pure text transforms (no toolchain shelling).
 *
 * Injects a C-compatible `$main` wrapper into QBE IR when the Silicon source
 * did not define one.  Kept in the compiler (consumed by `compileToQbe`); the
 * toolchain drivers that assemble/link this IR live in the CLI package.
 */

/**
 * Check whether the QBE IR text already defines a `$main` function.
 */
export function hasQbeMain(qbeIr: string): boolean {
    return /function\s+\S*\s*\$main\s*\(/.test(qbeIr)
}

/**
 * Append a minimal C-compatible `main` wrapper to the QBE IR when the
 * Silicon source did not define one.
 *
 * The wrapper calls a designated entry function `$__sgl_entry` (which the
 * lowerer emits for top-level statements) if present, otherwise just returns 0.
 * If neither `$main` nor `$__sgl_entry` exists, the wrapper is a no-op.
 */
export function injectMainWrapper(qbeIr: string): string {
    if (hasQbeMain(qbeIr)) return qbeIr   // already present

    const hasEntry = /\$__sgl_entry\s*\(/.test(qbeIr)

    const wrapper = hasEntry
        ? [
            '',
            '# sgl-injected main wrapper',
            'export function w $main() {',
            '@start',
            '\tcall $__sgl_entry()',
            '\tret 0',
            '}',
          ].join('\n')
        : [
            '',
            '# sgl-injected main wrapper',
            'export function w $main() {',
            '@start',
            '\tret 0',
            '}',
          ].join('\n')

    return qbeIr + wrapper
}
