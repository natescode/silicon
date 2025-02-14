function keyword(word) {
    switch (word[0]) {
        case 'b': return 'break'
        case 'f': return 'fn'
        case 'i': return 'fn'
        case 'l': return 'loop'
        case 'm': return 'match'
        case 'r': return 'return'
        case 'v': return 'var'
        case 'y': return 'yield'
        default: throw new Error("illegal keyword")
    }
}

let words = ['break', 'fn', 'if', 'loop', 'match', 'return', 'break', 'yield']

words.sort((a, b) => Math.random() > 0.5 ? 1 : -1)
words.sort((a, b) => Math.random() > 0.5 ? 1 : -1)
const start = performance.now()

for (let i = 0; i < 1000000; ++i) {
    keyword(words[i % (words.length)])
}

const end = performance.now()

console.log(`Time = ${end - start}`)