import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createConfig: vi.fn((options: Record<string, unknown>) => ({ options })),
  injected: vi.fn(() => ({ id: "injected" })),
  coinbaseWallet: vi.fn(() => ({ id: "coinbaseWalletSDK" })),
  safe: vi.fn(() => ({ id: "safe" })),
  walletConnect: vi.fn((options: unknown) => ({
    id: "walletConnect",
    options,
  })),
  mock: vi.fn((options: unknown) => ({ id: "mock", options })),
}));

vi.mock("wagmi", () => ({
  createConfig: mocks.createConfig,
  createStorage: (options: unknown) => options,
  cookieStorage: {},
  http: (url: string) => url,
}));
vi.mock("wagmi/connectors/injected", () => ({ injected: mocks.injected }));
vi.mock("wagmi/connectors/coinbaseWallet", () => ({
  coinbaseWallet: mocks.coinbaseWallet,
}));
vi.mock("wagmi/connectors/safe", () => ({ safe: mocks.safe }));
vi.mock("wagmi/connectors/walletConnect", () => ({
  walletConnect: mocks.walletConnect,
}));
vi.mock("wagmi/connectors/mock", () => ({ mock: mocks.mock }));
vi.mock("@/lib/registry", () => ({ ORIGIN: "https://yld.cx" }));
vi.mock("@/lib/rpc", () => ({
  rpcUrls: {
    ethereum: "https://ethereum.example",
    base: "https://base.example",
    robinhood: "https://robinhood.example",
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID", "test-project");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function browser(origin = "http://localhost:3000") {
  vi.stubGlobal("window", { location: { origin } });
}

describe("wallet configuration lifecycle", () => {
  it("keeps server requests isolated without initializing wallet SDKs", async () => {
    const { getWagmiConfig } = await import("@/lib/wagmi");
    expect(getWagmiConfig()).not.toBe(getWagmiConfig());
    for (const [options] of mocks.createConfig.mock.calls)
      expect(options.connectors).toEqual([]);
    expect(mocks.walletConnect).not.toHaveBeenCalled();
    expect(mocks.coinbaseWallet).not.toHaveBeenCalled();
    expect(mocks.injected).not.toHaveBeenCalled();
    expect(mocks.safe).not.toHaveBeenCalled();
  });

  it("reuses browser connectors across repeated renders", async () => {
    browser();
    const { getWagmiConfig } = await import("@/lib/wagmi");
    const config = getWagmiConfig();
    expect(getWagmiConfig()).toBe(config);
    expect(mocks.createConfig).toHaveBeenCalledTimes(1);
    expect(mocks.walletConnect).toHaveBeenCalledTimes(1);
  });

  it.each([
    "http://localhost:3000",
    "https://preview.example",
    "https://yld.cx",
  ])(
    "uses the actual site origin %s in WalletConnect metadata",
    async (origin) => {
      browser(origin);
      const { getWagmiConfig } = await import("@/lib/wagmi");
      getWagmiConfig();
      expect(mocks.walletConnect).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ url: origin }),
        }),
      );
    },
  );

  it("reuses the browser config after a module reload", async () => {
    browser();
    const firstModule = await import("@/lib/wagmi");
    const config = firstModule.getWagmiConfig();
    vi.resetModules();
    const nextModule = await import("@/lib/wagmi");
    expect(nextModule.getWagmiConfig()).toBe(config);
    expect(mocks.walletConnect).toHaveBeenCalledTimes(1);
  });

  it("isolates spy wallets from the normal wallet config", async () => {
    browser();
    const { getWagmiConfig } = await import("@/lib/wagmi");
    const normal = getWagmiConfig();
    const address = "0x0000000000000000000000000000000000000001";
    const spy = getWagmiConfig(address);
    expect(spy).not.toBe(normal);
    expect(getWagmiConfig(address)).toBe(spy);
    expect(getWagmiConfig()).toBe(normal);
    expect(mocks.mock).toHaveBeenCalledTimes(1);
    expect(mocks.walletConnect).toHaveBeenCalledTimes(1);
  });

  it("omits WalletConnect when no project ID is configured", async () => {
    browser();
    vi.stubEnv("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID", "");
    const { getWagmiConfig } = await import("@/lib/wagmi");
    getWagmiConfig();
    expect(mocks.walletConnect).not.toHaveBeenCalled();
    expect(mocks.coinbaseWallet).toHaveBeenCalledTimes(1);
  });
});
