"use client";
import { useEffect, useRef, useState } from "react";
import {
  useConnection,
  useWalletClient,
  useCapabilities,
  useSendCalls,
} from "wagmi";
import { waitForCallsStatus } from "viem/actions";
import { parseUnits, encodeFunctionData, erc20Abi } from "viem";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Market } from "@yld-cx/sdk";
import { getNetwork, explainError } from "@yld-cx/sdk/ethereum";
import { Card, CardContent } from "@yld-cx/ui/components/ui/card";
import { Button } from "@yld-cx/ui/components/ui/button";
import { AmountInput, Message } from "@/components/forms/financial-fields";
import { NetworkGuard } from "@/components/wallet/wallet-connect";
import { getSdk } from "@/lib/rpc";
import { amountText } from "@/lib/utils";
import { queryKeys } from "@/lib/query-keys";
import {
  atomicStatus,
  atomicRequestUnsupported,
  swapCalls,
} from "@/lib/swap-flow";
import { walletSwapAvailable } from "@/lib/swap-availability";
import {
  PERMIT2,
  type SwapInput,
  type SwapQuoteResult,
} from "@yld-cx/sdk/uniswap";

async function swapRequest(input: SwapInput): Promise<SwapQuoteResult> {
  const response = await fetch("/api/swap/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Swap unavailable");
  return result as SwapQuoteResult;
}
export function SwapForm({ market }: { market: Market }) {
  const account = useConnection();
  if (
    !walletSwapAvailable(
      getNetwork(market.network).chain.id,
      market.token0.address,
      market.token1.address,
    )
  )
    return (
      <Card>
        <CardContent className="space-y-3">
          <h2 className="text-lg font-semibold">Market Swap</h2>
          <Message>Market swaps are not available for this pair yet.</Message>
        </CardContent>
      </Card>
    );
  return (
    <SwapSession
      key={`${market.network}/${market.key}/${account.address}/${account.chainId}`}
      market={market}
    />
  );
}
function SwapSession({ market }: { market: Market }) {
  const account = useConnection(),
    wallet = useWalletClient(),
    batch = useSendCalls(),
    queries = useQueryClient();
  const network = getNetwork(market.network),
    client = getSdk(network.slug).publicClient;
  const [reverse, setReverse] = useState(false),
    [amount, setAmount] = useState(""),
    [slippage, setSlippage] = useState("0.5");
  const [review, setReview] = useState<{
    quote: SwapQuoteResult;
    calls: Awaited<ReturnType<typeof swapCalls>>;
    input: SwapInput;
  }>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [status, setStatus] = useState("");
  const [upgrade, setUpgrade] = useState(false),
    [expired, setExpired] = useState(false);
  const [separate, setSeparate] = useState(false);
  const locked = useRef(false),
    revision = useRef(0),
    mounted = useRef(true);
  const [input, output] = reverse
    ? [market.token1, market.token0]
    : [market.token0, market.token1];
  const capabilities = useCapabilities({
    chainId: network.chain.id,
    query: {
      enabled: !!account.address && account.chainId === network.chain.id,
      retry: false,
    },
  });
  const capability = atomicStatus(capabilities.data);
  const balance = useQuery({
    queryKey: queryKeys.balance(network.slug, input.address, account.address),
    queryFn: () =>
      getSdk(network.slug).balance(
        input.address as `0x${string}`,
        account.address!,
      ),
    enabled: !!account.address,
    refetchInterval: 15000,
  });
  useEffect(() => {
    mounted.current = true;
    const requestRevision = revision;
    return () => {
      mounted.current = false;
      requestRevision.current++;
    };
  }, []);
  useEffect(() => {
    if (!review) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, review.quote.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [review]);
  function changed() {
    revision.current++;
    setReview(undefined);
    setError("");
    setStatus("");
    setExpired(false);
  }
  async function prepare() {
    if (locked.current || !account.address) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setReview(undefined);
    setStatus("");
    const version = revision.current;
    try {
      if (
        !/^\d+(\.\d+)?$/.test(amount) ||
        (amount.split(".")[1]?.length ?? 0) > input.decimals
      )
        throw new Error("Enter a valid token amount");
      const raw = parseUnits(amount, input.decimals);
      if (raw <= 0n || balance.data === undefined || raw > balance.data)
        throw new Error("Check your available token balance");
      const request: SwapInput = {
        chainId: network.chain.id,
        mode: "wallet-router",
        tokenIn: input.address as `0x${string}`,
        tokenOut: output.address as `0x${string}`,
        amount: raw.toString(),
        swapper: account.address,
        slippage: Number(slippage),
      };
      const quote = await swapRequest(request);
      const calls = await swapCalls(
        client,
        quote,
        request.swapper,
        network.chain.id,
      );
      if (mounted.current && version === revision.current) {
        setReview({ quote, calls, input: request });
        setExpired(false);
      }
    } catch (e) {
      if (mounted.current && version === revision.current)
        setError(explainError(e));
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function submit() {
    if (locked.current || !review || !wallet.data || !account.address) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const signer = wallet.data;
      const assertWallet = async () => {
        if (
          !mounted.current ||
          (await signer.getChainId()) !== network.chain.id ||
          (await signer.getAddresses())[0]?.toLowerCase() !==
            review.input.swapper.toLowerCase()
        )
          throw new Error("Wallet changed. Review a new quote.");
        if (Date.now() >= review.quote.expiresAt)
          throw new Error("Quote expired. Request a new quote.");
      };
      await assertWallet();
      const calls = await swapCalls(
        client,
        review.quote,
        review.input.swapper,
        network.chain.id,
      );
      if (
        calls.length !== review.calls.length ||
        calls.some(
          (call, index) =>
            call.to.toLowerCase() !== review.calls[index].to.toLowerCase() ||
            call.data !== review.calls[index].data ||
            call.value !== review.calls[index].value,
        )
      )
        throw new Error("Allowance changed. Request a fresh quote.");
      const detected = await capabilities.refetch();
      const atomic = atomicStatus(detected.data);
      await assertWallet();
      if (
        calls.length > 1 &&
        !separate &&
        (atomic === "supported" || (atomic === "ready" && upgrade))
      ) {
        setStatus("Confirm the atomic approval and swap batch in your wallet");
        const sent = await batch.mutateAsync({
          account: account.address,
          chainId: network.chain.id,
          calls,
          forceAtomic: true,
        });
        setStatus("Waiting for wallet batch confirmation…");
        const receipt = await waitForCallsStatus(signer, {
          id: sent.id,
          timeout: 180000,
          throwOnFailure: true,
        });
        if (
          receipt.status !== "success" ||
          !receipt.receipts?.length ||
          receipt.receipts.some((r) => r.status !== "success")
        )
          throw new Error("Wallet batch did not confirm successfully");
        setStatus("Swap confirmed");
      } else {
        // Explicit sequential fallback: one approval step per click; never auto-swap.
        const approvalNeeded = calls.length > 1;
        setStatus(
          approvalNeeded
            ? "Confirm token approval in your wallet"
            : "Confirm swap in your wallet",
        );
        const hash = await signer.sendTransaction({
          ...calls[0],
          account: account.address,
          chain: network.chain,
        });
        setStatus("Waiting for transaction confirmation…");
        const receipt = await client.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success")
          throw new Error("Transaction reverted");
        setStatus(
          approvalNeeded
            ? "Approval confirmed. Request a fresh quote to continue to the swap."
            : "Swap confirmed",
        );
      }
      setReview(undefined);
      await queries.invalidateQueries({ queryKey: ["balance"] });
    } catch (e) {
      if (mounted.current) {
        if (atomicRequestUnsupported(e)) {
          setSeparate(true);
          setError(
            "Atomic batching is unavailable. Request a fresh quote to approve and swap separately.",
          );
        } else setError(explainError(e));
        setStatus("");
        setReview(undefined);
      }
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const approvals = review ? review.calls.length - 1 : 0;
  const first = review?.calls[0];
  const tokenApproval =
    !!first && first.to.toLowerCase() === input.address.toLowerCase();
  const reset =
    tokenApproval &&
    first?.data ===
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [PERMIT2, 0n],
      });
  const atomic =
    !separate &&
    (capability === "supported" || (capability === "ready" && upgrade));
  return (
    <Card>
      <CardContent className="space-y-4">
        <h2 className="text-lg font-semibold">Market Swap</h2>
        <p className="text-sm text-muted-foreground">
          Swap through Uniswap AMM liquidity. Market swaps do not earn Yield.
        </p>
        <fieldset disabled={busy} className="space-y-3">
          <div className="flex items-center justify-between">
            <span>
              {input.symbol} → {output.symbol}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                changed();
                setReverse(!reverse);
                setAmount("");
              }}
            >
              Reverse
            </Button>
          </div>
          <AmountInput
            label="You pay"
            value={amount}
            onChange={(v) => {
              changed();
              setAmount(v);
            }}
            symbol={input.symbol}
            balance={{
              value: balance.data,
              decimals: input.decimals,
              isPending: balance.isPending,
              isError: balance.isError,
            }}
          />
          <label className="text-sm">
            Slippage{" "}
            <select
              aria-label="Swap slippage"
              value={slippage}
              onChange={(e) => {
                changed();
                setSlippage(e.target.value);
              }}
            >
              <option value="0.1">0.1%</option>
              <option value="0.5">0.5%</option>
              <option value="1">1%</option>
            </select>
          </label>
        </fieldset>
        <NetworkGuard chainId={network.chain.id} />
        <p className="text-xs break-all text-muted-foreground">
          Token spender: Permit2 {PERMIT2}. Token approval may persist until
          revoked. Router authorization is for the exact input amount. No
          offchain signature is requested.
        </p>
        <p className="text-xs text-muted-foreground">
          Routes depend on token and pool compatibility. Fee-on-transfer and
          permissioned tokens may be unavailable.
        </p>
        {capability === "ready" && (
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={upgrade}
              disabled={busy}
              onChange={(e) => setUpgrade(e.target.checked)}
            />
            Allow my wallet to request an upgrade for atomic batching
          </label>
        )}
        {review && approvals > 0 && capability !== "unsupported" && (
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={separate}
              disabled={busy}
              onChange={(e) => setSeparate(e.target.checked)}
            />
            Use separate approval and swap transactions
          </label>
        )}
        {review && (
          <div className="space-y-2 text-sm" aria-live="polite">
            <p>
              Estimated output:{" "}
              {amountText(
                BigInt(review.quote.estimatedAmountOut),
                output.decimals,
              )}{" "}
              {output.symbol}
            </p>
            <p>
              Minimum received:{" "}
              {amountText(
                BigInt(review.quote.minimumAmountOut),
                output.decimals,
              )}{" "}
              {output.symbol}
            </p>
            <p>Recipient: {account.address}</p>
            <p>
              {approvals
                ? atomic
                  ? "One atomic batch confirmation. Your wallet may request authorization."
                  : `${approvals + 1} separate transactions: authorize token spending, then swap. A fresh quote is required after each authorization.`
                : "One swap transaction"}
            </p>
            {expired && (
              <Message>Quote expired. Request a fresh quote.</Message>
            )}
          </div>
        )}
        <Button
          disabled={
            busy ||
            !account.address ||
            account.chainId !== network.chain.id ||
            !amount
          }
          onClick={prepare}
        >
          {busy ? "Working…" : review ? "Refresh quote" : "Get swap quote"}
        </Button>
        {review && !expired && (
          <Button disabled={busy} onClick={submit}>
            {approvals
              ? atomic
                ? "Approve & swap atomically"
                : reset
                  ? "Reset allowance"
                  : tokenApproval
                    ? "Approve token (then review swap)"
                    : "Authorize Permit2 (then review swap)"
              : "Confirm swap"}
          </Button>
        )}
        {status && <Message>{status}</Message>}
        {error && <Message error>{error}</Message>}
      </CardContent>
    </Card>
  );
}
