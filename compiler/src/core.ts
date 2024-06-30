import * as ohm from 'ohm-js'
export function program(statements: ohm.Node) {
    return { kind: "Program", statements }
}

function variable(arg0: string, arg1: boolean): any {
    throw new Error('Function not implemented.')
}
function fun(arg0: string, arg1: number): any {
    throw new Error('Function not implemented.')
}

// ...more here ...


// TODO standard library methods
export const standardLibrary = Object.freeze({
    π: variable("π", true),
    sqrt: fun("sqrt", 1),
    sin: fun("sin", 1),
    cos: fun("cos", 1),
    exp: fun("exp", 1),
    ln: fun("ln", 1),
    hypot: fun("hypot", 2),
})
export function call(callee: any, args: any) {
    throw new Error('Function not implemented.')
}

