import * as ohm from 'ohm-js'
const grammarSource = Bun.file('./src/silicon-simple.ohm')
const siliconGrammar = ohm.grammar(await grammarSource.text());
export default siliconGrammar