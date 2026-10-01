// Independent BigInt rational Product-Sum oracle for Ethereum integration vectors.
export const X = 10n ** 36n;
export const P0 = 10n ** 39n;
export const F = 10n ** 9n;
export const PMIN = 10n ** 30n;
export const MAX = 10n ** 30n;

export type Sums = { asset: bigint; yield: bigint; quote: bigint };
export type Snapshot = { initial: bigint; generation: number; scale: number; P: bigint; sums: Sums };
export type Account = {
  active: Snapshot;
  exit: Snapshot;
  owedActiveYield: bigint;
  owedActiveQuote: bigint;
  owedExitAsset: bigint;
  owedExitYield: bigint;
  owedExitQuote: bigint;
  activeFractions: Sums;
  exitFractions: Sums;
};
const zero = (): Sums => ({ asset: 0n, yield: 0n, quote: 0n });
const snap = (): Snapshot => ({ initial: 0n, generation: 0, scale: 0, P: P0, sums: zero() });
export const account = (): Account => ({
  active: snap(),
  exit: snap(),
  owedActiveYield: 0n,
  owedActiveQuote: 0n,
  owedExitAsset: 0n,
  owedExitYield: 0n,
  owedExitQuote: 0n,
  activeFractions: zero(),
  exitFractions: zero(),
});
const min = (a: bigint, b: bigint) => (a < b ? a : b);

export class DomainModel {
  P = P0;
  scale = 0;
  generation = 0;
  principal = 0n;
  sums = zero();
  history = new Map<string, Sums>();
  final = new Map<number, number>();
  private key(g: number, s: number) {
    return `${g}:${s}`;
  }
  private at(g: number, s: number): Sums {
    return g === this.generation && s === this.scale ? this.sums : (this.history.get(this.key(g, s)) ?? zero());
  }
  private end(g: number): number {
    return g === this.generation
      ? this.scale
      : (this.final.get(g) ??
          (() => {
            throw new Error("missing generation");
          })());
  }
  take(initial: bigint): Snapshot {
    return { initial, generation: this.generation, scale: this.scale, P: this.P, sums: { ...this.sums } };
  }
  principalX36(s: Snapshot): bigint {
    return s.initial === 0n || s.generation !== this.generation
      ? 0n
      : (s.initial * this.P) / s.P / F ** BigInt(this.scale - s.scale);
  }
  // One rational floor over every relevant scale; deliberately independent from Solidity's carry recurrence.
  gain(s: Snapshot, stream: keyof Sums): bigint {
    return this.gainX36(s, stream) / X;
  }
  gainX36(s: Snapshot, stream: keyof Sums): bigint {
    if (s.initial === 0n) return 0n;
    const span = Math.min(8, this.end(s.generation) - s.scale);
    let numerator = 0n;
    for (let i = 0; i <= span; i++) {
      const delta = this.at(s.generation, s.scale + i)[stream] - (i === 0 ? s.sums[stream] : 0n);
      numerator += delta * F ** BigInt(span - i);
    }
    return (s.initial * numerator) / (s.P * F ** BigInt(span));
  }
  gainWithFraction(s: Snapshot, stream: keyof Sums, fraction: bigint): bigint {
    return (fraction + this.gainX36(s, stream)) / X;
  }
  sync(s: Snapshot): { next: Snapshot; gains: Sums } {
    const gains: Sums = { asset: this.gain(s, "asset"), yield: this.gain(s, "yield"), quote: this.gain(s, "quote") };
    return { next: this.take(this.principalX36(s)), gains };
  }
  deposit(amount: bigint) {
    if (amount <= 0n || this.principal + amount > MAX) throw new Error("bound");
    this.principal += amount;
  }
  withdraw(amount: bigint) {
    if (amount > this.principal) throw new Error("principal");
    this.principal -= amount;
  }
  fund(gain: Sums) {
    if (this.principal === 0n) throw new Error("empty");
    for (const k of ["asset", "yield", "quote"] as const) {
      if (gain[k] > MAX) throw new Error("bound");
      this.sums[k] += (gain[k] * this.P) / this.principal;
    }
  }
  finishEmpty() {
    if (this.principal !== 0n) return;
    this.history.set(this.key(this.generation, this.scale), { ...this.sums });
    this.final.set(this.generation, this.scale);
    this.generation++;
    this.scale = 0;
    this.P = P0;
    this.sums = zero();
  }
  deplete(loss: bigint) {
    if (loss <= 0n || loss > this.principal) throw new Error("loss");
    const before = this.principal;
    this.principal -= loss;
    if (this.principal === 0n) {
      this.finishEmpty();
      return;
    }
    let nextP = (this.P * this.principal) / before;
    if (nextP < PMIN) {
      this.history.set(this.key(this.generation, this.scale), { ...this.sums });
      this.sums = zero();
      for (let i = 0; i < 4 && nextP < PMIN; i++) {
        this.scale++;
        nextP = (this.P * this.principal * F ** BigInt(i + 1)) / before;
      }
      if (nextP < PMIN) throw new Error("scale jump");
    }
    this.P = nextP;
  }
}

