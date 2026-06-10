// SPDX-License-Identifier: MIT
/**
 * ADR 0017/0018 — the CONSTRUCTED Web interface adapter.
 *
 * The `webref.ts` adapter binds *singleton-accessible* interfaces (Performance,
 * Crypto, …) as free `accessor.op()` calls.  This adapter binds *constructed*
 * interfaces (URL, Headers, TextEncoder, …) — objects the program makes with
 * `new` and then operates on through instance methods, getters, and setters.
 *
 * Because Silicon has no methods or `.`-syntax (ADR-0023), every instance member
 * becomes a free function whose FIRST parameter is the receiver — a `JSValue`
 * externref handle (Tier-2).  So `url.pathname` → `url::pathname(handle)`,
 * `headers.append(k,v)` → `headers::append(handle, k, v)`, `new URL(s)` →
 * `url::create(s)`.  Handles flow between externs but are never introspected by
 * the guest; the engine GCs them.  Output is consumed by the same IR/emitters as
 * every other source — only the `Impl` shape (construct/method/getter/setter/
 * static) differs.
 *
 * Type rule: scalars map via `idlTypeToSi`; any interface or ambient JS object/
 * buffer type (Uint8Array, BufferSource, …) crosses as a `JSValue` handle; a
 * DICTIONARY is NOT a handle (a plain options bag the guest can't build) — an
 * optional dict arg is dropped, a required one skips the member.  Optional args
 * are kept while representable and dropped at the first unrepresentable one
 * (matching the `dts.ts` policy).
 */

import * as webidl2 from 'webidl2'
import type { BindingSpec, Param, SiType } from '../spec'
import { idlTypeToSi } from './webidl'
import { loadWebrefCorpus, snake } from './webref'

/** Ambient JS object/buffer types that are not declared as `interface`s in the
 *  corpus but ARE real host objects — so they cross as opaque `JSValue` handles
 *  (e.g. `TextEncoder.encode` → Uint8Array; `TextDecoder.decode` ← BufferSource). */
const HANDLE_TYPES = new Set<string>([
    'object', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'ArrayBufferView',
    'BufferSource', 'AllowSharedBufferSource', 'Uint8Array', 'Uint8ClampedArray',
    'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array',
    'Float16Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
])

type Events = 'skip' | 'closure'

interface Ctx {
    readonly ifaces: Set<string>
    readonly dicts: Set<string>
    readonly enums: Set<string>
    readonly typedefs: Map<string, any>   // name → idlType node (resolves union typedefs too)
    readonly callbacks: Set<string>       // callback + callback-interface names (EventListener, EventHandlerNonNull, …)
}

/** Classify one webidl2 type NODE to a Silicon boundary type, or null if it
 *  can't cross (dictionary / sequence / record / Promise / callback / unknown).
 *  A union maps to String if any arm is a string (the guest can supply one),
 *  else to JSValue if every arm is a handle, else null.  Under `events:'closure'`
 *  a CALLBACK type yields `Callback` — valid only in PARAM position (see the
 *  result/getter/union sinks in `classifyResult`/`classify`/the attribute loop). */
function classify(tn: any, ctx: Ctx, events: Events, depth = 0): SiType | null {
    if (!tn || depth > 8) return null
    if (tn.union && Array.isArray(tn.idlType)) {
        const parts = tn.idlType.map((p: any) => classify(p, ctx, events, depth + 1))
        // A callback arm sinks the whole union: a closure can't be one of several
        // interchangeable handle/string arms (`(EventHandler or DOMString)`).
        if (parts.some((p: SiType | null) => p === 'Callback')) return null
        if (parts.some((p: SiType | null) => p === 'String')) return 'String'
        if (parts.length && parts.every((p: SiType | null) => p === 'JSValue')) return 'JSValue'
        return null
    }
    if (tn.generic) {
        // A JS array (`sequence<>`/`FrozenArray<>`/`ObservableArray<>`) crosses as
        // one opaque JSValue array handle — the guest walks it with js::len /
        // js::get_index (mirrors dts.ts mapping an array type to JSValue).
        if (tn.generic === 'sequence' || tn.generic === 'FrozenArray' || tn.generic === 'ObservableArray') return 'JSValue'
        return null                      // record<> / Promise<> — handled elsewhere (classifyResult), else not a single handle
    }
    const name = tn.idlType
    if (typeof name !== 'string') return null
    return classifyName(name, ctx, events, depth)
}

