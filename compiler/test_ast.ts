import { parse } from "./src/parser/index.ts";
import { addToAstSemantics } from "./src/ast/index.ts";
import { siliconGrammar } from "./src/grammar/index.ts";

const sourceCode = "1 + 2;";

try {
    const match = parse(sourceCode);
    console.log("Parse successful!");

    //Try toAst
    console.log("\nCalling toAst()...");
    const ast = addToAstSemantics(siliconGrammar)(match).toAst();
    console.log("AST result:");
    console.log(JSON.stringify(ast, null, 2));
} catch (error) {
    console.error("ERROR:", error);
}
