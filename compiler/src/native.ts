// SPDX-License-Identifier: MIT
/**
 * Silicon native backend (QBE) — public surface.
 *
 * Imported as `@silicon/compiler/native`.  Split from the main API because it
 * drives external toolchain binaries (`qbe`, `cc`) rather than being pure
 * in-process compilation: IR generation (`lowerToQbe`, `injectMainWrapper`)
 * plus the host drivers that locate/invoke/link them.
 */

export {
    // QBE IR generation (pure transforms).
    lowerToQbe,
    injectMainWrapper,
    defaultExePath,
    // Toolchain drivers (shell out to qbe / cc).
    findQbe,
    invokeQbe,
    hostQbeArch,
    downloadAndBuildQbe,
    QBE_INSTALL_HINT,
    findCc,
    link,
    CC_INSTALL_HINT,
} from './codegen/qbe'
