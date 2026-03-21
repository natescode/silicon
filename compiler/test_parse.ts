import { parse } from "./src/parser/index.ts";

const sourceCode = "1 + 2;";

try {
    const match = parse(sourceCode);
    console.log("Parse successful!");
    console.log("Match type:", match.constructor.name);
    console.log("Match toString():", match.toString());

    // Try to get the children
    console.log("\nmatch.children:");
    if (match.children && match.children.length > 0) {
        match.children.forEach((child, i) => {
            console.log(`  Child ${i}: ${child.constructor.name}`);
        });
    } else {
        console.log("  No children");
    }
} catch (error) {
    console.error("Parse error:", error);
}

