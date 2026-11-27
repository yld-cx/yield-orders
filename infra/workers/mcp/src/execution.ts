import {
  agentError,
  createSkills,
  jsonSafe,
  yieldOrdersAbi,
  type CommandInput,
  type PreparedTransaction,
} from "@yld-cx/skills";
import {
  coinbaseBatch,
  isCoinbaseOwner,
  verifyCoinbaseWallet,
} from "@yld-cx/sdk/coinbase";
import {
  decodeFunctionData,
  erc20Abi,
  formatEther,
  isAddressEqual,
  keccak256,
  stringToHex,
  zeroAddress,
  type Address,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
} from "viem";
import { base } from "viem/chains";
import { estimateL1Fee, estimateOperatorFee } from "viem/op-stack";
import { z } from "zod";

export class ExecutionError extends Error {}

export interface ConnectedWallet {
  account: Address;
  signer: PrivateKeyAccount;
}

const operations = {
  provide: "supply",
  rent: "use",
  swap: "swap",
  repay: "repay",
  withdraw: "withdraw",
  collect: "collect",
  close: "close",
  settle: "settle",
} as const;
const maxAmount = 10n ** 30n;

function rejectPlan(): never {
  throw new ExecutionError(
    "The prepared plan failed protocol execution validation",
  );
}

export function validatePlan(
  prepared: PreparedTransaction,
  account: Address,
  deployment: Address,
) {
  const { plan, market, inputs, operation } = prepared;
  const final = plan.calls.at(-1);
  if (
    plan.chainId !== base.id ||
    !isAddressEqual(plan.account, account) ||
    plan.calls.length < 1 ||
    plan.calls.length > 3 ||
    plan.calls.some((call) => call.value !== "0") ||
    !final ||
    !isAddressEqual(final.to, deployment) ||
    !market.asset.listed ||
    !market.quote.listed
  )
    rejectPlan();

  const approvals = plan.calls.slice(0, -1);
  for (const [index, call] of approvals.entries()) {
    const args = decodeFunctionData({ abi: erc20Abi, data: call.data });
    const cap = BigInt(inputs?.approvalCap.raw ?? "0");
    if (
      !inputs ||
      !isAddressEqual(call.to, inputs.required.token.address) ||
      !isAddressEqual(call.to, inputs.approvalCap.token.address) ||
      !isAddressEqual(
        call.to,
        operation === "swap" || operation === "rent"
          ? market.quote.address
          : market.asset.address,
      ) ||
      args.functionName !== "approve" ||
      !isAddressEqual(args.args[0], deployment) ||
      cap <= 0n ||
      args.args[1] !== (approvals.length === 2 && index === 0 ? 0n : cap)
    )
      rejectPlan();
  }

  const decoded = decodeFunctionData({ abi: yieldOrdersAbi, data: final.data });
  const nested = decoded.args?.[0] as Hex[] | undefined;
  if (
    decoded.functionName !== "multicall" ||
    !Array.isArray(nested) ||
    nested.length < 1 ||
    nested.length > 3
  )
    rejectPlan();
  const calls = nested.map((data) =>
    decodeFunctionData({ abi: yieldOrdersAbi, data }),
  );
  const primary = calls.at(-1);
  const expected = operations[operation];
  if (!primary || !expected || primary.functionName !== expected) rejectPlan();
  if (
    calls.length > 1 &&
    (operation !== "provide" ||
      calls.at(-2)?.functionName !== "createTick" ||
      (calls.length === 3 && calls[0].functionName !== "createPair"))
  )
    rejectPlan();

  const detail = prepared.details;
  if (!detail || typeof detail !== "object" || Array.isArray(detail))
    rejectPlan();
  const args = primary.args ?? [];
  const argEquals = (index: number, key: string) =>
    typeof args[index] === "bigint" && String(args[index]) === detail[key];
  if (
    !argEquals(
      0,
      operation === "repay" || operation === "close" ? "positionId" : "tickId",
    )
  )
    rejectPlan();
  if (
    operation === "provide" ||
    operation === "swap" ||
    operation === "rent" ||
    operation === "withdraw"
  ) {
    if (
      !argEquals(1, "amount") ||
      (args[1] as bigint) <= 0n ||
      (args[1] as bigint) > maxAmount
    )
      rejectPlan();
  }
  if (operation === "provide" && args[2] !== zeroAddress) rejectPlan();
  if (
    (operation === "swap" && !argEquals(2, "maxQuoteIn")) ||
    (operation === "rent" && !argEquals(2, "maxFullTermYieldAsset")) ||
    (operation === "withdraw" && !argEquals(2, "minImmediateAssetOut")) ||
    (operation === "repay" && !argEquals(1, "maxYieldAsset"))
  )
    rejectPlan();
  if (
    operation === "swap" ||
    operation === "rent" ||
    operation === "withdraw"
  ) {
    if (
      !argEquals(3, "deadline") ||
      BigInt(String(args[3])) <= BigInt(prepared.timestamp)
    )
      rejectPlan();
    if (operation !== "withdraw" && args[4] !== zeroAddress) rejectPlan();
  }
  if (calls.length > 1) {
    const initialize = detail.initialize;
    const tick = calls.at(-2)?.args;
    if (
      !initialize ||
      typeof initialize !== "object" ||
      Array.isArray(initialize) ||
      !tick ||
      tick[1] !== initialize.direction ||
      tick[2] !== initialize.priceTick ||
      String(tick[3]) !== String(initialize.durationDays)
    )
      rejectPlan();
    if (calls.length === 3) {
      const pair = calls[0].args;
      if (
        String(pair?.[0]).toLowerCase() !==
          String(initialize.tokenA).toLowerCase() ||
        String(pair?.[1]).toLowerCase() !==
          String(initialize.tokenB).toLowerCase()
      )
        rejectPlan();
    }
  }
  return coinbaseBatch(
    plan.calls.map(({ to, data }) => ({ to, data, value: 0n })),
  );
}

