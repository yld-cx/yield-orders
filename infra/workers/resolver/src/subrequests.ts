export class Subrequests {
  #remaining: number;

  constructor(limit: number) {
    this.#remaining = limit;
  }

  get remaining() {
    return this.#remaining;
  }

  fetch: typeof fetch = async (input, init) => {
    init?.signal?.throwIfAborted();
    if (this.#remaining <= 0)
      throw new Error("External request budget exhausted");
    this.#remaining--;
    return fetch(input, init);
  };

  reserve(count: number) {
    if (this.#remaining < count) return;
    this.#remaining -= count;
    const reserved = new Subrequests(count);
    return {
      fetch: reserved.fetch,
      release: () => {
        this.#remaining += reserved.#remaining;
        reserved.#remaining = 0;
      },
    };
  }
}