/** Classify a NAMED IDL type (a string), shared by `classify` and the Promise
 *  awaited-type path. */
function classifyName(name: string, ctx: Ctx, events: Events, depth: number): SiType | null {
    if (typeof name !== 'string') return null
    if (HANDLE_TYPES.has(name)) return 'JSValue'
    // The IDL `any`/`object` type is as opaque as a host object — cross it as a
    // JSValue handle (the guest reads it with js::as_int/as_str/get, builds it
    // with js::object/js::set).  Mirrors dts.ts mapping `any` → JSValue.
    if (name === 'any' || name === 'object') return 'JSValue'
    // A callback (`callback`/`callback interface` def, or an EventHandler typedef
    // chain that lands on one) crosses as a `Callback` closure handle in 'closure'
    // mode — the guest passes `@export_callback(@closure(…))`.  In 'skip' mode it
    // stays unbindable (null), preserving the default.  ONLY valid in param/setter
    // position; the result/getter/union sites reject `Callback`.
    if (ctx.callbacks.has(name)) return events === 'closure' ? 'Callback' : null
    try { return idlTypeToSi(name) } catch { /* not a scalar */ }
    if (ctx.ifaces.has(name)) return 'JSValue'
    if (ctx.enums.has(name)) return 'String'     // an IDL enum is a set of string values
    // A dictionary (options bag) crosses as a JSValue handle — the guest builds it
    // with js::object()/js::set(...); the host receives a plain object.
    if (ctx.dicts.has(name)) return 'JSValue'
    // A typedef may alias a callback (EventHandler → EventHandlerNonNull) — recurse.
    const td = ctx.typedefs.get(name)
    if (td) return classify(td, ctx, events, depth + 1)
    return null
}

/** Classify an OPERATION return type, recognising `Promise<T>` → a `@suspending`
 *  binding whose result is the awaited `T` (ADR 0018 / next FFI #5): so
 *  `Response.json()` / `text()` / `arrayBuffer()` become awaitable.  The resolved
 *  value of `Promise<any>` (or any non-Tier-0 awaited type) crosses as a JSValue
 *  handle; `Promise<undefined>` is a suspending `Void`.  A callback RESULT is not
 *  bindable (the guest can't be handed a host function) → null. */
function classifyResult(tn: any, ctx: Ctx, events: Events): { type: SiType | null; suspending: boolean } {
    const notCallback = (t: SiType | null): SiType | null => (t === 'Callback' ? null : t)
    if (tn && tn.generic === 'Promise') {
        const awaited = Array.isArray(tn.idlType) ? tn.idlType[0] : undefined
        const aname = awaited?.idlType
        if (!awaited || aname === 'undefined' || aname === 'void') return { type: 'Void', suspending: true }
        return { type: notCallback(classify(awaited, ctx, events) ?? 'JSValue'), suspending: true }
    }
    return { type: notCallback(classify(tn, ctx, events)), suspending: false }
}

/** Build a param list from an IDL argument list.
 *
 *  Silicon has no optional parameters and no `undefined`, and a Silicon string
 *  passed as `""` is NOT the same as "argument omitted" — the host parses it
 *  eagerly (`URL.canParse(url, "")` → false, `params.delete(name, "")` filters by
 *  empty value).  So a forced optional arg yields silently-wrong answers.  The
 *  policy, therefore:
 *    - keep every REQUIRED arg;
 *    - keep the FIRST optional arg ONLY when no required arg precedes it — that
 *      is the operation's payload (`encode(input)`, `new URLSearchParams(init)`),
 *      and supplying it (even `""`) is the right behaviour;
 *    - drop a secondary optional (one that follows a required arg, e.g.
 *      `canParse`'s base, `has`/`delete`'s value) and everything after it — the
 *      1-arg WHATWG form is the correct one to expose;
 *    - an UNREPRESENTABLE required arg makes the whole member unbindable (null);
 *      an unrepresentable optional is simply dropped.
 *  Returns null to signal "skip this member". */
