import type { Metadata } from "next";
import { OpenMarket } from "@/components/markets/open-market";
export const metadata: Metadata = {
  title: "Open Market",
  description:
    "Open a permissionless liquidity rental market for two ERC-20 tokens.",
  alternates: { canonical: "/market/open" },
};
export default function Page() {
  return <OpenMarket />;
}
