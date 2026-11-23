import { scheduled } from "./scheduled.ts";
import type { Env } from "./shared.ts";

export default {
  fetch() {
    return new Response("Not found", { status: 404 });
  },
  scheduled(controller, env) {
    return scheduled(controller, env);
  },
} satisfies ExportedHandler<Env>;
