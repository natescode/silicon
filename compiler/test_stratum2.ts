import siliconGrammar from "./src/grammar/SiliconGrammar"

const testSource = `@stratum Plus (Operator, '+', Node) = { result; };`

try {
  const match = siliconGrammar.match(testSource)
  if (match.succeeded()) {
    console.log("PARSE SUCCESS!")
  } else {
    console.log("PARSE FAILED:", match.message)
  }
} catch (e) {
  console.log("ERROR:", e)
}