export class TickModel {
  active = new DomainModel();
  exit = new DomainModel();
  available = 0n;
  working = 0n;
  exitWorking = 0n;
  accounts = new Map<string, Account>();
  get(who: string) {
    let a = this.accounts.get(who);
    if (!a) {
      a = account();
      this.accounts.set(who, a);
    }
    return a;
  }
  sync(who: string) {
    const a = this.get(who);
    const accrue = (domain: DomainModel, snapshot: Snapshot, fractions: Sums, stream: keyof Sums): bigint => {
      const combined = fractions[stream] + domain.gainX36(snapshot, stream);
      fractions[stream] = combined % X;
      return combined / X;
    };
    a.owedActiveYield += accrue(this.active, a.active, a.activeFractions, "yield");
    a.owedActiveQuote += accrue(this.active, a.active, a.activeFractions, "quote");
    a.owedExitAsset += accrue(this.exit, a.exit, a.exitFractions, "asset");
    a.owedExitYield += accrue(this.exit, a.exit, a.exitFractions, "yield");
    a.owedExitQuote += accrue(this.exit, a.exit, a.exitFractions, "quote");
    a.active = this.active.take(this.active.principalX36(a.active));
    a.exit = this.exit.take(this.exit.principalX36(a.exit));
    return a;
  }
  supply(who: string, x: bigint) {
    const a = this.sync(who);
    this.active.deposit(x);
    this.available += x;
    a.active = this.active.take(a.active.initial + x * X);
  }
  swap(x: bigint, proceeds: bigint) {
    this.active.fund({ asset: 0n, yield: 0n, quote: proceeds });
    this.available -= x;
    this.active.deplete(x);
  }
  withdraw(who: string, requested: bigint) {
    const a = this.sync(who);
    const x = min(requested, a.active.initial / X);
    const availableOut = (x * this.available) / this.active.principal;
    const workingToExit = x - availableOut;
    this.available -= availableOut;
    this.exitWorking += workingToExit;
    this.active.withdraw(x);
    if (workingToExit > 0n) this.exit.deposit(workingToExit);
    a.active = this.active.take(a.active.initial - x * X);
    a.exit = this.exit.take(a.exit.initial + workingToExit * X);
    this.active.finishEmpty();
    return { x, availableOut, workingToExit };
  }
  use(x: bigint) {
    this.available -= x;
    this.working += x;
  }
  repay(x: bigint, netYield: bigint) {
    const e = min(x, this.exitWorking),
      active = x - e;
    const exitYield = (netYield * e) / x;
    if (e > 0n) {
      this.exit.fund({ asset: e, yield: exitYield, quote: 0n });
      this.exit.deplete(e);
    }
    if (netYield - exitYield > 0n) this.active.fund({ asset: 0n, yield: netYield - exitYield, quote: 0n });
    this.working -= x;
    this.exitWorking -= e;
    this.available += active;
  }
  close(x: bigint, proceeds: bigint) {
    const e = min(x, this.exitWorking),
      a = x - e,
      eq = (proceeds * e) / x;
    if (e > 0n) {
      this.exit.fund({ asset: 0n, yield: 0n, quote: eq });
      this.exit.deplete(e);
    }
    if (a > 0n) {
      this.active.fund({ asset: 0n, yield: 0n, quote: proceeds - eq });
      this.active.deplete(a);
    }
    this.working -= x;
    this.exitWorking -= e;
  }
}
