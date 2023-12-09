# Precedence

| Precedence | Operator                                        | Description                                      |
| ---------- | ----------------------------------------------- | ------------------------------------------------ |
| 1          | =                                               | Assignment                                       |
| 2          | @or                                             | Boolean Or                                       |
| 3          | @And                                            | Boolean And                                      |
| 4          | @is, @not, @below, @most, @above, @least, @deep | Comparisons                                      |
| 5          | + - @bor @bxor                                  | Addition, Substraction, Bitwise Or, Bitwaise XOr |
| 6          | \* / @band                                      | Multiplication, Division, Bitwise And            |
