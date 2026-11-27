import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  getAddress,
  http,
  parseAbi,
  parseEther,
  parseUnits,
  type Address,
  type EIP1193RequestFn,
  type Hex,
  type PublicClient,
} from "viem";
import { base } from "viem/chains";
import {
  coinbaseBatch,
  coinbaseOwnerBytes,
  coinbaseWalletAbi,
  coinbaseWalletDeployment,
  coinbaseWalletFactoryAbi,
  isCoinbaseOwner,
  verifyCoinbaseWallet,
} from "@yld-cx/sdk/coinbase";
import { createWorker } from "../src/index.ts";
import { handlerFetch, modernClient, newSigner, testEnv } from "./client.ts";

const forkUrl = process.env.YLD_FORK_RPC_URL;
const weth = "0x4200000000000000000000000000000000000006";
const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const { factory, implementation } = coinbaseWalletDeployment;
const mintAbi = parseAbi([
  "function deposit() payable",
  "function masterMinter() view returns (address)",
  "function configureMinter(address minter, uint256 allowance) returns (bool)",
  "function mint(address to, uint256 amount) returns (bool)",
]);

type Client = Awaited<ReturnType<typeof modernClient>>;
type Call = { to: Address; value: bigint; data: Hex };
type Plan = {
  chainId: number;
  account: Address;
  calls: { to: Address; value: string; data: Hex }[];
};

function forkMetadata(request: unknown) {
  return (
    request as EIP1193RequestFn<
      [
        {
          Method: "hardhat_metadata";
          Parameters: [];
          ReturnType: { forkedNetwork?: { chainId: number } };
        },
      ]
    >
  )({ method: "hardhat_metadata", params: [] });
}

function obj<T>(value: unknown) {
  return value as T;
}

async function tool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const answer = await client.callTool({ name, arguments: args });
  assert.equal(
    answer.isError ?? false,
    false,
    JSON.stringify(answer.structuredContent ?? answer.content),
  );
  assert.ok(answer.structuredContent);
  return obj<T>(answer.structuredContent);
}

