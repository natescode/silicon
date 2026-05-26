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
    buildRegistry,

    // SyntaxTree class (has .withText() for incremental reparse)
    SyntaxTree,
} from './caas/index'

export {
    // Workspace — multi-document project state (CaaS-4)
    Workspace,
    type Document,
    type DocumentChangeEvent,
    type ChangeListener,
    type WorkspaceOptions,
} from './caas/workspace'

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
