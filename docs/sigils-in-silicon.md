# Sigils in Silicon ✨

Silicon makes heavy use of **sigils** — small symbolic prefixes like `@`, `$`, `&`, or `$$`.  
If you’ve ever wondered *why* Silicon leans into symbols instead of keywords, or whether this is some brand-new idea… good news: it’s neither arbitrary nor new.

Sigils are a deliberate design choice, grounded in history, ergonomics, and compiler simplicity.

---

## What Is a Sigil?

A **sigil** is a symbolic marker attached to an identifier or construct that conveys meaning at a glance.

Instead of relying on reserved words or context-sensitive parsing, sigils make intent **explicit** and **locally visible**.

For example, in Silicon:

```silicon
@fn add a b = a + b;
@let x = 10;
&add 1 2
```

Even without knowing the full language, you can immediately see:

- `@fn` and `@let` introduce *definitions*
- `&` introduces a *function call*
- The symbols themselves carry semantic weight

No guessing. No context juggling.

---

## Sigils vs Operators (An Important Distinction)

Sigils and operators may *look* similar — they’re both symbols — but in Silicon they play **very different roles**.

### Sigils: Structural Markers

Sigils are **not expressions** and **not computations**.  
They exist to mark *what kind of thing* something is.

Key properties of sigils in Silicon:

- Prefix-only
- Non-overloadable
- Non-composable
- Unambiguous
- Grammar-significant

Examples:

```silicon
@fn      // definition
@effect  // effect invocation
&foo     // function call
$[1, 2]  // array literal
$$ok     // atom / symbol
```

A sigil answers the question:

> “What category of construct am I looking at?”

---

### Operators: Expressions That Compute

Operators, on the other hand, are **expressions**.  
They combine values to produce new values.

Key properties of operators in Silicon:

- Infix only
- Binary only (no ternary, or unary prefix or post fix i.e. ++x, x++)
- User-definable (via elaboration)
- Evaluated left-to-right
- Have no intrinsic meaning to the core grammar \*see [Elaboration](elaboration-in-silicon.md)

Examples:

```silicon
a + b
x == y
value |> transform
```

An operator answers the question:

> “How do these values relate or combine?”

---

### Why This Separation Matters

By drawing a **hard line** between sigils and operators, Silicon avoids several common language problems.

#### No Symbol Overloading Confusion

A sigil never doubles as an operator.  
An operator never changes parsing mode.

---

#### No Context-Sensitive Parsing

Sigils do not depend on surrounding tokens to change meaning.

---

#### A Clear Mental Model

> **Sigils define structure. Operators define computation.**

---

## Why Silicon Uses Sigils

Each sigil has **one job** and one job only:

| Sigil | Meaning |
|------|--------|
| `@`  | Definitions, annotations, compiler-visible constructs |
| `&`  | Function call expressions |
| `$`  | Literal construction |
| `$$` | Atoms / symbols |

---

## Sigils Are Not New

Sigils have a long and respectable history in programming languages, including Lisp, Perl, Ruby, assembly languages, and shell scripting.

Silicon is not inventing sigils — it’s **taking them seriously**.

---

## Why the Compiler Is Named *Sigil*

Before Silicon had its current name, *Sigil* was a working title for the language itself.

The Silicon compiler is named **Sigil** because the language uses sigils but also because Sigil has a magical connotation. Compilers often feel like magic.

---

*Welcome to Silicon.*