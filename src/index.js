import * as ohm from "ohm-js";

const myGrammar = ohm.grammar(String.raw`
  MyGrammar {
    greeting = "Hello" | "Hola"
  }
`);

const userInput = "Hello";
const m = myGrammar.match(userInput);
if (m.succeeded()) {
  console.log("Greetings, human.");
} else {
  console.log("That's not a greeting!");
}
