// import siliconGrammar from "../SiliconGrammar"

// const builder = siliconGrammar.createSemantics().addOperation("rep", {
//     Program(statements: any) {
//         return core.program(statements.children.map(s => s.rep()))
//     },

//     Statement_vardec(_let, id, _eq, exp, _semicolon) {
//         // Analyze the initializer *before* adding the variable to the context,
//         // because we don't want the variable to come into scope until after
//         // the declaration. That is, "let x=x;" should be an error (unless x
//         // was already defined in an outer scope.)
//         const initializer = exp.rep()
//         const variable = core.variable(id.sourceString, false)
//         mustNotAlreadyBeDeclared(id.sourceString, { at: id })
//         context.add(id.sourceString, variable)
//         return core.variableDeclaration(variable, initializer)
//     },

//     // fn idTyped params eq exp 
//     Statement_fundec(_fun, id, parameters, _equals, exp, _semicolon) {
//         // Start by adding a new function object to this context. We won't
//         // have the number of params yet; that will come later. But we have
//         // to get the function in the context right way, to allow recursion.
//         const fun = core.fun(id.sourceString)
//         mustNotAlreadyBeDeclared(id.sourceString, { at: id })
//         context.add(id.sourceString, fun)

//         // Add the params and body to the child context, updating the
//         // function object with the parameter count once we have it.
//         context = new Context({ parent: context })
//         const params = parameters.rep()
//         fun.paramCount = params.length
//         const body = exp.rep()
//         context = context.parent

//         // Now that the function object is created, we can make the declaration.
//         return core.functionDeclaration(fun, params, body)
//     },

//     Params(_open, idList, _close) {
//         return idList.asIteration().children.map(id => {
//             const param = core.variable(id.sourceString, true)
//             // All of the parameters have to be unique
//             mustNotAlreadyBeDeclared(id.sourceString, { at: id })
//             context.add(id.sourceString, param)
//             return param
//         })
//     },

//     Statement_assign(id, _eq, exp, _semicolon) {
//         const target = id.rep()
//         mustNotBeReadOnly(target, { at: id })
//         return core.assignment(target, exp.rep())
//     },

//     Statement_print(_print, exp, _semicolon) {
//         return core.printStatement(exp.rep())
//     },

//     Statement_while(_while, exp, block) {
//         return core.whileStatement(exp.rep(), block.rep())
//     },

//     Block(_open, statements, _close) {
//         return statements.children.map(s => s.rep())
//     },

//     Exp_unary(op, exp) {
//         return core.unary(op.sourceString, exp.rep())
//     },

//     Exp_ternary(exp1, _questionMark, exp2, _colon, exp3) {
//         return core.conditional(exp1.rep(), exp2.rep(), exp3.rep())
//     },

//     Exp1_binary(exp1, op, exp2) {
//         return core.binary(op.sourceString, exp1.rep(), exp2.rep())
//     },

//     Exp2_binary(exp1, op, exp2) {
//         return core.binary(op.sourceString, exp1.rep(), exp2.rep())
//     },

//     Exp3_binary(exp1, op, exp2) {
//         return core.binary(op.sourceString, exp1.rep(), exp2.rep())
//     },

//     Exp4_binary(exp1, op, exp2) {
//         return core.binary(op.sourceString, exp1.rep(), exp2.rep())
//     },

//     Exp5_binary(exp1, op, exp2) {
//         return core.binary(op.sourceString, exp1.rep(), exp2.rep())
//     },

//     Exp6_binary(exp1, op, exp2) {
//         return core.binary(op.sourceString, exp1.rep(), exp2.rep())
//     },

//     Exp7_parens(_open, exp, _close) {
//         return exp.rep()
//     },

//     Exp7_call(id, _open, expList, _close) {
//         // ids used in calls must have already been declared and must be
//         // bound to function entities, not to variable entities.
//         const callee = context.lookup(id.sourceString)
//         mustHaveBeenFound(callee, id.sourceString, { at: id })
//         mustBeAFunction(callee, { at: id })
//         const args = expList.asIteration().children.map(arg => arg.rep())
//         mustHaveCorrectArgumentCount(args.length, callee.paramCount, { at: id })
//         return core.call(callee, args)
//     },

//     Exp7_id(id: ohm.Node) {
//         // ids used in expressions must have been already declared and must
//         // be bound to variable entities, not function entities.
//         const entity = context.lookup(id.sourceString)
//         mustHaveBeenFound(entity, id.sourceString, { at: id })
//         mustBeAVariable(entity, { at: id })
//         return entity
//     },

//     true(_: any) {
//         return true
//     },

//     false(_: any) {
//         return false
//     },
//     num(_whole: string, _point: string, _fraction: string, _e: string, _sign: string, _exponent: string) {
//         return Number(this.sourceString)
//     },
// })

// export default builder;