export async function walletStatus(
  client: PublicClient,
  wallet: ConnectedWallet,
) {
  const { account, signer } = wallet;
  const { implementation, blockNumber } = await verifyCoinbaseWallet(
    client,
    account,
  );
  const [authorized, gas] = await Promise.all([
    isCoinbaseOwner(client, account, signer.address, blockNumber),
    client.getBalance({ address: signer.address, blockNumber }),
  ]);
  return {
    chain: "base",
    chainId: base.id,
    account,
    implementation,
    signer: {
      address: signer.address,
      authorized,
      gasBalance: { wei: String(gas), eth: formatEther(gas) },
    },
    blockNumber: String(blockNumber),
  };
}

export const confirmationState = z.strictObject({
  account: z.string(),
  signer: z.string(),
  nonce: z.number().int().min(0),
  planHash: z.string(),
  maxEstimatedCost: z.string().regex(/^\d{1,78}$/),
  expiresAt: z.number().int(),
});
export type ConfirmationState = z.infer<typeof confirmationState>;

export async function simulateExecution(
  client: PublicClient,
  wallet: ConnectedWallet,
  api: ReturnType<typeof createSkills>,
  input: CommandInput<"prepare">,
) {
  if (
    input.chain !== undefined &&
    input.chain !== "base" &&
    input.chain !== "eip155:8453"
  )
    throw new ExecutionError("Coinbase Agent Wallet execution is on Base");
  if (
    input.account &&
    input.account.toLowerCase() !== wallet.account.toLowerCase()
  )
    throw new ExecutionError("Use the connected Sub Account as the sender");
  if (
    ["rent", "swap", "withdraw"].includes(input.operation) &&
    input.deadline === undefined
  )
    throw new ExecutionError(
      "For execution specify an explicit short deadline in Unix seconds",
    );
  const { account, signer } = wallet;
  const verified = await walletStatus(client, wallet);
  if (!verified.signer.authorized)
    throw new ExecutionError(
      "The signer is not an authorized owner of this Sub Account",
    );
  const [confirmedNonce, nonce] = await Promise.all([
    client.getTransactionCount({ address: signer.address, blockTag: "latest" }),
    client.getTransactionCount({
      address: signer.address,
      blockTag: "pending",
    }),
  ]);
  if (nonce !== confirmedNonce)
    throw new ExecutionError(
      "Signer already has a pending transaction. Check its status before requesting execution again.",
    );

  const prepared = await api.prepare({ ...input, account, chain: "base" });
  if (
    input.deadline !== undefined &&
    BigInt(input.deadline) > BigInt(prepared.timestamp) + 600n
  )
    throw new ExecutionError(
      "Execution deadline must be within ten minutes of the chain timestamp",
    );
  const deployment = api
    .networks()
    .networks.find((network) => network.chainId === base.id)!.deployment
    .address;
  let data: Hex;
  try {
    data = validatePlan(prepared, account, deployment);
  } catch (error) {
    if (error instanceof ExecutionError) throw error;
    rejectPlan();
  }

  const tx = { account: signer.address, to: account, data, nonce };
  const balance = BigInt(verified.signer.gasBalance.wei);
  if (balance === 0n)
    throw new ExecutionError(`Signer ${signer.address} needs Base ETH for gas`);
  let estimate: bigint;
  try {
    await client.call({ ...tx, blockTag: "pending" });
    estimate = await client.estimateGas({ ...tx, blockTag: "pending" });
  } catch (error) {
    const message = agentError(error);
    if (/insufficient funds/i.test(message))
      throw new ExecutionError(
        `Signer ${signer.address} needs more Base ETH for gas`,
      );
    throw new ExecutionError(
      `Atomic Coinbase batch simulation failed: ${message}`,
    );
  }
  const [fees, l1Fee, operatorFee] = await Promise.all([
    client.estimateFeesPerGas(),
    estimateL1Fee(client, { ...tx, chain: base }),
    estimateOperatorFee(client, { ...tx, chain: base }),
  ]);
  const gas = (estimate * 12n + 9n) / 10n;
  const cost =
    fees.maxFeePerGas * gas + ((l1Fee + operatorFee) * 12n + 9n) / 10n;
  if (balance < cost)
    throw new ExecutionError(
      `Signer ${signer.address} has ${formatEther(balance)} Base ETH and needs approximately ${formatEther(cost)} Base ETH for this batch`,
    );

  return {
    nonce,
    prepared,
    cost,
    transaction: {
      chainId: base.id,
      type: "eip1559" as const,
      to: account,
      data,
      nonce,
      gas,
      ...fees,
      value: 0n,
    },
    planHash: keccak256(
      stringToHex(
        JSON.stringify(
          jsonSafe({
            account,
            signer: signer.address,
            nonce,
            plan: prepared.plan,
            approvalCap: prepared.inputs?.approvalCap,
          }),
        ),
      ),
    ),
  };
}

