import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeAbiParameters, keccak256, parseEventLogs, zeroAddress } from "viem";

const M = 10n ** 30n;
const X = 10n ** 36n;
const DAY = 86_400n;
const UNLIMITED = (1n << 256n) - 1n;

describe("L-01 Withdraw redistribution bound", async () => {
  const { viem, networkHelpers } = await network.create();
  const [fee, alice, bob, taker] = await viem.getWalletClients();
  const client = await viem.getPublicClient();

  async function reproduction() {
    const asset = await viem.deployContract("MockERC20", ["Asset", "AST", 18]);
    const quote = await viem.deployContract("MockERC20", ["Quote", "QUO", 18]);
    const market = await viem.deployContract("YieldOrders", [fee.account.address]);
    await market.write.createPair([asset.address, quote.address]);
    const [pair] = await market.read.getPair([asset.address, quote.address]);
    const direction = asset.address.toLowerCase() < quote.address.toLowerCase() ? 0 : 1;
    const id = BigInt(
      keccak256(
        encodeAbiParameters(
          [{ type: "uint256" }, { type: "uint8" }, { type: "int32" }, { type: "uint64" }],
          [pair, direction, 0, 300n],
        ),
      ),
    );
    await market.write.createTick([pair, direction, 0, 300n]);
    for (const actor of [alice, bob, taker]) {
      await asset.write.mint([actor.account.address, 10n ** 33n]);
      await quote.write.mint([actor.account.address, 10n ** 33n]);
      await asset.write.approve([market.address, UNLIMITED], { account: actor.account });
      await quote.write.approve([market.address, UNLIMITED], { account: actor.account });
    }
    await market.write.supply([id, M - 2n, zeroAddress], { account: alice.account });
    await market.write.supply([id, 1n, zeroAddress], { account: bob.account });
    for (let i = 0; i < 2; i++) {
      const positionId = await market.read.nextPositionId();
      await market.write.use([id, M - 1n, M, UNLIMITED, zeroAddress], { account: taker.account });
      const p = await market.read.getPosition([positionId]);
      await networkHelpers.time.setNextBlockTimestamp(Number(p.openedAt + 299n * DAY));
      await market.write.repay([positionId, M], { account: taker.account });
    }
    await market.write.supply([id, 1n, zeroAddress], { account: alice.account });
    const position = await market.read.getEarnPosition([alice.account.address, id]);
    assert.ok(position.outstandingActiveYieldAsset > M);
    const nextTime = (await client.getBlock()).timestamp + 1n;
    const forfeiture = (amount: bigint) => {
      const attributable = (position.outstandingActiveYieldAsset * amount * X) / position.activePrincipalX36;
      const vested = (attributable * (nextTime - position.timestamp)) / (300n * DAY);
      return attributable - vested;
    };
    const amountAtLeast = (target: bigint) => {
      let low = 1n,
        high = position.activePrincipal;
      while (low < high) {
        const middle = (low + high) / 2n;
        if (forfeiture(middle) >= target) high = middle;
        else low = middle + 1n;
      }
      return low;
    };
    const state = async () => ({
      tick: await market.read.getTick([id]),
      active: await market.read.getDomain([id, 0]),
      earnAlice: await market.read.getEarnPosition([alice.account.address, id]),
      earnBob: await market.read.getEarnPosition([bob.account.address, id]),
      assetBalance: await asset.read.balanceOf([market.address]),
      quoteBalance: await quote.read.balanceOf([market.address]),
      aliceAsset: await asset.read.balanceOf([alice.account.address]),
      bobAsset: await asset.read.balanceOf([bob.account.address]),
      assetLiability: await market.read.tokenLiability([asset.address]),
      quoteLiability: await market.read.tokenLiability([quote.address]),
      assetFees: await market.read.accruedProtocolFees([asset.address]),
      nextPositionId: await market.read.nextPositionId(),
    });
    return { asset, quote, market, id, position, nextTime, forfeiture, amountAtLeast, state };
  }

  for (const boundary of ["below", "equal", "above"] as const) {
    it(`${boundary} MAX_ACCOUNTING_AMOUNT`, async () => {
      const { asset, quote, market, id, position, nextTime, forfeiture, amountAtLeast, state } =
        await networkHelpers.loadFixture(reproduction);
      const amount =
        boundary === "above"
          ? position.activePrincipal
          : boundary === "equal"
            ? amountAtLeast(M)
            : amountAtLeast(M) - 1n;
      assert.ok(amount > 0n);
      const expected = forfeiture(amount);
      if (boundary === "below") assert.ok(expected < M);
      if (boundary === "equal") assert.equal(expected, M);
      if (boundary === "above") assert.ok(expected > M);
      await networkHelpers.time.setNextBlockTimestamp(Number(nextTime));
      if (boundary === "above") {
        const before = await state();
        await assert.rejects(
          market.write.withdraw([id, amount, 0n, UNLIMITED], { account: alice.account }),
          /InvalidInput/,
        );
        assert.deepEqual(await state(), before, "reverted Withdraw changes no economic or custody state");
        await networkHelpers.time.increase(Number(300n * DAY));
        const claim = await market.read.getEarnPosition([alice.account.address, id]);
        assert.equal(claim.claimableActiveYieldAsset, claim.outstandingActiveYieldAsset);
        const aliceBefore = (await asset.read.balanceOf([alice.account.address])) as bigint;
        await market.write.collect([id], { account: alice.account });
        assert.equal(
          ((await asset.read.balanceOf([alice.account.address])) as bigint) - aliceBefore,
          claim.outstandingActiveYieldAsset,
        );
        await market.write.withdraw([id, amount, 0n, UNLIMITED], { account: alice.account });
        assert.equal((await market.read.getEarnPosition([alice.account.address, id])).outstandingActiveYieldAsset, 0n);
      } else {
        const hash = await market.write.withdraw([id, amount, 0n, UNLIMITED], { account: alice.account });
        const event = parseEventLogs({
          abi: market.abi,
          logs: (await client.getTransactionReceipt({ hash })).logs,
          eventName: "Withdrawn",
        })[0].args;
        assert.equal(event.forfeitedYield, expected);
        assert.equal(await asset.read.balanceOf([market.address]), await market.read.tokenLiability([asset.address]));
        assert.equal(await quote.read.balanceOf([market.address]), await market.read.tokenLiability([quote.address]));
      }
    });
  }
});
