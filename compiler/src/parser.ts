import siliconGrammar from "./SiliconGrammar"

export default function parse(sourceCode: string) {
  const match = siliconGrammar.match(sourceCode)
  if (!match.succeeded()) {
    throw new Error(`Parse error: ${match.message}`)
  }
  return match
}