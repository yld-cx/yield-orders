import { decodeFunctionResult, encodeFunctionData, zeroAddress } from "viem";

// Compatibility helpers for the stateful model tests. These names exist only in tests;
// the deployed ABI has no preview methods. Every action is simulated against real token state.
export function withSimulatedActions(market: any, client: any, abi: any, supplier: `0x${string}`, taker: `0x${string}`): any {
  const simulate = async (functionName: string, args: readonly unknown[], account: `0x${string}`) =>
    (await client.simulateContract({ address: market.address, abi, functionName, args, account })).result;
  const batch = async (calls: { functionName: string; args: readonly unknown[] }[], account: `0x${string}`) => {
    const data = calls.map((c) => encodeFunctionData({ abi, functionName: c.functionName, args: c.args }));
    const result = (await client.simulateContract({
      address: market.address, abi, functionName: "multicall", args: [data], account,
    })).result as `0x${string}`[];
    return result.map((bytes, i) => decodeFunctionResult({ abi, functionName: calls[i].functionName, data: bytes })) as any[];
  };
  const previews: Record<string, (...args: any[]) => Promise<any>> = {
    previewSupply: async ([id, amount], options) => {
      const [_, position, tick] = await batch([
        { functionName: "supply", args: [id, amount, zeroAddress] },
        { functionName: "getEarnPosition", args: [options?.account?.address ?? supplier, id] },
        { functionName: "getTick", args: [id] },
      ], options?.account?.address ?? supplier);
      return { resultingActivePrincipal: position.activePrincipal, marketAvailable: tick.availableSupply };
    },
    previewWithdraw: async ([id, owner, amount]) => simulate("withdraw", [id, amount, 0n, 2n ** 256n - 1n], owner),
    previewUse: async ([id, amount]) => {
      const positionId = await market.read.nextPositionId();
      const [_, position, tick] = await batch([
        { functionName: "use", args: [id, amount, 2n ** 256n - 1n, 2n ** 256n - 1n, zeroAddress] },
        { functionName: "getPosition", args: [positionId] },
        { functionName: "getTick", args: [id] },
      ], taker);
      const working = BigInt(tick.activeWorking);
      const principal = BigInt(tick.activePrincipal);
      return { ...position, activeUtilizationBeforeX128: ((working - amount) * (1n << 128n)) / principal,
        activeUtilizationAfterX128: (working * (1n << 128n)) / principal };
    },
    previewRepay: async ([positionId]) => {
      const position = await market.read.getPosition([positionId]);
      const [result] = await batch([
        { functionName: "repay", args: [positionId, 2n ** 256n - 1n] },
        { functionName: "getTick", args: [position.tickId] },
      ], position.user);
      return result;
    },
    previewClose: async ([positionId]) => {
      const position = await market.read.getPosition([positionId]);
      const [result] = await batch([
        { functionName: "close", args: [positionId] },
        { functionName: "getTick", args: [position.tickId] },
      ], taker);
      return result;
    },
    previewSwap: async ([id, amount]) => simulate("swap", [id, amount, 2n ** 256n - 1n, 2n ** 256n - 1n, zeroAddress], taker),
    previewCollect: async ([id, owner]) => simulate("collect", [id], owner),
  };
  return new Proxy(market, {
    get(target, key) {
      if (key === "simulate") return previews;
      if (key === "write") return new Proxy(target.write, {
        get(write, name) {
          if (name === "withdraw") return (args: any[], options: any) => write.withdraw(
            args.length === 2 ? [args[0], args[1], 0n, 2n ** 256n - 1n] : args, options,
          );
          return write[name];
        },
      });
      return target[key];
    },
  });
}