function buildParams(args: any[], ctx: Ctx, events: Events): Param[] | null {
    const out: Param[] = []
    for (const a of args ?? []) {
        const t = classify(a.idlType, ctx, events)
        if (a.optional) {
            // Keep this optional only if it is the sole/first data arg (a payload);
            // either way, stop — trailing positional args cannot be reached.
            if (out.length === 0 && t !== null && t !== 'Void') out.push({ name: a.name, type: t })
            break
        }
        if (t === null || t === 'Void') return null   // required + unrepresentable → skip member
        out.push({ name: a.name, type: t })
    }
    return out
}

export interface WebIfaceResult {
    readonly specs: BindingSpec[]
    readonly skipped: { readonly member: string; readonly reason: string }[]
}

/**
 * Generate constructor + instance-method + getter/setter + static BindingSpecs
 * for one constructed Web interface from the real @webref/idl corpus.
 *
 * `interfaceName` is also the JS global the constructor/statics are reached
 * through at the host (`new URL(...)`, `URL.canParse(...)`).  Member names are
 * snake_cased; the constructor binds as `create` (`new` is a reserved Silicon
 * token).  Strings are emitted as `String` (the emitter rewrites to `JSString`
 * in jsstring mode); object handles as `JSValue`.
 *
 * `events:'closure'` (ADR 0019 C2) binds a CALLBACK type as a `Callback` closure
 * handle: an `EventHandler` attribute (`onabort`) → a setter `set_onabort(self,
 * Callback)`, and a callback ARGUMENT (`addEventListener(type, listener)`) → a
 * `Callback` param.  The default 'skip' leaves both unbindable (the prior
 * behaviour — `bindgen --check` / the lockfile stay byte-stable for callers that
 * don't opt in).
 */
