import ohm from 'ohm-js';
// An Ohm grammar for arithmetic expressions.
// Syntax reference: https://github.com/harc/ohm/blob/master/doc/syntax-reference.md
const grammarSource = String.raw`
  Arithmetic {
    Exp = AddExp
    AddExp = AddExp "+" PriExp  -- plus
           | AddExp "-" PriExp  -- minus
           | PriExp
    PriExp = "(" Exp ")"  -- paren
           | number
    number = digit+
  }
`;

// Instantiate the grammar defined above.
const g = ohm.grammar(grammarSource);

// Define an operation named 'eval' which evaluates the expression.
// See https://github.com/cdglabs/ohm/blob/master/doc/api-reference.md#semantics
const semantics = g.createSemantics().addOperation('eval', {
  Exp(e) {
    return e.eval();
  },
  AddExp(e) {
    return e.eval();
  },
  AddExp_plus(left, op, right) {
    return left.eval() + right.eval();
  },
  AddExp_minus(left, op, right) {
    return left.eval() - right.eval();
  },
  PriExp(e) {
    return e.eval();
  },
  PriExp_paren(open, exp, close) {
    return exp.eval();
  },
  number(chars) {
    return parseInt(this.sourceString, 10);
  },
});

let result;
const m = g.match('1 + 2 - 3');
if (m.succeeded()) {
  result = semantics(m).eval();  // Evaluate the expression.
} else {
  result = m.message;  // Extract the error message.
}
console.log(`result \n ${result}`)