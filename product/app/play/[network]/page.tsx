import { notFound } from "next/navigation";
import { YieldExplorer } from "@/components/play/yield-explorer";
import { readPlayNetwork } from "@/lib/play-market";
import { playMetadata } from "../metadata";

type Props = PageProps<"/play/[network]">;

export async function generateMetadata({ params }: Props) {
  return playMetadata(readPlayNetwork((await params).network));
}

export default async function Page({ params }: Props) {
  if (!readPlayNetwork((await params).network)) notFound();
  return <YieldExplorer />;
}