export function webifaceToSpecs(interfaceName: string, corpus = loadWebrefCorpus(), events: Events = 'skip'): WebIfaceResult {
    // Global maps across the whole corpus (an interface's members may reference
    // any spec's typedef / dictionary / enum / callback).
    const ifaces = new Set<string>()
    const dicts = new Set<string>()
    const enums = new Set<string>()
    const typedefs = new Map<string, any>()
    const callbacks = new Set<string>()  // `callback` + `callback interface` def names
    // Members of THIS interface, merged across partials + included mixins.
    const ownMembers: any[] = []
    const includes: string[] = []        // mixin names this interface includes
    const mixinMembers = new Map<string, any[]>()

    for (const { text } of corpus) {
        let tree: any[]
        try { tree = webidl2.parse(text) } catch { continue }
        for (const def of tree) {
            switch (def.type) {
                case 'interface':
                    ifaces.add(def.name)
                    if (def.name === interfaceName) ownMembers.push(...(def.members ?? []))
                    break
                case 'interface mixin':
                    ifaces.add(def.name)
                    mixinMembers.set(def.name, [...(mixinMembers.get(def.name) ?? []), ...(def.members ?? [])])
                    break
                case 'dictionary': dicts.add(def.name); break
                case 'enum': enums.add(def.name); break
                case 'typedef': if (def.idlType) typedefs.set(def.name, def.idlType); break
                case 'includes': if (def.target === interfaceName) includes.push(def.includes); break
                // A `callback` (EventHandlerNonNull, FrameRequestCallback, …) or a
                // `callback interface` (EventListener, NodeFilter) is a function the
                // guest can supply as a closure.  An `EventHandler` typedef resolves
                // here through the typedefs map.
                case 'callback': callbacks.add(def.name); break
                case 'callback interface': callbacks.add(def.name); break
            }
        }
    }
    const ctx: Ctx = { ifaces, dicts, enums, typedefs, callbacks }
    // Process STATIC operations last: a static factory whose snake-name collides
    // with an instance member (e.g. Response's static `json(data)` vs the Body-mixin
    // instance `json()` body-reader) must yield the binding name to the instance
    // member — the established, commonly-used binding — rather than evict it.  The
    // static then collides-and-drops (a category-5 overload-tail skip).
    const allMembers = [...ownMembers, ...includes.flatMap(m => mixinMembers.get(m) ?? [])]
    const members = [...allMembers.filter(m => m.special !== 'static'), ...allMembers.filter(m => m.special === 'static')]

    const specs: BindingSpec[] = []
    const skipped: { member: string; reason: string }[] = []
    const seenMember = new Set<string>()   // dedup members re-declared across partials
    const usedName = new Set<string>()      // enforce unique binding names within the interface

    /** Emit a spec unless its name collides (the ADR lockstep key must be unique). */
    const emit = (name: string, params: Param[], result: SiType, impl: BindingSpec['impl'], member: string, suspending = false) => {
        if (usedName.has(name)) { skipped.push({ member, reason: `name '${name}' collides — dropped` }); return }
        usedName.add(name)
        specs.push({ name, params, result, impl, source: `webref:${interfaceName}.${member}`, suspending: suspending || undefined })
    }

    for (const m of members) {
        const key = `${m.type}:${m.name ?? ''}:${m.special ?? ''}`
        if (seenMember.has(key)) continue
        seenMember.add(key)

        // A `stringifier` (either an anonymous `stringifier;` operation or a
        // `stringifier attribute href`) means `obj.toString()` returns a DOMString
        // — bind it as `to_string(self) -> String`.  An attribute-stringifier ALSO
        // falls through to emit its own getter/setter.
        if (m.special === 'stringifier') {
            emit('to_string', [{ name: 'self', type: 'JSValue' }], 'String', { kind: 'method', method: 'toString' }, 'toString')
            if (m.type !== 'attribute') continue
        }

        if (m.type === 'constructor') {
            const params = buildParams(m.arguments, ctx, events)
            if (params === null) { skipped.push({ member: 'constructor', reason: 'a required ctor arg is not bindable' }); continue }
            emit('create', params, 'JSValue', { kind: 'construct', iface: interfaceName }, 'constructor')
            continue
        }

        if (m.type === 'attribute' && m.name) {
            const t = classify(m.idlType, ctx, events)
            if (t === null || t === 'Void') { skipped.push({ member: m.name, reason: 'attribute type not bindable' }); continue }
            // An EventHandler attribute (`signal.onabort = fn`, t === 'Callback'):
            // a host handler can't be read back as a guest closure, so emit the
            // SETTER ONLY — `set_onabort(self, value: Callback) -> Void`.  The
            // (always-writable) EventHandler has no useful getter.
            if (t === 'Callback') {
                if (m.readonly) { skipped.push({ member: m.name, reason: 'read-only callback handler — not bindable' }); continue }
                emit(`set_${snake(m.name)}`, [{ name: 'self', type: 'JSValue' }, { name: 'value', type: 'Callback' }],
                     'Void', { kind: 'setter', attr: m.name }, m.name)
                continue
            }
            emit(snake(m.name), [{ name: 'self', type: 'JSValue' }], t, { kind: 'getter', attr: m.name }, m.name)
            if (!m.readonly) {
                emit(`set_${snake(m.name)}`, [{ name: 'self', type: 'JSValue' }, { name: 'value', type: t }],
                     'Void', { kind: 'setter', attr: m.name }, m.name)
            }
            continue
        }

        if (m.type === 'operation' && m.name && (m.special === '' || m.special === undefined || m.special === 'static')) {
            const { type: result, suspending } = classifyResult(m.idlType, ctx, events)
            if (result === null) { skipped.push({ member: m.name, reason: `return type not bindable` }); continue }
            const args = buildParams(m.arguments, ctx, events)
            if (args === null) { skipped.push({ member: m.name, reason: 'a required arg is not bindable' }); continue }
            if (m.special === 'static') {
                emit(snake(m.name), args, result, { kind: 'static', iface: interfaceName, method: m.name }, m.name, suspending)
            } else {
                emit(snake(m.name), [{ name: 'self', type: 'JSValue' }, ...args], result, { kind: 'method', method: m.name }, m.name, suspending)
            }
            continue
        }
        // stringifiers / indexed getter-setter-deleter / iterable / const → not callable as named module fns.
    }

    return { specs, skipped }
}