export async function broadcastExecution(
  client: PublicClient,
  wallet: ConnectedWallet,
  current: Awaited<ReturnType<typeof simulateExecution>>,
  state: ConfirmationState,
) {
  if (
    state.expiresAt < Date.now() ||
    state.account !== wallet.account ||
    state.signer !== wallet.signer.address ||
    state.nonce !== current.nonce ||
    state.planHash !== current.planHash ||
    current.cost > BigInt(state.maxEstimatedCost)
  )
    throw new ExecutionError(
      "The authorization is stale or the plan changed. Review a new preview before submitting.",
    );

  const [nonce, pending, owner] = await Promise.all([
    client.getTransactionCount({
      address: wallet.signer.address,
      blockTag: "latest",
    }),
    client.getTransactionCount({
      address: wallet.signer.address,
      blockTag: "pending",
    }),
    verifyCoinbaseWallet(client, wallet.account).then(({ blockNumber }) =>
      isCoinbaseOwner(
        client,
        wallet.account,
        wallet.signer.address,
        blockNumber,
      ),
    ),
  ]);
  if (!owner) throw new ExecutionError("The signer is no longer authorized");
  if (nonce !== state.nonce || pending !== state.nonce)
    throw new ExecutionError(
      "The signer nonce changed. Check existing transaction status before starting again.",
    );

  const serializedTransaction = await wallet.signer.signTransaction(
    current.transaction,
  );
  const hash = keccak256(serializedTransaction);
  try {
    if ((await client.sendRawTransaction({ serializedTransaction })) !== hash)
      throw new Error("Unexpected transaction hash");
  } catch {
    return {
      status: "submission_uncertain",
      hash,
      chainId: base.id,
      message: "Check this hash with status before taking further action.",
    };
  }
  return { status: "submitted", hash, chainId: base.id };
}
