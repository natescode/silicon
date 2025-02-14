import binaryen from "binaryen";

// Create a module with a single function
var myModule = new binaryen.Module();

myModule.addFunction("add", binaryen.createType([binaryen.i32, binaryen.i32]), binaryen.i32, [binaryen.i32],
    myModule.block(null, [
        myModule.local.set(2,
            myModule.i32.add(
                myModule.local.get(0, binaryen.i32),
                myModule.local.get(1, binaryen.i32)
            )
        ),
        myModule.return(
            myModule.local.get(2, binaryen.i32)
        )
    ])
);
myModule.addFunctionExport("add", "add");

// Optimize the module using default passes and levels
myModule.optimize();

// Validate the module
if (!myModule.validate())
    throw new Error("validation error");

// Generate text format and binary
var textData = myModule.emitText();
var wasmData = myModule.emitBinary();

// Example usage with the WebAssembly API
var compiled = new WebAssembly.Module(wasmData);
var instance = new WebAssembly.Instance(compiled, {});
console.log(instance.exports.add(41, 1));