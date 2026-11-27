import type { Metadata } from "next";
import { AgentsScreen } from "@/components/agents/agents-screen";

export const metadata: Metadata = {
  title: "Agent Wallets",
  description: "Manage Coinbase Sub Accounts and agent signers on Base.",
  alternates: { canonical: "/agents" },
  robots: { index: false, follow: true },
};

export default function Page() {
  return <AgentsScreen />;
}
