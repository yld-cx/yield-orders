import { DurableObject } from "cloudflare:workers";
import { resolveChain } from "./execute.ts";
import { errorDetails, log, type Env } from "./shared.ts";
import { scheduled } from "./scheduled.ts";

export class ChainCoordinator extends DurableObject<Env> {
  private running = false;
  async fetch(request: Request) {
    if (this.running) return new Response("Already running", { status: 409 });
    this.running = true;
    let stage = "configuration";
    try {
      if (this.env.RESOLVER_ENABLED !== "true") return new Response("Disabled");
      const slug = new URL(request.url).pathname.slice(1);
      await resolveChain(this.env, slug, this.ctx.storage, {
        onStage: (value) => {
          stage = value;
        },
      });
      return new Response("Complete");
    } catch (e) {
      log({
        type: "resolver_chain_failed",
        stage,
        ...errorDetails(e, this.env),
      });
      return new Response("Chain run failed", { status: 503 });
    } finally {
      this.running = false;
    }
  }
}
export default {
  fetch() {
    return new Response("Not found", { status: 404 });
  },
  scheduled,
} satisfies ExportedHandler<Env>;
