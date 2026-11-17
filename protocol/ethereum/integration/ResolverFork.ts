import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeFunctionData, erc20Abi, parseAbi, toHex, type Address, type Hex } from "viem";
import { UniswapClient } from "@yld-cx/sdk/uniswap";
import manifest from "../deployments/resolver.json" with { type: "json" };

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const permit2Abi = parseAbi([
  "function allowance(address owner,address token,address spender) view returns(uint160,uint48,uint48)",
]);
const WETH: Record<string, Address> = {
  base: "0x4200000000000000000000000000000000000006",
  ethereum: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  robinhood: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
};
const USDC: Record<string, Address> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  ethereum: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  robinhood: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
};
const BTC: Record<string, Address> = {
  base: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
  ethereum: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
};
const ZERO = "0x0000000000000000000000000000000000000000";

describe("live API calldata on real Morpho/Universal Router forks", async () => {
  const { viem, networkName, networkHelpers } = await network.create();
  const slug = networkName.replace("Fork", "");
  if (!WETH[slug]) throw new Error("Select baseFork, ethereumFork or robinhoodFork");
  if (!process.env.UNISWAP_API_KEY) throw new Error("Server UNISWAP_API_KEY is required");
  const client = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const chainId = await client.getChainId();
  const config = manifest.chains[String(chainId) as keyof typeof manifest.chains];
  const weth = WETH[slug],
    usdc = USDC[slug];
  const api = new UniswapClient({ apiKey: process.env.UNISWAP_API_KEY });
  async function quote(
    mode: "wallet-router" | "resolver-router",
    swapper: Address,
    amount: bigint,
    tokenIn = weth,
    tokenOut = usdc,
  ) {
    const deadline = Number((await client.getBlock()).timestamp) + 600;
    const result = await api.quote({
      chainId: chainId as 1 | 8453 | 4663,
      mode,
      tokenIn,
      tokenOut,
      amount: String(amount),
      swapper,
      slippage: 1,
      deadline,
    });
    assert.equal(result.transaction.to.toLowerCase(), config.router.toLowerCase());
    assert.equal(BigInt(result.transaction.value), 0n);
    assert.equal(result.chainId, chainId);
    return { ...result, deadline: BigInt(deadline) };
  }
  const amount = 10n ** 15n;
  async function wrap(amount: bigint) {
    await wallet.writeContract({
      address: weth,
      abi: parseAbi(["function deposit() payable"]),
      functionName: "deposit",
      value: amount,
    });
  }
  it("executes RPC-planned exact ERC20 approval, Permit2 authorization and router swaps atomically in both directions", async (t) => {
    const snapshot = await networkHelpers.takeSnapshot();
    t.after(() => snapshot.restore());
    const account = await viem.deployContract("AtomicWalletHarness");
    await wrap(amount);
    await wallet.writeContract({
      address: weth,
      abi: erc20Abi,
      functionName: "transfer",
      args: [account.address, amount],
    });
    async function walletSwap(tokenIn: Address, tokenOut: Address, input: bigint) {
      const allowance = await client.readContract({
        address: tokenIn,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account.address, PERMIT2],
      });
      const swap = await quote("wallet-router", account.address, input, tokenIn, tokenOut);
      const approval = (amount: bigint) => ({
        to: tokenIn,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PERMIT2, amount] }),
      });
      const calls = [
        ...(allowance < input ? [...(allowance > 0n ? [approval(0n)] : []), approval(input)] : []),
        swap.permitTransaction,
        swap.transaction,
      ].filter((tx): tx is { to: Address; data: Hex } => !!tx);
      const before = await client.readContract({
        address: tokenOut,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account.address],
      });
      const hash = await account.write.execute([calls.map((tx) => tx.to), calls.map((tx) => tx.data)], {
        gas: 3000000n,
      });
      assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success");
      assert.equal(
        await client.readContract({
          address: tokenIn,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [account.address],
        }),
        0n,
      );
      assert.ok(
        (await client.readContract({
          address: tokenOut,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [account.address],
        })) -
          before >=
          BigInt(swap.minimumAmountOut),
      );
      assert.equal(
        (
          await client.readContract({
            address: PERMIT2,
            abi: permit2Abi,
            functionName: "allowance",
            args: [account.address, tokenIn, config.router as Address],
          })
        )[0],
        0n,
      );
      return hash;
    }
    const buyHash = await walletSwap(weth, usdc, amount);
    const received = await client.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
    const sellHash = await walletSwap(usdc, weth, received);
    console.log(
      JSON.stringify({ proof: "wallet-permit2", chainId, router: config.router, permit2: PERMIT2, buyHash, sellHash }),
    );
  });
  for (const mode of BTC[slug] ? [0, 1, 2] : [0, 1])
    it(`runs ${["Quote-first", "Asset-first", "Third-token"][mode]} with a real Morpho flash loan and shared API calldata`, async (t) => {
      const snapshot = await networkHelpers.takeSnapshot();
      t.after(() => snapshot.restore());
      const yld = await viem.deployContract("YieldOrders", [wallet.account.address]);
      const resolver = await viem.deployContract("YieldResolver", [
        yld.address,
        config.morpho,
        config.router,
        config.permit2,
      ]);
      await yld.write.createPair([weth, usdc]);
      const pair = await yld.read.getPair([weth, usdc]);
      const direction = BigInt(weth) < BigInt(usdc) ? 0 : 1;
      const creation = await yld.simulate.createTick([pair[0], direction, -210000, 7n]);
      await wallet.writeContract(creation.request);
      const tickId = creation.result;
      await wrap(amount);
      await wallet.writeContract({
        address: weth,
        abi: erc20Abi,
        functionName: "approve",
        args: [yld.address, amount],
      });
      await yld.write.supply([tickId, amount, ZERO]);
      const tick = await yld.read.getTick([tickId]);
      const cost = (amount * tick.priceX128 + (1n << 128n) - 1n) >> 128n;
      const flashToken = mode === 0 ? usdc : mode === 1 ? weth : BTC[slug];
      const flashAmount = mode === 0 ? cost : mode === 1 ? amount : 2000n;
      const swap = await quote("resolver-router", resolver.address, amount, weth, mode === 2 ? flashToken : usdc);
      const pre =
        mode === 2 ? await quote("resolver-router", resolver.address, flashAmount, flashToken, usdc) : undefined;
      const order = {
        tickId,
        amount,
        flashToken,
        flashAmount,
        deadline: swap.deadline,
        preSwapData: mode === 0 ? ("0x" as Hex) : mode === 2 ? pre!.transaction.data : swap.transaction.data,
        postSwapData: mode === 1 ? ("0x" as Hex) : swap.transaction.data,
      };
      let simulation;
      try {
        simulation = await resolver.simulate.execute([[order], wallet.account.address], { gas: 4000000n });
      } catch (error) {
        // Diagnostic eth_call only: expose a failed isolated execution's error,
        // which the public batch intentionally reduces to a bounded fingerprint.
        await client.simulateContract({
          address: resolver.address,
          abi: resolver.abi,
          functionName: "executeOne",
          args: [order, wallet.account.address],
          account: resolver.address,
          gas: 2000000n,
          stateOverride: [
            {
              address: resolver.address,
              balance: 10n ** 18n,
              stateDiff: [{ slot: toHex(0, { size: 32 }), value: toHex(1, { size: 32 }) }],
            },
          ],
        });
        throw error;
      }
      assert.equal(simulation.result, 1n);
      const hash = await resolver.write.execute([[order], wallet.account.address], { gas: 4000000n });
      assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success");
      for (const token of new Set([weth, usdc, flashToken]))
        assert.equal(
          await client.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [resolver.address],
          }),
          0n,
        );
      for (const token of [weth, usdc, ...(BTC[slug] ? [BTC[slug]] : [])]) {
        assert.equal(
          await client.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "allowance",
            args: [resolver.address, PERMIT2],
          }),
          0n,
        );
        assert.equal(
          (
            await client.readContract({
              address: PERMIT2,
              abi: permit2Abi,
              functionName: "allowance",
              args: [resolver.address, token, config.router as Address],
            })
          )[0],
          0n,
        );
      }
      console.log(
        JSON.stringify({
          proof: "resolver",
          mode,
          chainId,
          hash,
          routeId: swap.routeId,
        }),
      );
    });
});
