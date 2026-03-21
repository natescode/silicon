import { parse } from "./src/parser/index.ts";
import { addToAstSemantics } from "./src/ast/index.ts";
import { addCompileSemantics } from "./src/codegen/index.ts";
import { elaborate } from "./src/elaborator/index.ts";
import { siliconGrammar } from "./src/grammar/index.ts";

const sourceCode = "1 + 2;";

try {
    const match = parse(sourceCode);
    const ast = addToAstSemantics(siliconGrammar)(match).toAst();
    const elaboratedAST = elaborate(ast as any);
    const wat = addCompileSemantics(siliconGrammar)(match).compile();
    
    console.log("WAT output:");
    console.log(wat);
} catch (error) {
    console.error("ERROR:", error);
}
