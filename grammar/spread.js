// Senior JavaScript interview questions

// Manually implement the spread operator as a function
function* spread(iterable) {
  for (const iterator of iterable) {
    yield iterator;
  }
}

const result = [spread(spread([1, 2, 3, 4, 5]))];
console.log(result);
