import ohm from 'ohm-js'
import Context from './context'

export default function analyze(match: ohm.MatchResult) {
    // Track the context manually via a simple variable. The initial context
    // contains the mappings from the standard library. Add to this context
    // as necessary. When needing to descent into a new scope, create a new
    // context with the current context as its parent. When leaving a scope,
    // reset this variable to the parent context.
    // let context = new Context({ Locals: core.standardLibrary })
    let context = new Context({ Locals: {} })

    // The single gate for error checking. Pass in a condition that must be true.
    // Use errorLocation to give contextual information about the error that will
    // appear: this should be an object whose "at" property is a parse tree node.
    // Ohm's getLineAndColumnMessage will be used to prefix the error message.
    function must(condition: any, message: any, errorLocation: any) {
        if (!condition) {
            const prefix = errorLocation.at.source.getLineAndColumnMessage()
            throw new Error(`${prefix}${message}`)
        }
    }

    function mustNotAlreadyBeDeclared(name: string, at: any) {
        must(!context.Locals.has(name), `Identifier ${name} already declared`, at)
    }

    function mustHaveBeenFound(entity: any, name: any, at: any) {
        must(entity, `Identifier ${name} not declared`, at)
    }

    function mustBeAVariable(entity: any, at: any) {
        // Bella has two kinds of entities: variables and functions.
        must(entity?.kind === "Variable", `Functions can not appear here`, at)
    }

    function mustBeAFunction(entity: any, at: any) {
        must(entity?.kind === "Function", `${entity.name} is not a function`, at)
    }

    function mustNotBeReadOnly(entity: any, at: any) {
        must(!entity.readOnly, `${entity.name} is read only`, at)
    }

    function mustHaveCorrectArgumentCount(argCount: any, paramCount: any, at: any) {
        const equalCount = argCount === paramCount
        must(equalCount, `${paramCount} argument(s) required but ${argCount} passed`, at)
    }

    // return builder(match).rep()
}