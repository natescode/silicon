class Envelope {
  constructor(message, from = null, to = null, postage = null) {
    this.from = from;
    this.to = to;
    this.message = message;
    this.postage = postage;
  }

  static of(message) {
    return new Envelope(message);
  }

  flatMap() {
    // code
    return this.message;
  }
}

// >>=
const bind = (thing) => thing.flatMap();
