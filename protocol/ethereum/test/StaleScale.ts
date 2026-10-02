import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeAbiParameters, keccak256, zeroAddress } from "viem";
import { F, P0, TickModel, X } from "./reference.js";

const M = 10n ** 30n;
const UNLIMITED = (1n << 256n) - 1n;

describe("passive provider beyond the eight-scale gain span", async () => {
  const { viem, networkHelpers } = await network.create();
  const [fee, passive, active, buyer] = await viem.getWalletClients();
  const client = await viem.getPublicClient();

  it("retains k..k+8 gains and bounds omitted principal and funded dust after 9+ transitions", async () => {
    const asset = await viem.deployContract("MockERC20", ["Asset", "AST", 18]);
    const quote = await viem.deployContract("MockERC20", ["Quote", "QUO", 18]);
    const market = await viem.deployContract("YieldOrders", [fee.account.address]);
    const model = new TickModel();
    await market.write.createPair([asset.address, quote.address]);
    const [pair] = await market.read.getPair([asset.address, quote.address]);
    const direction = asset.address.toLowerCase() < quote.address.toLowerCase() ? 0 : 1;
    const id = BigInt(
      keccak256(
        encodeAbiParameters(
          [{ type: "uint256" }, { type: "uint8" }, { type: "int32" }, { type: "uint64" }],
          [pair, direction, 0, 1n],
        ),
      ),
    );
    await market.write.createTick([pair, direction, 0, 1n]);
    for (const who of [passive, active, buyer]) {
      await asset.write.mint([who.account.address, 10n ** 33n]);
      await quote.write.mint([who.account.address, 10n ** 33n]);
      await asset.write.approve([market.address, UNLIMITED], { account: who.account });
      await quote.write.approve([market.address, UNLIMITED], { account: who.account });
    }
    for (const who of [passive, active]) {
      const hash = await market.write.supply([id, M / 2n, zeroAddress], { account: who.account });
      const time = (await client.getBlock({ blockNumber: (await client.getTransactionReceipt({ hash })).blockNumber }))
        .timestamp;
      model.supply(who.account.address, M / 2n, time);
    }
    const snapshot = { ...model.get(passive.account.address).active };
    const deadline = async () => (await client.getBlock()).timestamp + 1_000_000n;
    for (let step = 0; step < 4; step++) {
      const amount = M - 1n;
      const feeAmount = amount / 100n;
      await market.write.swap([id, amount, amount, await deadline(), zeroAddress], { account: buyer.account });
      model.swap(amount, amount - feeAmount);
      model.quoteFees += feeAmount;
      const domain = await market.read.getDomain([id, 0]);
      assert.equal(domain.P, model.active.P);
      assert.equal(domain.scale, BigInt(model.active.scale));
      if (step < 3) {
        const hash = await market.write.supply([id, amount, zeroAddress], { account: active.account });
        const time = (
          await client.getBlock({ blockNumber: (await client.getTransactionReceipt({ hash })).blockNumber })
        ).timestamp;
        model.supply(active.account.address, amount, time);
      }
    }
    assert.ok(model.active.scale >= 9);
    const compounded =
      (snapshot.initial * model.active.P) / snapshot.P / F ** BigInt(model.active.scale - snapshot.scale);
    assert.ok(compounded < 1n, "canonical compounded principal is below one X36 unit");
    const claim = await market.read.getEarnPosition([passive.account.address, id]);
    assert.equal(claim.activePrincipalX36, 0n);
    const canonicalGain = model.active.gainWithFraction(snapshot, "quote", 0n);
    assert.equal(claim.claimableActiveQuote, canonicalGain, "gain includes only scales k through k+8");
    const before = (await quote.read.balanceOf([passive.account.address])) as bigint;
    await market.write.collect([id], { account: passive.account });
    assert.equal(((await quote.read.balanceOf([passive.account.address])) as bigint) - before, canonicalGain);
    assert.equal((await market.read.getEarnPosition([passive.account.address, id])).claimableActiveQuote, 0n);

    const topUp = await market.write.supply([id, 2n, zeroAddress], { account: active.account });
    const topUpTime = (
      await client.getBlock({ blockNumber: (await client.getTransactionReceipt({ hash: topUp })).blockNumber })
    ).timestamp;
    model.supply(active.account.address, 2n, topUpTime);
    const withdrawal = await market.write.withdraw([id, 2n, 0n, UNLIMITED], { account: active.account });
    const withdrawalTime = (
      await client.getBlock({ blockNumber: (await client.getTransactionReceipt({ hash: withdrawal })).blockNumber })
    ).timestamp;
    const expected = model.withdraw(active.account.address, 2n, withdrawalTime);
    assert.equal((await market.read.getTick([id])).availableSupply, model.available);
    assert.equal(expected.availableOut, 2n);
    const activeClaim = await market.read.getEarnPosition([active.account.address, id]);
    const activeBefore = (await quote.read.balanceOf([active.account.address])) as bigint;
    await market.write.collect([id], { account: active.account });
    assert.equal(
      ((await quote.read.balanceOf([active.account.address])) as bigint) - activeBefore,
      activeClaim.claimableActiveQuote,
    );
    await market.write.collectProtocolFees([quote.address]);
    const residualQuote = await market.read.tokenLiability([quote.address]);
    assert.equal(await quote.read.balanceOf([market.address]), residualQuote);
    assert.ok(residualQuote <= 8n, "only bounded fixed-point dust remains after funded Quote claims");
    assert.equal(await asset.read.balanceOf([market.address]), await market.read.tokenLiability([asset.address]));
  });
});
