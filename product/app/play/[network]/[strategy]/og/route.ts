import { decodePlayStrategy } from "@/lib/play";
import { readPlayNetwork } from "@/lib/play-market";
import { playPreview } from "../../../preview";

export async function GET(
  _request: Request,
  { params }: RouteContext<"/play/[network]/[strategy]/og">,
) {
  const { network, strategy } = await params;
  const slug = readPlayNetwork(network);
  if (!slug || !decodePlayStrategy(strategy)) {
    return new Response("Invalid strategy link", { status: 404 });
  }
  return playPreview(slug, strategy);
}
