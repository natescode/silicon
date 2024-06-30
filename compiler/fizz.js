let testActions = [
    {
        test: (n) => {
            if (n % 2 === 0) {
                let msg = `${n} is even!`
                Bun.write('fizz', msg)
                // console.log(msg)
            }
        }
    },
    {
        test: (n) => {
            let msg
            if (n % 15 === 0) {
                msg = "fizzbuzz"
            } else if (n % 5 === 0) {
                msg = "buzz"
            } else if (n % 3 === 0) {
                msg = "fizz"
            } else {
                msg = n
            }
            console.log(msg)
        }
    },
]

function testAction(n) {
    for (let ta of testActions) {
        ta.test(n)
    }
}

function iterAction(iterator) {
    for (let n of iterator) {
        testAction(n)
    }
}
let nums = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]
iterAction(nums)