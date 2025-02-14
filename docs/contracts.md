# Contracts

Originally called *Protocols*, Contracts are similar to [Design by Contract](https://en.wikipedia.org/wiki/Design_by_contract) but generally enforced at compile time. 

The goal of Silicon Contracts validate:

- API methods are called in correct order
- API methods are called in scope (I.E to clean up memory / connections)
- pre-conditions are met (at least at compile time)
- post-conditions are met (at least at compile time)
- ??