test(
  "Base fork: official MCP client executes the protocol and three independent Coinbase wallet lifecycles",
  { skip: !forkUrl, timeout: 180_000 },
  async (t) => {
    const url = new URL(forkUrl!);
    assert.equal(url.protocol, "http:");
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    const transport = http(url.toString(), { retryCount: 0 });
    const rpc = createPublicClient({ chain: base, transport, cacheTime: 0 });
    const local = createTestClient({ chain: base, mode: "hardhat", transport });
    const wallet = createWalletClient({ chain: base, transport });
    const metadata = await forkMetadata(local.request);
    assert.equal(metadata.forkedNetwork?.chainId, base.id);
    assert.equal(await rpc.getChainId(), base.id);
    const snapshot = await local.snapshot();
    t.after(() => local.revert({ id: snapshot }));
    const [owner, outsider] = (await wallet.getAddresses()).map((address) =>
      getAddress(address),
    );
    const call = (to: Address, data: Hex, value = 0n): Call => ({
      to,
      data,
      value,
    });
    async function send(account: Address, transfer: Call) {
      const hash = await wallet.sendTransaction({ account, ...transfer });
      assert.equal(
        (await rpc.waitForTransactionReceipt({ hash })).status,
        "success",
      );
      return hash;
    }
    async function makeAccount(owner: Address, nonce: bigint) {
      const args = [[coinbaseOwnerBytes(owner)], nonce] as const;
      const address = await rpc.readContract({
        address: factory,
        abi: coinbaseWalletFactoryAbi,
        functionName: "getAddress",
        args,
      });
      await send(
        globalOwner,
        call(
          factory,
          encodeFunctionData({
            abi: coinbaseWalletFactoryAbi,
            functionName: "createAccount",
            args,
          }),
        ),
      );
      assert.equal(
        (await verifyCoinbaseWallet(rpc as PublicClient, address))
          .implementation,
        implementation,
      );
      assert.equal(
        await isCoinbaseOwner(rpc as PublicClient, address, owner),
        true,
      );
      return address;
    }

    const globalOwner = owner;
    const runId = BigInt(Date.now());
    const main = await makeAccount(owner, runId);
    const subs: Address[] = [];
    for (let i = 0n; i < 3n; i++) subs.push(await makeAccount(main, runId + i));
    assert.equal(new Set([main, ...subs]).size, 4);

    const mockWorker = createWorker({
      client: () => rpc as PublicClient,
      executionClient: rpc as PublicClient,
    });
    const fetch = handlerFetch(mockWorker, {
      ...testEnv,
      EXECUTION_ENABLED: "true",
    });
    const clients: Client[] = [];
    t.after(async () => {
      await Promise.all(clients.map((client) => client.close()));
    });
    const connect = async (
      path = "/",
      approve?: (message: string) => boolean,
    ) => {
      const client = await modernClient(fetch, path, approve);
      clients.push(client);
      return client;
    };

    const publicClient = await connect();
    assert.equal(
      (await tool<{ name: string }>(publicClient, "protocol")).name,
      "Yield Orders",
    );
    const networks = await tool<{ networks: { slug: string }[] }>(
      publicClient,
      "networks",
    );
    assert.ok(networks.networks.some(({ slug }) => slug === "base"));
    const markets = await tool<{ markets: { key: string }[] }>(
      publicClient,
      "markets",
      { limit: 1 },
    );
    assert.match(
      markets.markets[0].key,
      /4200000000000000000000000000000000000006.*833589/,
    );

    const transfer = (token: Address, recipient: Address, amount: bigint) =>
      call(
        token,
        encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [recipient, amount],
        }),
      );
    const addOwner = (sub: Address, address: Address) =>
      call(
        sub,
        encodeFunctionData({
          abi: coinbaseWalletAbi,
          functionName: "addOwnerAddress",
          args: [address],
        }),
      );
    const removeOwner = (sub: Address, address: Address, index: bigint) =>
      call(
        sub,
        encodeFunctionData({
          abi: coinbaseWalletAbi,
          functionName: "removeOwnerAtIndex",
          args: [index, coinbaseOwnerBytes(address)],
        }),
      );

    await send(
      owner,
      call(
        weth,
        encodeFunctionData({ abi: mintAbi, functionName: "deposit" }),
        parseEther("1"),
      ),
    );
    await send(owner, transfer(weth, main, parseEther("0.9")));
    const master = await rpc.readContract({
      address: usdc,
      abi: mintAbi,
      functionName: "masterMinter",
    });
    await local.impersonateAccount({ address: master });
    await local.setBalance({ address: master, value: parseEther("1") });
    await send(
      master,
      call(
        usdc,
        encodeFunctionData({
          abi: mintAbi,
          functionName: "configureMinter",
          args: [owner, parseUnits("10000", 6)],
        }),
      ),
    );
    await send(
      owner,
      call(
        usdc,
        encodeFunctionData({
          abi: mintAbi,
          functionName: "mint",
          args: [main, parseUnits("1000", 6)],
        }),
      ),
    );
    await local.stopImpersonatingAccount({ address: master });
    await send(
      owner,
      call(
        main,
        coinbaseBatch(
          subs.flatMap((sub, i) => [
            transfer(weth, sub, parseEther(String((i + 1) / 10))),
            transfer(usdc, sub, parseUnits(String((i + 1) * 100), 6)),
          ]),
        ),
      ),
    );

    const signers = [];
    for (const sub of subs) {
      const credential = await newSigner(fetch);
      const path = `/${sub}/${credential.secret}`;
      const agent = await connect(path, (message) => {
        assert.match(message, /Authorize this Base/);
        assert.ok(message.includes(sub));
        assert.match(message, /Estimated gas budget/);
        return true;
      });
      const info = await tool<{ signer: { authorized: boolean } }>(
        agent,
        "wallet",
      );
      assert.equal(info.signer.authorized, false);
      await send(
        owner,
        call(main, coinbaseBatch([addOwner(sub, credential.address)])),
      );
      const unfunded = await tool<{
        signer: { authorized: boolean; gasBalance: { eth: string } };
      }>(agent, "wallet");
      assert.equal(unfunded.signer.authorized, true);
      assert.equal(unfunded.signer.gasBalance.eth, "0");
      signers.push({ credential, path, agent });
    }
    const [maker, renter, taker] = signers;
    const limit = {
      operation: "provide",
      tokenA: weth,
      tokenB: usdc,
      asset: weth,
      price: "3000",
      durationDays: 2,
      amount: "0.03",
    };
    const limitQuote = await tool<{
      tickId: string;
      priceTick: number;
      requiredInput: { amount: string };
      available?: { amount: string };
    }>(maker.agent, "quote", limit);
    assert.equal(limitQuote.requiredInput.amount, "0.03");

    const needGas = await maker.agent.callTool({
      name: "execute",
      arguments: limit,
    });
    assert.equal(needGas.isError, true);
    assert.match(
      JSON.stringify(needGas.structuredContent),
      /needs Base ETH for gas/,
    );
    for (const { credential } of signers)
      await send(owner, call(credential.address, "0x", parseEther("0.03")));
    const denied = await connect(maker.path, () => false);
    assert.equal(
      (await tool<{ status: string }>(denied, "execute", limit)).status,
      "declined",
    );
    const unsupported = await connect(maker.path);
    assert.equal(
      (await tool<{ status: string }>(unsupported, "execute", limit)).status,
      "preparation_only",
    );
    const bad = await connect(`/${outsider}/${maker.credential.secret}`);
    assert.equal(
      (await bad.callTool({ name: "wallet", arguments: {} })).isError,
      true,
    );

    async function perform(client: Client, input: Record<string, unknown>) {
      const execution = await tool<{ status: string; hash: Hex }>(
        client,
        "execute",
        input,
      );
      assert.equal(execution.status, "submitted");
      const receipt = await tool<{
        status: string;
        events: { eventName: string }[];
      }>(client, "status", { hash: execution.hash });
      assert.equal(receipt.status, "confirmed");
      return receipt.events.map((event) => event.eventName);
    }
    assert.ok((await perform(maker.agent, limit)).includes("Supplied"));
    const tickId = limitQuote.tickId;
    const book = await tool<{
      asks: { tickId: string; available: { amount: string } }[];
      bids: { tickId: string }[];
      window: { complete: boolean };
    }>(publicClient, "book", {
      tokenA: weth,
      tokenB: usdc,
      centerTick: limitQuote.priceTick,
      stepTicks: 1,
      radius: 0,
      durationDays: 2,
    });
    assert.equal(book.window.complete, true);
    const ask = book.asks.find((level) => level.tickId === tickId);
    assert.ok(ask);
    assert.equal(
      parseEther(ask.available.amount) -
        parseEther(limitQuote.available?.amount ?? "0"),
      parseEther("0.03"),
    );
    const bid = {
      ...limit,
      asset: usdc,
      price: "0.000333333333333333",
      amount: "10",
    };
    const bidQuote = await tool<{ tickId: string; priceTick: number }>(
      taker.agent,
      "quote",
      bid,
    );
    assert.ok((await perform(taker.agent, bid)).includes("Supplied"));
    const bidBook = await tool<{ bids: { tickId: string }[] }>(
      publicClient,
      "book",
      {
        tokenA: weth,
        tokenB: usdc,
        centerTick: -bidQuote.priceTick,
        stepTicks: 1,
        radius: 0,
        durationDays: 2,
      },
    );
    assert.ok(bidBook.bids.some((level) => level.tickId === bidQuote.tickId));
    const deadline = async () => Number((await rpc.getBlock()).timestamp) + 300;
    const rent = { operation: "rent", tickId, amount: "0.005" };
    const terms = await tool<{
      requiredInput: { amount: string };
      fullTermYield: { amount: string };
      estimatedMaturity: string;
    }>(renter.agent, "quote", rent);
    assert.ok(Number(terms.requiredInput.amount) > 0);
    assert.ok(Number(terms.fullTermYield.amount) > 0);
    const rentRequest = {
      ...rent,
      maxFullTermYieldAsset: "0.0001",
      deadline: await deadline(),
    };
    assert.ok((await perform(renter.agent, rentRequest)).includes("UseOpened"));
    const renterPositions = await tool<{
      rentals: {
        positionId: string;
        maturity: string;
        repaymentNow: { amount: string };
      }[];
    }>(renter.agent, "portfolio");
    assert.equal(renterPositions.rentals.length, 1);
    assert.ok(Number(renterPositions.rentals[0].repaymentNow.amount) > 0.005);
    const repay = {
      operation: "repay",
      positionId: renterPositions.rentals[0].positionId,
      maxYieldAsset: "0.0001",
    };
    assert.ok((await perform(renter.agent, repay)).includes("TermRepaid"));

    const swap = { operation: "swap", tickId, amount: "0.001" };
    const cost = await tool<{
      requiredInput: { amount: string };
      swapFeeIncludedInQuote: { amount: string };
    }>(taker.agent, "quote", swap);
    assert.ok(Number(cost.swapFeeIncludedInQuote.amount) > 0);
    const balance = async (client: Client) =>
      tool<{ tokens: { amount: string }[] }>(client, "balances", {
        tokens: [weth, usdc],
      });
    const before = await balance(taker.agent);
    assert.ok(
      (
        await perform(taker.agent, {
          ...swap,
          maxQuoteIn: cost.requiredInput.amount,
          deadline: await deadline(),
        })
      ).includes("ImmediateSwap"),
    );
    const after = await balance(taker.agent);
    assert.equal(
      parseEther(after.tokens[0].amount) - parseEther(before.tokens[0].amount),
      parseEther("0.001"),
    );
    assert.equal(
      parseUnits(before.tokens[1].amount, 6) -
        parseUnits(after.tokens[1].amount, 6),
      parseUnits(cost.requiredInput.amount, 6),
    );

    await perform(renter.agent, { ...rentRequest, deadline: await deadline() });
    const active = await tool<{
      rentals: { positionId: string; maturity: string }[];
    }>(renter.agent, "portfolio");
    await local.increaseTime({
      seconds:
        Number(active.rentals[0].maturity) -
        Number((await rpc.getBlock()).timestamp) +
        2,
    });
    await local.mine({ blocks: 1 });
    const matured = await tool<{ rentals: { status: string }[] }>(
      renter.agent,
      "portfolio",
    );
    assert.equal(matured.rentals[0].status, "matured");
    const closePreview = await tool<{ status: string }>(
      publicClient,
      "simulate",
      {
        account: outsider,
        operation: "close",
        positionId: active.rentals[0].positionId,
      },
    );
    assert.equal(closePreview.status, "simulated");
    assert.ok(
      (await perform(renter.agent, { operation: "settle", tickId })).includes(
        "TermClosed",
      ),
    );
    assert.equal(
      (await tool<{ rentals: unknown[] }>(renter.agent, "portfolio")).rentals
        .length,
      0,
    );
    await perform(maker.agent, { operation: "collect", tickId });
    await perform(maker.agent, {
      operation: "withdraw",
      tickId,
      amount: "0.001",
      minImmediateAssetOut: "0",
      deadline: await deadline(),
    });

    const replacement = await newSigner(fetch);
    await send(
      owner,
      call(
        main,
        coinbaseBatch([
          call(
            subs[0],
            coinbaseBatch([
              addOwner(subs[0], replacement.address),
              removeOwner(subs[0], maker.credential.address, 1n),
            ]),
          ),
        ]),
      ),
    );
    const next = await connect(`/${subs[0]}/${replacement.secret}`, () => true);
    const replaced = await tool<{
      account: Address;
      signer: { authorized: boolean };
    }>(next, "wallet");
    assert.equal(replaced.account, subs[0]);
    assert.equal(replaced.signer.authorized, true);
    const revoked = await maker.agent.callTool({
      name: "execute",
      arguments: limit,
    });
    assert.equal(revoked.isError, true);
    assert.match(
      JSON.stringify(revoked.structuredContent),
      /not an authorized owner/,
    );
    assert.equal(
      (await tool<{ provides: { tickId: string }[] }>(next, "portfolio"))
        .provides[0].tickId,
      tickId,
    );
    await send(
      owner,
      call(
        main,
        coinbaseBatch([removeOwner(subs[0], replacement.address, 2n)]),
      ),
    );
    assert.equal(
      (await tool<{ signer: { authorized: boolean } }>(next, "wallet")).signer
        .authorized,
      false,
    );
    const subBalance = await rpc.getBalance({ address: subs[0] });
    await send(owner, call(subs[0], "0x", parseEther("0.01")));
    await send(
      owner,
      call(
        main,
        coinbaseBatch([
          call(subs[0], coinbaseBatch([call(main, "0x", parseEther("0.01"))])),
        ]),
      ),
    );
    assert.equal(await rpc.getBalance({ address: subs[0] }), subBalance);
    assert.ok(
      Number(
        formatEther(
          await rpc.getBalance({ address: maker.credential.address }),
        ),
      ) > 0,
    );
  },
);

