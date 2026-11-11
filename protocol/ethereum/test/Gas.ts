import { surplus } from "./helpers/custody.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { zeroAddress, type Hex } from "viem";
import { COMPILER_DESCRIPTION, PROTOCOL_VERSION } from "../hardhat.config.js";
import type {} from "../artifacts/contracts/test/MockERC20.sol/artifacts.js";
import { readArtifact } from "../scripts/deployment.js";

const MAX = 2n ** 256n - 1n;
const E = 10n ** 18n;
describe("lifecycle gas", async () => {
  const { viem, networkHelpers } = await network.create();
  const client = await viem.getPublicClient();
  const [fee, supplier, taker] = await viem.getWalletClients();
  it("records successful lifecycle actions using the current implementation", async () => {
    const asset = await viem.deployContract("MockERC20", ["Asset", "AST", 18]);
    const quote = await viem.deployContract("MockERC20", ["Quote", "QUO", 18]);
    const market = await viem.deployContract("YieldOrders", [fee.account.address]);
    await market.write.createPair([asset.address, quote.address]);
    const [pair] = await market.read.getPair([asset.address, quote.address]);
    const direction = asset.address.toLowerCase() < quote.address.toLowerCase() ? 0 : 1;
    const { result: tick } = await market.simulate.createTick([pair, direction, 0, 1n]);
    await market.write.createTick([pair, direction, 0, 1n]);
    for (const token of [asset, quote])
      for (const user of [supplier, taker]) {
        await token.write.mint([user.account.address, 10n ** 25n]);
        await token.write.approve([market.address, MAX], { account: user.account });
      }
    const gas: Record<string, string> = {};
    const record = async (name: string, tx: Promise<Hex>) => {
      const receipt = await client.getTransactionReceipt({ hash: await tx });
      assert.equal(receipt.status, "success");
      gas[name] = receipt.gasUsed.toString();
      for (const token of [asset, quote]) {
        assert.ok(
          (await token.read.balanceOf([market.address])) >= (await market.read.tokenLiability([token.address])),
        );
      }
    };
    await record("Supply", market.write.supply([tick, 1000n * E, zeroAddress], { account: supplier.account }));
    await record("Use", market.write.use([tick, 100n * E, MAX, MAX, zeroAddress], { account: taker.account }));
    const position = await market.read.getPosition([1n]);
    await networkHelpers.time.setNextBlockTimestamp(position.openedAt + 3600n);
    await record("Repay", market.write.repay([1n, MAX], { account: taker.account }));
    await record("WithdrawUnvested", market.write.withdraw([tick, 10n * E, 0n, MAX], { account: supplier.account }));
    await record("Swap", market.write.swap([tick, 100n * E, MAX, MAX, zeroAddress], { account: taker.account }));
    await market.write.use([tick, 100n * E, MAX, MAX, zeroAddress], { account: taker.account });
    const mature = await market.read.getPosition([2n]);
    await networkHelpers.time.setNextBlockTimestamp(mature.maturity);
    await record("Close", market.write.close([2n]));
    await record("Withdraw", market.write.withdraw([tick, 100n * E, 0n, MAX], { account: supplier.account }));
    await record("Collect", market.write.collect([tick], { account: supplier.account }));
    await record("FeeCollection", market.write.collectProtocolFees([quote.address, await surplus(market, quote)]));
    const artifact = await readArtifact();
    console.log(
      JSON.stringify({
        version: PROTOCOL_VERSION,
        compiler: COMPILER_DESCRIPTION,
        runtimeBytes: (artifact.deployedBytecode.length - 2) / 2,
        creationBytes: (artifact.bytecode.length - 2) / 2,
        gas,
      }),
    );
  });
});
