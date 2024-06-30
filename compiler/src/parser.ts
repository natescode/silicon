import { error } from 'console';
import fs from 'fs';
import ohm from 'ohm-js';
const silicon = fs.readFileSync('silicon.ohm', 'utf-8');
const grammar = ohm.grammar(silicon);

// User input
const userInput = "2*3";
const match = grammar.match(userInput);

if (match.succeeded()) {
    console.log("works!")
} else {
    console.error(match.message);
}

grammar.createSemantics().addOperation("eval", {
    Program(e) {
        return e.eval();
    },
    SourceElement(e) {
        return e.eval();
    },
    STATEMENT(e) {
        return e.eval();
    },
    EXP(e) {
        return e.eval();
    },
    BinaryExp(exp, op, literal_or_name) {

    }


})