test(
  "Base fork: the packed CLI and an external wallet complete Limit, Swap, Rent, and settlement",
  { skip: !forkUrl || !process.env.YLD_PACKED_CLI, timeout: 60_000 },
  async (t) => {
    const url = new URL(forkUrl!);
    assert.equal(url.protocol, "http:");
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    const transport = http(url.toString(), { retryCount: 0 });
    const local = createTestClient({ chain: base, mode: "hardhat", transport });
    assert.equal(
      (await forkMetadata(local.request)).forkedNetwork?.chainId,
      base.id,
    );
    const snapshot = await local.snapshot();
    t.after(() => local.revert({ id: snapshot }));
    const rpc = createPublicClient({ chain: base, transport });
    const wallet = createWalletClient({ chain: base, transport });
    const [, , , , account, taker] = await wallet.getAddresses();
    const cli = <T>(...args: string[]): T =>
      JSON.parse(
        execFileSync(process.execPath, [process.env.YLD_PACKED_CLI!, ...args], {
          encoding: "utf8",
          env: { ...process.env, YLD_RPC_URL: url.toString() },
        }),
      );
    async function send(
      to: Address,
      data: Hex,
      value = 0n,
      sender: Address = account,
    ) {
      const hash = await wallet.sendTransaction({
        account: sender,
        to,
        data,
        value,
      });
      assert.equal(
        (await rpc.waitForTransactionReceipt({ hash })).status,
        "success",
      );
      return hash;
    }
    async function execute(sender: Address, args: string[]) {
      const prepared = cli<{ plan: Plan }>(
        "prepare",
        "--account",
        sender,
        ...args,
      );
      assert.equal(prepared.plan.chainId, base.id);
      assert.equal(prepared.plan.account.toLowerCase(), sender.toLowerCase());
      for (const approval of prepared.plan.calls.slice(0, -1))
        await send(approval.to, approval.data, BigInt(approval.value), sender);
      const simulation = cli<{ status: string; plan: Plan }>(
        "simulate",
        "--account",
        sender,
        ...args,
      );
      assert.equal(simulation.status, "simulated");
      assert.equal(simulation.plan.calls.length, 1);
      const [{ to, data, value }] = simulation.plan.calls;
      const hash = await send(to, data, BigInt(value), sender);
      const receipt = cli<{ status: string; events: { eventName: string }[] }>(
        "status",
        "--hash",
        hash,
      );
      assert.equal(receipt.status, "confirmed");
      return receipt.events.map(({ eventName }) => eventName);
    }
    await send(
      weth,
      encodeFunctionData({ abi: mintAbi, functionName: "deposit" }),
      parseEther("0.02"),
    );
    const args = [
      "--operation",
      "provide",
      "--token-a",
      weth,
      "--token-b",
      usdc,
      "--asset",
      weth,
      "--duration-days",
      "3",
      "--price",
      "3025",
      "--amount",
      "0.01",
    ];
    const quote = cli<{
      tickId: string;
      priceTick: number;
      requiredInput: { amount: string };
    }>("quote", ...args);
    assert.equal(quote.requiredInput.amount, "0.01");
    assert.ok((await execute(account, args)).includes("Supplied"));
    assert.ok(
      cli<{ provides: { tickId: string }[] }>(
        "portfolio",
        "--account",
        account,
      ).provides.some((position) => position.tickId === quote.tickId),
    );
    const book = cli<{ asks: { tickId: string }[] }>(
      "book",
      "--token-a",
      weth,
      "--token-b",
      usdc,
      `--center-tick=${quote.priceTick}`,
      "--step-ticks",
      "1",
      "--radius",
      "0",
      "--duration-days",
      "3",
    );
    assert.ok(book.asks.some((level) => level.tickId === quote.tickId));
    const master = await rpc.readContract({
      address: usdc,
      abi: mintAbi,
      functionName: "masterMinter",
    });
    await local.impersonateAccount({ address: master });
    await local.setBalance({ address: master, value: parseEther("1") });
    await send(
      usdc,
      encodeFunctionData({
        abi: mintAbi,
        functionName: "configureMinter",
        args: [taker, parseUnits("100", 6)],
      }),
      0n,
      master,
    );
    await local.stopImpersonatingAccount({ address: master });
    await send(
      usdc,
      encodeFunctionData({
        abi: mintAbi,
        functionName: "mint",
        args: [taker, parseUnits("100", 6)],
      }),
      0n,
      taker,
    );
    await send(
      weth,
      encodeFunctionData({ abi: mintAbi, functionName: "deposit" }),
      parseEther("0.002"),
      taker,
    );

    const swap = [
      "--operation",
      "swap",
      "--tick-id",
      quote.tickId,
      "--amount",
      "0.001",
    ];
    const swapQuote = cli<{
      requiredInput: { amount: string };
      swapFeeIncludedInQuote: { amount: string };
    }>("quote", ...swap);
    assert.ok(Number(swapQuote.swapFeeIncludedInQuote.amount) > 0);
    const balance = () =>
      cli<{ tokens: { amount: string }[] }>(
        "balances",
        "--account",
        taker,
        "--tokens",
        weth,
      ).tokens[0].amount;
    const before = parseEther(balance());
    assert.ok(
      (
        await execute(taker, [
          ...swap,
          "--max-quote-in",
          swapQuote.requiredInput.amount,
        ])
      ).includes("ImmediateSwap"),
    );
    assert.equal(parseEther(balance()) - before, parseEther("0.001"));

    const rent = [
      "--operation",
      "rent",
      "--tick-id",
      quote.tickId,
      "--amount",
      "0.001",
    ];
    const rentQuote = cli<{
      fullTermYield: { amount: string };
      estimatedMaturity: string;
    }>("quote", ...rent);
    assert.ok(Number(rentQuote.fullTermYield.amount) > 0);
    const openRental = () =>
      execute(taker, [...rent, "--max-full-term-yield-asset", "0.0001"]);
    assert.ok((await openRental()).includes("UseOpened"));
    const rentals = () =>
      cli<{
        rentals: { positionId: string; maturity: string; status: string }[];
      }>("portfolio", "--account", taker).rentals;
    const [{ positionId }] = rentals();
    const debt = cli<{ requiredInput: { amount: string } }>(
      "quote",
      "--operation",
      "repay",
      "--position-id",
      positionId,
    );
    assert.ok(Number(debt.requiredInput.amount) > 0.001);
    assert.ok(
      (
        await execute(taker, [
          "--operation",
          "repay",
          "--position-id",
          positionId,
          "--max-yield-asset",
          "0.0001",
        ])
      ).includes("TermRepaid"),
    );
    assert.equal(rentals().length, 0);

    await openRental();
    const [active] = rentals();
    await local.increaseTime({
      seconds:
        Number(active.maturity) - Number((await rpc.getBlock()).timestamp) + 2,
    });
    await local.mine({ blocks: 1 });
    assert.equal(rentals()[0].status, "matured");
    assert.ok(
      (
        await execute(account, [
          "--operation",
          "close",
          "--position-id",
          active.positionId,
        ])
      ).includes("TermClosed"),
    );
    assert.equal(rentals().length, 0);
    assert.ok(
      (
        await execute(account, [
          "--operation",
          "withdraw",
          "--tick-id",
          quote.tickId,
          "--amount",
          "0.001",
          "--min-immediate-asset-out",
          "0",
        ])
      ).includes("Withdrawn"),
    );
    await execute(account, [
      "--operation",
      "collect",
      "--tick-id",
      quote.tickId,
    ]);
  },
);
