import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeFunctionData, getContract, parseEventLogs, zeroAddress } from "viem";
import { adversarialTokenAbi, reentrantTokenAbi } from "./abi/mocks.js";
import { surplus } from "./helpers/custody.js";
import { TickModel, fullTermYield } from "./reference.js";

const MAX = 2n ** 256n - 1n;
describe("user liabilities and adversarial transfers", async () => {
  const { viem, networkHelpers } = await network.create();
  const client = await viem.getPublicClient();
  const [fee, supplier, taker, keeper] = await viem.getWalletClients();
  async function setup() {
    const deploy = async () =>
      getContract({
        address: (await viem.deployContract("AdversarialToken")).address,
        abi: adversarialTokenAbi,
        client: { public: client, wallet: fee },
      });
    const asset = await deploy();
    const quote = await deploy();
    const market = await viem.deployContract("YieldOrders", [fee.account.address]);
    await market.write.createPair([asset.address, quote.address]);
    const [pair] = await market.read.getPair([asset.address, quote.address]);
    const direction = asset.address.toLowerCase() < quote.address.toLowerCase() ? 0 : 1;
    const create = async (dir: number, days: bigint) => {
      const { result } = await market.simulate.createTick([pair, dir, 0, days]);
      await market.write.createTick([pair, dir, 0, days]);
      return result;
    };
    const tick = await create(direction, 1n);
    const reverse = await create(1 - direction, 1n);
    for (const token of [asset, quote]) {
      await token.write.configure([market.address, 0n, 0n, 0n, 0]);
      for (const user of [supplier, taker]) {
        await token.write.mint([user.account.address, 10n ** 25n]);
        await token.write.approve([market.address, MAX], { account: user.account });
      }
    }
    const supply = async (amount = 10000n) =>
      market.write.supply([tick, amount, zeroAddress], { account: supplier.account });
    const withdraw = async (amount = MAX) =>
      market.write.withdraw([tick, amount, 0n, MAX], { account: supplier.account });
    const backed = async () => {
      for (const token of [asset, quote]) assert.ok((await surplus(market, token)) >= 0n);
    };
    return { market, asset, quote, tick, reverse, create, supply, withdraw, backed, direction };
  }

  it("exports the ABI with the unchanged collection event signature", async () => {
    const { market } = await setup();
    assert.ok(!market.abi.some((x) => "name" in x && ["accruedProtocolFees", "ProtocolFeesAccrued"].includes(x.name)));
    const event = market.abi.find((x) => x.type === "event" && x.name === "ProtocolFeesCollected");
    assert.deepEqual(
      event?.inputs.map((x) => [x.type, x.indexed]),
      [
        ["address", true],
        ["uint256", false],
      ],
    );
  });

  it("credits only requested inbound amounts and sweeps donated/positive-rebase excess", async () => {
    const { market, asset, tick, supply, backed } = await setup();
    await asset.write.configure([market.address, 1n, 0n, 0n, 0]);
    await supply();
    assert.equal((await market.read.getTick([tick])).availableSupply, 10000n);
    assert.equal(await market.read.tokenLiability([asset.address]), 10000n);
    assert.equal(await surplus(market, asset), 1n);
    await asset.write.rebase([market.address, 17n]);
    await asset.write.transfer([market.address, 12n], { account: taker.account });
    const expected = await surplus(market, asset);
    const before = await asset.read.balanceOf([fee.account.address]);
    const hash = await market.write.collectProtocolFees([asset.address, await surplus(market, asset)], {
      account: keeper.account,
    });
    assert.equal((await asset.read.balanceOf([fee.account.address])) - before, expected);
    assert.equal(await surplus(market, asset), 0n);
    assert.equal(
      parseEventLogs({
        abi: market.abi,
        logs: (await client.getTransactionReceipt({ hash })).logs,
        eventName: "ProtocolFeesCollected",
      })[0].args.amount,
      expected,
    );
    await assert.rejects(market.write.collectProtocolFees([asset.address, 0n]), /InvalidInput/);
    await backed();
  });

  it("collects caller-specified partial amounts only to the treasury", async () => {
    const { market, asset, supply } = await setup();
    await supply();
    await asset.write.mint([market.address, 100n]);
    const liability = await market.read.tokenLiability([asset.address]);
    for (const amount of [40n, 60n]) {
      const hash = await market.write.collectProtocolFees([asset.address, amount], { account: keeper.account });
      const event = parseEventLogs({
        abi: market.abi,
        logs: (await client.getTransactionReceipt({ hash })).logs,
        eventName: "ProtocolFeesCollected",
      })[0].args;
      assert.equal(event.amount, amount);
      assert.equal(await market.read.tokenLiability([asset.address]), liability);
    }
    assert.equal(await asset.read.balanceOf([fee.account.address]), 100n);
    assert.equal(await asset.read.balanceOf([keeper.account.address]), 0n);
    assert.equal(await surplus(market, asset), 0n);
  });

  it("rolls back excessive requests, including uint256 max", async () => {
    const { market, asset, supply } = await setup();
    await supply();
    await asset.write.mint([market.address, 100n]);
    await assert.rejects(market.write.collectProtocolFees([asset.address, 101n]), /Invariant/);
    await assert.rejects(market.write.collectProtocolFees([asset.address, MAX]));
    assert.equal(await asset.read.balanceOf([market.address]), 10100n);
    assert.equal(await asset.read.balanceOf([fee.account.address]), 0n);
    assert.equal(await market.read.tokenLiability([asset.address]), 10000n);
  });

  it("rejects stale offchain amounts after another collection", async () => {
    const { market, asset, supply } = await setup();
    await supply();
    await asset.write.mint([market.address, 100n]);
    const stale = await surplus(market, asset);
    await market.write.collectProtocolFees([asset.address, 70n], { account: keeper.account });
    await assert.rejects(market.write.collectProtocolFees([asset.address, stale]), /Invariant/);
    assert.equal(await surplus(market, asset), 30n);
    assert.equal(await asset.read.balanceOf([fee.account.address]), 70n);
    assert.equal(await market.read.tokenLiability([asset.address]), 10000n);
  });

  it("rejects zero requests before any token interaction", async () => {
    const { market, asset, supply } = await setup();
    await supply();
    await asset.write.setBalanceMode([1, 0]);
    await assert.rejects(market.write.collectProtocolFees([asset.address, 0n]), /InvalidInput/);
    await asset.write.setBalanceMode([0, 0]);
    assert.equal(await asset.read.balanceOf([market.address]), 10000n);
    assert.equal(await asset.read.balanceOf([fee.account.address]), 0n);
    assert.equal(await market.read.tokenLiability([asset.address]), 10000n);
  });

  it("uses the actual final debit when sender rounding reduces the debit", async () => {
    const { market, asset, supply } = await setup();
    await supply();
    await asset.write.mint([market.address, 1n]);
    await asset.write.configure([market.address, 0n, 0n, -1n, 0]);
    await market.write.collectProtocolFees([asset.address, 2n]);
    assert.equal(await asset.read.balanceOf([fee.account.address]), 2n);
    assert.equal(await surplus(market, asset), 0n);
    assert.equal(await market.read.tokenLiability([asset.address]), 10000n);
  });

  it("rejects treasury underpayment despite sufficient surplus", async () => {
    const { market, asset, supply } = await setup();
    await supply();
    await asset.write.mint([market.address, 100n]);
    await asset.write.configure([market.address, 0n, -1n, 0n, 0]);
    await assert.rejects(market.write.collectProtocolFees([asset.address, 10n]), /UnsupportedToken/);
    assert.equal(await surplus(market, asset), 100n);
    assert.equal(await asset.read.balanceOf([fee.account.address]), 0n);
  });

  it("collects an arbitrary donated ERC-20 without a Tick or liability entry", async () => {
    const { market } = await setup();
    const orphan = getContract({
      address: (await viem.deployContract("AdversarialToken")).address,
      abi: adversarialTokenAbi,
      client: { public: client, wallet: fee },
    });
    await orphan.write.mint([market.address, 19n]);
    await market.write.collectProtocolFees([orphan.address, await surplus(market, orphan)], {
      account: keeper.account,
    });
    assert.equal(await orphan.read.balanceOf([fee.account.address]), 19n);
    assert.equal(await market.read.tokenLiability([orphan.address]), 0n);
  });

  it("blocks callbacks into collection and multicall while preserving the outer collection", async () => {
    const { market } = await setup();
    const token = getContract({
      address: (await viem.deployContract("ReentrantToken")).address,
      abi: reentrantTokenAbi,
      client: { public: client, wallet: fee },
    });
    const call = encodeFunctionData({
      abi: market.abi,
      functionName: "collectProtocolFees",
      args: [token.address, 1n],
    });
    for (const callback of [call, encodeFunctionData({ abi: market.abi, functionName: "multicall", args: [[call]] })]) {
      await token.write.mint([market.address, 7n]);
      await token.write.arm([market.address, callback]);
      if ((await surplus(market, token)) > 0n)
        await market.write.collectProtocolFees([token.address, await surplus(market, token)]);
      assert.equal(await token.read.attempted(), true);
      assert.equal(await token.read.succeeded(), false);
      assert.equal(await token.read.balanceOf([market.address]), 0n);
    }
    assert.equal(await token.read.balanceOf([fee.account.address]), 14n);
  });

  for (const [credit, debit] of [
    [1n, 0n],
    [1n, 1n],
    [0n, 1n],
    [0n, -1n],
  ] as const) {
    it(`accepts recipient excess ${credit} and sender extra debit ${debit} only with backing`, async () => {
      const { market, asset, tick, supply, withdraw, backed } = await setup();
      await supply();
      await asset.write.mint([market.address, 2n]);
      await asset.write.configure([market.address, 0n, credit, debit, 0]);
      const before = await asset.read.balanceOf([supplier.account.address]);
      await withdraw(1n);
      assert.equal((await asset.read.balanceOf([supplier.account.address])) - before, 1n + credit);
      assert.equal(await market.read.tokenLiability([asset.address]), 9999n);
      assert.equal((await market.read.getTick([tick])).availableSupply, 9999n);
      assert.equal(await surplus(market, asset), 2n - debit);
      await backed();
    });
  }

  it("rolls back extra sender debit without surplus, including cross-Tick backing", async () => {
    const { market, asset, tick, create, direction, supply, withdraw } = await setup();
    await supply(100n);
    const second = await create(direction, 2n);
    await market.write.supply([second, 10000n, zeroAddress], { account: supplier.account });
    await asset.write.configure([market.address, 0n, 0n, 1n, 0]);
    const before = await asset.read.balanceOf([supplier.account.address]);
    await assert.rejects(withdraw(1n), /Invariant/);
    assert.equal(await market.read.tokenLiability([asset.address]), 10100n);
    assert.equal((await market.read.getTick([tick])).availableSupply, 100n);
    assert.equal(await asset.read.balanceOf([supplier.account.address]), before);
  });

  it("enforces final reconciliation for extra debit and permits a safe partial collection", async () => {
    const { market, asset, supply } = await setup();
    await supply();
    await asset.write.mint([market.address, 2n]);
    await asset.write.configure([market.address, 0n, 0n, 1n, 0]);
    await assert.rejects(market.write.collectProtocolFees([asset.address, 2n]), /Invariant/);
    assert.equal(await surplus(market, asset), 2n);
    assert.equal(await asset.read.balanceOf([fee.account.address]), 0n);
    await market.write.collectProtocolFees([asset.address, 1n]);
    assert.equal(await surplus(market, asset), 0n);
    assert.equal(await asset.read.balanceOf([fee.account.address]), 1n);
    assert.equal(await market.read.tokenLiability([asset.address]), 10000n);
  });

  it("accepts positive rebases, consumes surplus first on negative rebases and rejects deficits", async () => {
    const { market, asset, quote, tick, supply, withdraw } = await setup();
    await supply();
    await asset.write.rebase([market.address, 10n]);
    await asset.write.rebase([market.address, -9n]);
    await withdraw(1n);
    assert.equal(await surplus(market, asset), 1n);
    await asset.write.rebase([market.address, -2n]);
    await assert.rejects(market.write.collectProtocolFees([asset.address, 1n]), /Invariant/);
    await assert.rejects(withdraw(1n), /Invariant/);
    await assert.rejects(market.write.settle([tick]), /Invariant/);
    assert.equal(await market.read.tokenLiability([asset.address]), 9999n);
    // Deficit in an otherwise untouched Quote role is checked on Supply too.
    await asset.write.rebase([market.address, 1n]);
    await market.write.use([tick, 1000n, MAX, MAX, zeroAddress], { account: taker.account });
    await quote.write.rebase([market.address, -1n]);
    await assert.rejects(supply(1n), /Invariant/);
    await assert.rejects(withdraw(1n), /Invariant/);
  });

  for (const mode of [0, 1, 2, 3]) {
    it(`handles ERC-20 return mode ${mode} atomically`, async () => {
      const { market, asset, supply, withdraw } = await setup();
      await asset.write.configure([market.address, 0n, 0n, 0n, mode]);
      if (mode > 1) {
        await assert.rejects(supply());
        assert.equal(await market.read.tokenLiability([asset.address]), 0n);
        assert.equal(await asset.read.balanceOf([market.address]), 0n);
      } else {
        await supply();
        await withdraw(1n);
        assert.equal(await market.read.tokenLiability([asset.address]), 9999n);
      }
    });
  }

  for (const inbound of [true, false]) {
    it(`rejects ${inbound ? "inbound" : "outbound"} underpayment even with existing surplus`, async () => {
      const { market, asset, supply, withdraw } = await setup();
      await supply();
      await asset.write.mint([market.address, 100n]);
      await asset.write.configure([market.address, inbound ? -1n : 0n, inbound ? 0n : -1n, 0n, 0]);
      await assert.rejects(inbound ? supply(1n) : withdraw(1n), /UnsupportedToken/);
      assert.equal(await market.read.tokenLiability([asset.address]), 10000n);
      assert.equal(await surplus(market, asset), 100n);
    });
  }

  for (const inbound of [true, false]) {
    it(`rejects a decreasing ${inbound ? "protocol" : "recipient"} balance without arithmetic underflow`, async () => {
      const { market, asset, supply, withdraw } = await setup();
      await supply();
      await asset.write.configure([market.address, inbound ? -2n : 0n, inbound ? 0n : -2n, 0n, 0]);
      await assert.rejects(inbound ? supply(1n) : withdraw(1n), /UnsupportedToken/);
      assert.equal(await market.read.tokenLiability([asset.address]), 10000n);
    });
  }

  for (const mode of [1, 2, 3]) {
    it(`rolls back dynamically changing balance report mode ${mode}`, async () => {
      const { market, asset, supply, withdraw } = await setup();
      await supply();
      await asset.write.setBalanceMode([0, mode]);
      await assert.rejects(supply(1n));
      await assert.rejects(withdraw(1n));
      assert.equal(await asset.read.balanceMode(), 0);
      assert.equal(await market.read.tokenLiability([asset.address]), 10000n);
      assert.equal(await surplus(market, asset), 0n);
      await asset.write.setBalanceMode([mode, 0]);
      await assert.rejects(market.write.collectProtocolFees([asset.address, 1n]));
    });
  }

  it("aggregates many Ticks and both token roles without collecting escrow or proceeds", async () => {
    const { market, asset, quote, tick, reverse, create, direction, backed } = await setup();
    let a = 0n,
      q = 0n,
      feesA = 0n,
      feesQ = 0n;
    for (let i = 1; i <= 12; i++) {
      const forward = i % 2 === 1;
      const id = i === 1 ? tick : i === 2 ? reverse : await create(forward ? direction : 1 - direction, BigInt(i));
      const amount = BigInt(1000 + i * 123);
      await market.write.supply([id, amount, zeroAddress], { account: supplier.account });
      if (forward) a += amount;
      else q += amount;
      const x = amount / 3n;
      await market.write.use([id, x, MAX, MAX, zeroAddress], { account: taker.account });
      if (forward) {
        a -= x;
        q += x;
      } else {
        q -= x;
        a += x;
      }
      await market.write.swap([id, x, MAX, MAX, zeroAddress], { account: taker.account });
      if (forward) {
        a -= x;
        q += x - x / 100n;
        feesQ += x / 100n;
      } else {
        q -= x;
        a += x - x / 100n;
        feesA += x / 100n;
      }
      assert.equal(await market.read.tokenLiability([asset.address]), a);
      assert.equal(await market.read.tokenLiability([quote.address]), q);
      await backed();
    }
    assert.equal(await surplus(market, asset), feesA);
    assert.equal(await surplus(market, quote), feesQ);
    await market.write.collectProtocolFees([asset.address, await surplus(market, asset)], { account: keeper.account });
    await market.write.collectProtocolFees([quote.address, await surplus(market, quote)], { account: keeper.account });
    assert.equal(await asset.read.balanceOf([market.address]), a);
    assert.equal(await quote.read.balanceOf([market.address]), q);
  });

  for (const action of ["use", "swap", "repay", "collect"] as const) {
    for (const covered of [false, true]) {
      it(`${action} accepts extra outgoing debit only when surplus covers it (${covered})`, async () => {
        const { market, asset, quote, tick, reverse, supply, backed } = await setup();
        await supply();
        // Quote also backs another Tick, so the token can debit other reserves;
        // the protocol must reject that debit itself rather than rely on token failure.
        await market.write.supply([reverse, 2000n, zeroAddress], { account: supplier.account });
        if (action === "repay") {
          await market.write.use([tick, 1000n, MAX, MAX, zeroAddress], { account: taker.account });
        } else if (action === "collect") {
          await market.write.swap([tick, 1000n, MAX, MAX, zeroAddress], { account: taker.account });
          if ((await surplus(market, quote)) > 0n)
            await market.write.collectProtocolFees([quote.address, await surplus(market, quote)]);
        }
        const outgoing = action === "use" || action === "swap" ? asset : quote;
        if (covered) await outgoing.write.mint([market.address, 1n]);
        await outgoing.write.configure([market.address, 0n, 0n, 1n, 0]);
        const recipient = action === "collect" ? supplier.account.address : taker.account.address;
        const snapshot = async () => ({
          assetBalance: await asset.read.balanceOf([market.address]),
          quoteBalance: await quote.read.balanceOf([market.address]),
          assetLiability: await market.read.tokenLiability([asset.address]),
          quoteLiability: await market.read.tokenLiability([quote.address]),
          recipientBalance: await outgoing.read.balanceOf([recipient]),
          tick: await market.read.getTick([tick]),
          active: await market.read.getDomain([tick, 0]),
          exit: await market.read.getDomain([tick, 1]),
          nextPosition: await market.read.nextPositionId(),
          positions: await market.read.getUsePositions([taker.account.address, 0n, 10n]),
        });
        const before = await snapshot();
        const execute = () =>
          action === "use"
            ? market.write.use([tick, 1000n, MAX, MAX, zeroAddress], { account: taker.account })
            : action === "swap"
              ? market.write.swap([tick, 1000n, MAX, MAX, zeroAddress], { account: taker.account })
              : action === "repay"
                ? market.write.repay([1n, MAX], { account: taker.account })
                : market.write.collect([tick], { account: supplier.account });
        if (!covered) {
          await assert.rejects(execute(), /Invariant/);
          assert.deepEqual(await snapshot(), before);
        } else {
          await execute();
          assert.equal(
            (await outgoing.read.balanceOf([recipient])) - before.recipientBalance,
            action === "collect" ? 990n : 1000n,
          );
          assert.equal(await surplus(market, outgoing), 0n);
          await backed();
        }
      });
    }
  }

  it("conserves all reserve/claim types across six mixed-role lifecycles and automatic Closes", async () => {
    const { market, asset, quote, tick, reverse, create, direction } = await setup();
    const states: { id: bigint; forward: boolean; days: bigint; model: TickModel }[] = [];
    const timestamp = async (hash: `0x${string}`) =>
      (
        await client.getBlock({
          blockNumber: (await client.getTransactionReceipt({ hash })).blockNumber,
        })
      ).timestamp;
    const check = async () => {
      let a = 0n,
        q = 0n,
        feeA = 0n,
        feeQ = 0n;
      for (const state of states) {
        const { model, forward } = state;
        a += forward ? model.assetLiability() : model.quoteLiability();
        q += forward ? model.quoteLiability() : model.assetLiability();
        feeA += forward ? model.assetFees : model.quoteFees;
        feeQ += forward ? model.quoteFees : model.assetFees;
      }
      assert.equal(await market.read.tokenLiability([asset.address]), a);
      assert.equal(await market.read.tokenLiability([quote.address]), q);
      assert.equal(await asset.read.balanceOf([market.address]), a + feeA);
      assert.equal(await quote.read.balanceOf([market.address]), q + feeQ);
    };
    for (let i = 0; i < 6; i++) {
      const forward = i % 2 === 0,
        days = BigInt(i + 1);
      const id = i === 0 ? tick : await create(forward ? direction : 1 - direction, days);
      const model = new TickModel();
      states.push({ id, forward, days, model });
      const supplied = await market.write.supply([id, 100000n, zeroAddress], { account: supplier.account });
      model.supply(supplier.account.address, 100000n, await timestamp(supplied));
      await check();
      const positionId = await market.read.nextPositionId();
      const full = fullTermYield(100000n, 0n, 40000n, days);
      const opened = await market.write.use([id, 40000n, full, MAX, zeroAddress], { account: taker.account });
      const openedAt = await timestamp(opened);
      model.use(40000n);
      await check();
      await market.write.use([id, 20000n, MAX, MAX, zeroAddress], { account: taker.account });
      model.use(20000n);
      await check();
      const withdrawal = await market.write.withdraw([id, 80000n, 0n, MAX], { account: supplier.account });
      model.withdraw(supplier.account.address, 80000n, await timestamp(withdrawal), days * 86400n);
      await check();
      await networkHelpers.time.increase(3600);
      const repaid = await market.write.repay([positionId, MAX], { account: taker.account });
      const gross = (full * ((await timestamp(repaid)) - openedAt) + days * 86400n - 1n) / (days * 86400n);
      model.assetFees += gross / 100n;
      model.repay(40000n, gross - gross / 100n);
      await check();
      await market.write.swap([id, 4000n, MAX, MAX, zeroAddress], { account: taker.account });
      model.swap(4000n, 3960n);
      model.quoteFees += 40n;
      await check();
      const earlyClaim = await market.write.collect([id], { account: supplier.account });
      model.collect(supplier.account.address, await timestamp(earlyClaim), days * 86400n);
      await check();
    }
    await networkHelpers.time.increase(7 * 86400);
    for (const { id, days, model } of states) {
      // Collect's mandatory cursor step automatically closes the remaining mature Use.
      const claim = await market.write.collect([id], { account: supplier.account });
      model.close(20000n, 19800n);
      model.quoteFees += 200n;
      const expected = model.collect(supplier.account.address, await timestamp(claim), days * 86400n);
      const actual = parseEventLogs({
        abi: market.abi,
        logs: (await client.getTransactionReceipt({ hash: claim })).logs,
        eventName: "Collected",
      })[0].args;
      assert.equal(actual.exitQuote, expected.exitQuote);
      assert.equal(actual.activeQuote, expected.activeQuote);
      assert.equal(actual.activeYieldAsset, expected.activeYield);
      assert.equal(actual.exitYieldAsset, expected.exitYield);
      await check();
      const withdrawn = await market.write.withdraw([id, MAX, 0n, MAX], { account: supplier.account });
      model.withdraw(supplier.account.address, MAX, await timestamp(withdrawn), days * 86400n);
      await check();
    }
    for (const token of [asset, quote])
      await market.write.collectProtocolFees([token.address, await surplus(market, token)], {
        account: keeper.account,
      });
    for (const { model } of states) {
      model.assetFees = 0n;
      model.quoteFees = 0n;
    }
    await check();
    // The unused reverse Tick remains empty; no unused-market liability is invented.
    assert.equal((await market.read.getTick([reverse])).activePrincipal, 0n);
  });

  it("multicall rolls back an earlier claim if a later transfer would underfund reserves", async () => {
    const { market, asset, tick, supply } = await setup();
    await supply();
    await asset.write.mint([market.address, 1n]);
    await asset.write.configure([market.address, 0n, 0n, 1n, 0]);
    const call = encodeFunctionData({ abi: market.abi, functionName: "withdraw", args: [tick, 1n, 0n, MAX] });
    await assert.rejects(market.write.multicall([[call, call]], { account: supplier.account }), /Invariant/);
    assert.equal(await market.read.tokenLiability([asset.address]), 10000n);
    assert.equal(await surplus(market, asset), 1n);
  });
});
