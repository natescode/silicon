// SPDX-License-Identifier: MIT
/**
 * Silicon Compiler — public library API.
 *
 * Import from here instead of internal sub-modules.
 *
 *   import { compile, parse, elaborate, typecheck, lower, buildRegistry } from './src/api'
 *
 * See src/caas/index.ts for full type documentation.
 */

export {
    // Pipeline functions
    parse,
    elaborate,
    typecheck,
    lower,
    compile,
    check,
    buildRegistry,

    // SyntaxTree class (has .withText() for incremental reparse, .root for tree walking)
    SyntaxTree,

    // SyntaxNode — walkable wrapper around any AST node (CaaS tree walking)
    SyntaxNode,

    // Incremental text changes
    type TextChange,
    applyTextChanges,

    // CaaS-2e trivia
    type TriviaItem,

    // CaaS-2f tree visitors
    SyntaxWalker,
    SyntaxRewriter,

    // CaaS-2b code action codes
    listCodeActionCodes,
} from './caas/index'

export {
    // Workspace — multi-document project state (CaaS-4)
    Workspace,
    // Project layer — named, dependency-scoped document groups (CaaS tracker 3a)
    Project,
    type ProjectOptions,
    type Document,
    type DocumentChangeEvent,
    type ChangeListener,
    type WorkspaceOptions,
    // LSP Tier 1 return types
    type HoverInfo,
    type CompletionItem,
    type ParameterInfo,
    type SignatureHelp,
    WorkspaceEdit,
    type CancellableOptions,
} from './caas/workspace'

export {
    // Metadata references — precompiled library symbol surfaces (CaaS tracker 3c)
    MetadataReference,
    type SymbolManifest,
    type ManifestSymbol,
    serializeManifest,
    parseManifest,
} from './caas/metadataReference'

export { typeDisplayString, symbolDisplayString } from './ast/semanticModel'

export {
    // Result types
    type ParseResult,
    type ElabResult,
    type CheckResult,
    type LowerResult,
    type CompileResult,

    // Option types
    type ParseOptions,
    type ElabOptions,
    type CheckOptions,
    type LowerOptions,

    // Shared types
    type ElaboratorRegistry,
    type Diagnostic,
    type SourceSpan,
    type Phase,
    type SemanticModel,
    type CaaSSymbol,
    type SymbolKind,
    type SourceRange,
    type SiliconType,
} from './caas/index'

// ---------------------------------------------------------------------------
// Build / codegen surface consumed by the CLI and other tools.
// (Promoted to the public API as part of the standalone-CLI extraction.)
// ---------------------------------------------------------------------------

export {
    // Wasm binary emit + the lowering target type.
    compileToWasm,
    type LowerTarget,
} from './codegen'

// Module-graph resolution (front-end: `@use` includes + module registry).
export { resolveUses } from './modules/useResolver'
export { loadModules } from './modules'

// Diagnostic rendering.
export { renderJson, renderPretty } from './errors/diagnostic'

// Source formatter.
export { formatProgram } from './fmt/formatter'
