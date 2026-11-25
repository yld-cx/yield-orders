import { notFound } from "next/navigation";
import { YieldExplorer } from "@/components/play/yield-explorer";
import { decodePlayStrategy } from "@/lib/play";
import { readPlayNetwork } from "@/lib/play-market";
import { playMetadata } from "../../metadata";

type Props = PageProps<"/play/[network]/[strategy]">;

export async function generateMetadata({ params }: Props) {
  const { network, strategy } = await params;
  return playMetadata(
    readPlayNetwork(network),
    decodePlayStrategy(strategy) ? strategy : undefined,
  );
}

export default async function Page({ params }: Props) {
  const { network, strategy } = await params;
  if (!readPlayNetwork(network) || !decodePlayStrategy(strategy)) notFound();
  return <YieldExplorer />;
}
