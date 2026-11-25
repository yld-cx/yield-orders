import { readPlayNetwork } from "@/lib/play-market";
import { playPreview } from "../../preview";

export async function GET(
  _request: Request,
  { params }: RouteContext<"/play/[network]/og">,
) {
  const network = readPlayNetwork((await params).network);
  if (!network) return new Response("Invalid network", { status: 404 });
  return playPreview(network);
}
