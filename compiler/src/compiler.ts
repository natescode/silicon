// the 'compile' method uses binaryen npm module to generate web assembly
import * as ohm from 'ohm-js'

/**
 * wasm binary or wasm text forma
 */
type WasmFormat = "wasm" | "wat"

type OutputTarget = WasmFormat | "js" | "ts" | "c"

/**
 * 
 * @param ohm.MatchResult input
 * @description takes an ohm match result. Uses binaryen. 
 * @returns WASM binary or text
 */
export async function compile(input: ohm.MatchResult, outputType: OutputTarget): Promise<string | WebAssembly.Module> {
    if (["wasm", "wat"].includes(outputType)) return await compile_wasm(input, outputType as WasmFormat);
    if (outputType === "js") return await compile_js(input)
    if (outputType === "ts") return await compile_ts(input)
    if (outputType === "c") return await compile_c(input)
    throw new Error("invalid output target")
}


async function compile_wasm(input: ohm.MatchResult, outputType: WasmFormat): Promise<WebAssembly.Module> {
    const response = await fetch('my_wasm');
    const buffer = await response.arrayBuffer();
    const module = await WebAssembly.compile(buffer);
    return module
}

async function compile_js(input: ohm.MatchResult): Promise<string> {
    return /*javascript*/`
        console.log('hello world');
    `
}

async function compile_ts(input: ohm.MatchResult): Promise<string> {
    return /*typescript*/`
        console.log('hello world');
    `
}
async function compile_c(input: ohm.MatchResult): Promise<string> {
    return /*c*/`
        1 + 2;
    `
}