export { lowerProgram, IRLowerError } from './lower'
export { emitModule, emitExpr, emitStmt } from './emit'
export type {
    WasmValType, WasmType,
    IRModule, IRFunction, IRGlobal, IRImport, IRDataSegment, IRExport,
    IRExpr, IRStmt, IRParam, IRLocal,
    IRConst, IRLocalGet, IRGlobalGet, IRBinOp, IRCall,
    IRBlock, IRIf, IRLoop, IRBreak, IRContinue, IRReturn, IRNop,
    IRLocalSet, IRGlobalSet, IRExprStmt,
} from './nodes'
