import type { Metadata } from "next";
import { YieldExplorer } from "@/components/play/yield-explorer";

export const metadata: Metadata = {
  title: "Yield Explorer",
  description: "Explore and share hypothetical liquidity rental strategies.",
  alternates: { canonical: "/play" },
};

export default function Page() {
  return <YieldExplorer />;
}
