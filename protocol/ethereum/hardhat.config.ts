import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

export const PROTOCOL_VERSION = "0.3" as const;
export const SALT_NAMESPACE = `yld.cx-v${PROTOCOL_VERSION}` as const;
export const COMPILER_DESCRIPTION = "solc 0.8.36; cancun; optimizer 200; viaIR" as const;
export const ETHEREUM_RPC_URL = process.env.ETHEREUM_RPC_URL || "https://ethereum-rpc.publicnode.com";
export const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
export const ROBINHOOD_RPC_URL = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
export const TEST_FEE_TO = "0x000000000000000000000000000000000000dEaD" as const;
export const YLD_FEE_TO = process.env.YLD_FEE_TO;
export const YLD_DEPLOYER = configVariable("YLD_DEPLOYER");
export const YLD_NETWORK = process.env.YLD_NETWORK;
export const YLD_CHECK_ONLY = process.env.YLD_CHECK_ONLY === "true";
export const ETHERSCAN_API_KEY = configVariable("ETHERSCAN_API_KEY");

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  chainDescriptors: {
    8453: { name: "Base", chainType: "op", hardforkHistory: { isthmus: { blockNumber: 0 } } },
    4663: {
      name: "Robinhood Chain",
      chainType: "generic",
      hardforkHistory: { cancun: { blockNumber: 0 } },
      blockExplorers: {
        etherscan: {
          name: "RobinScan",
          url: "https://robin.etherscan.io",
        },
      },
    },
  },
  verify: { etherscan: { apiKey: ETHERSCAN_API_KEY } },
  solidity: {
    profiles: {
      default: {
        version: "0.8.36",
        settings: { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 }, viaIR: true },
      },
      production: {
        version: "0.8.36",
        settings: { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 }, viaIR: true },
      },
    },
  },
  networks: {
    hardhatMainnet: { type: "edr-simulated", chainType: "l1" },
    hardhatOp: { type: "edr-simulated", chainType: "op" },
    ethereum: {
      type: "http",
      chainType: "l1",
      chainId: 1,
      url: ETHEREUM_RPC_URL,
      accounts: [YLD_DEPLOYER],
    },
    base: {
      type: "http",
      chainType: "op",
      chainId: 8453,
      url: BASE_RPC_URL,
      accounts: [YLD_DEPLOYER],
    },
    robinhood: {
      type: "http",
      chainType: "generic",
      chainId: 4663,
      url: ROBINHOOD_RPC_URL,
      accounts: [YLD_DEPLOYER],
    },
    ethereumFork: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 1,
      forking: { url: ETHEREUM_RPC_URL },
    },
    baseFork: {
      type: "edr-simulated",
      chainType: "op",
      chainId: 8453,
      forking: { url: BASE_RPC_URL },
    },
    robinhoodFork: {
      type: "edr-simulated",
      chainType: "generic",
      chainId: 4663,
      forking: { url: ROBINHOOD_RPC_URL },
    },
  },
});
