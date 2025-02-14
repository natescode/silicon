class Context {
    Parent: Context
    Locals: Map<any, any>
    constructor({ parent, locals = {} }: any) {
        this.Parent = parent
        this.Locals = new Map(Object.entries(locals))
    }
    add(name: string, entity: any) {
        this.Locals.set(name, entity)
    }
    lookup(name: string): any {
        return this.Locals.get(name) || this.Parent?.lookup(name)
    }
}

export default Context;