# Contributing to Silicon

We're excited you want to contribute! This document explains how.

## Getting Started

1. **Read the docs**
   - [ARCHITECTURE.md](./ARCHITECTURE.md) - Understand the system
   - [DEVELOP.md](./DEVELOP.md) - Set up your environment

2. **Set up your environment**
   ```bash
   git clone https://github.com/natescode/silicon.git
   cd silicon
   bun install
   bun run src/index.ts
   ```

3. **Find an issue to work on**
   - Check [GitHub Issues](https://github.com/natescode/silicon/issues)
   - Look for issues labeled `good-first-issue` or `help-wanted`
   - Comment to express interest before starting work

## Development Workflow

### 1. Create a Branch

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/bug-description
```

Use a descriptive branch name:
- `feature/if-statements` ✓
- `fix/parser-null-pointer` ✓
- `docs/update-readme` ✓

### 2. Make Your Changes

Follow the structure in [DEVELOP.md](./DEVELOP.md) for adding features:

1. Update grammar (`src/grammar/silicon-official.ohm`)
2. Add AST nodes (`src/ast/astNodes.ts`)
3. Add semantic actions (`src/ast/toAst.ts`, `src/codegen/compile.ts`)
4. Test with `bun run src/index.ts`

### 3. Commit Messages

Write clear, descriptive commit messages:

```
feat: add if-statement support

- Update grammar for if/else syntax
- Add IfStatement AST node type
- Implement code generation for conditional branching
- Test with simple if-else expressions

Fixes #123
```

Format:
- First line: `<type>: <short description>` (50 chars max)
- Blank line
- Body: Explain **why** and **what**, not how (the code shows how)
- Reference issues: `Fixes #123` or `Related to #456`

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

### 4. Test Your Changes

```bash
# Test the compiler
bun run src/index.ts

# Verify AST output
cat ast.json | jq .  # Pretty-print JSON

# Verify WAT output
cat main.wat
```

### 5. Submit a Pull Request

- Create a PR from your branch to `main`
- Link related issues: "Fixes #123"
- Describe your changes and why you made them
- Include test results/output if relevant

**PR Template:**

```markdown
## Description
Brief description of what this PR does.

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Documentation
- [ ] Refactoring

## Changes
- Bullet list of specific changes
- Another change
- One more thing

## Testing
How to test this:
```bash
bun run src/index.ts
```
Output: [paste output]

## Checklist
- [ ] I've read DEVELOP.md
- [ ] Code follows the style guide
- [ ] Changes work locally
- [ ] Commit messages are clear
- [ ] No breaking changes (or documented)
```

## Code Style

### TypeScript/JavaScript

```typescript
// ✓ Good
const calculateSum = (a: number, b: number): number => {
  return a + b
}

// ✗ Bad
const sum = (a, b) => a + b  // No types!
```

Guidelines:
- Add JSDoc comments to public functions
- Use 4 spaces for indentation
- Prefer `const`, avoid `var`
- Use TypeScript interfaces for complex types
- Add comments for non-obvious logic

### Grammar (Ohm)

```ohm
// ✓ Good - clear rule names, consistent spacing
Statement = Assignment
          | FunctionDef
          | IfStatement

Assignment = identifier "=" Expression

// ✗ Bad - ambiguous names, hard to parse
Stmt = A | F | I
A = x "=" E
```

Guidelines:
- Use camelCase for rule names
- Group alternatives with consistent indentation
- Use spaces around operators
- Comment complex rules

## Reporting Issues

When reporting bugs, include:

```markdown
## Description
What went wrong?

## Steps to Reproduce
1. Code that triggers the bug
2. Expected behavior
3. Actual behavior

## Environment
- OS: macOS 13.2
- Bun version: 1.0.1
- Node version: 18.14

## Output
```
[Paste error message, AST, WAT, etc.]
```
```

## Architecture Decisions

When proposing significant changes, discuss first:

1. Open an issue describing the change
2. Explain the benefits and trade-offs
3. Wait for feedback from maintainers
4. After approval, submit PR

This prevents wasted effort on approaches that won't be merged.

## Documentation

Help us document the project!

- **API docs**: Add JSDoc comments to functions
- **Architecture docs**: Update ARCHITECTURE.md
- **Examples**: Add test cases showing usage
- **Guides**: Improve DEVELOP.md with common patterns

## Review Process

Our review focuses on:

✓ Does it work? (tests pass)  
✓ Is it correct? (follows the spec)  
✓ Is it clear? (readable code)  
✓ Is it documented? (comments explain why)

We're constructive and friendly. Reviews are about the code, not the person.

## Questions?

- Open a GitHub discussion
- Ask on our Discord (link TBD)
- Email maintainers (emails in MAINTAINERS.md)

## Recognition

Contributors are recognized in:
- GitHub contributors page
- CHANGELOG.md (for significant changes)
- Release notes

Thank you for making Silicon better! 🙏