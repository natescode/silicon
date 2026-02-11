import parse from './parser'
import addToAstSemantics from './toAst'
import addCompileSemantics from './compile'
import siliconGrammar from './SiliconGrammar'

console.log('Silicon v2024.01')

// Test code
const sourceCode = `&@loop 1..4, @fn foo:i32 index:i32, value:i32 = 1;;`

// Pipeline: parse → AST → compile
const match = parse(sourceCode)
const ast = addToAstSemantics(siliconGrammar)(match).toAst()
const wat = addCompileSemantics(siliconGrammar)(match).compile()

// Output artifacts
await Bun.write('ast.json', JSON.stringify(ast, null, 2))
await Bun.write('main.wat', wat)

console.log('AST:', JSON.stringify(ast, null, 2))