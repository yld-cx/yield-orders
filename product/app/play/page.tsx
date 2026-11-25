import { YieldExplorer } from "@/components/play/yield-explorer";
import { playMetadata } from "./metadata";

export function generateMetadata() {
  return playMetadata();
}

export default function Page() {
  return <YieldExplorer />;
}
