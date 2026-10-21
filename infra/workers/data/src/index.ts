import { getTokens } from "./tokens.ts";
import { getEvents } from "./events.ts";
import { synchronize } from "./sync.ts";
import { errorKind, HttpError, log, type Env } from "./shared.ts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const headers = new Headers({
      "content-type": "application/json; charset=utf-8",
      vary: "Origin",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    const origin = request.headers.get("origin");
    const allowed = (env.CORS_ORIGINS ?? "https://yld.cx")
      .split(",")
      .map((v) => v.trim());
    if (origin && allowed.includes(origin)) {
      headers.set("access-control-allow-origin", origin);
      headers.set("access-control-allow-methods", "GET, OPTIONS");
      headers.set("access-control-allow-headers", "Content-Type");
      headers.set("access-control-max-age", "86400");
    }
    const response = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers });
    if (origin && !allowed.includes(origin))
      return response({ error: "Origin not allowed" }, 403);
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers });
    if (request.method !== "GET") {
      headers.set("allow", "GET, OPTIONS");
      return response({ error: "Method not allowed" }, 405);
    }
    try {
      const url = new URL(request.url);
      if (url.pathname === "/tokens") {
        const result = await getTokens(url.searchParams, env);
        // Preserve usable stale data and represent unavailable entries explicitly.
        if (result.upstream === "rate_limited")
          headers.set("retry-after", "60");
        return response(
          result,
          result.upstream === "rate_limited" &&
            !result.tokens.some((t) => t.status === "available")
            ? 429
            : 200,
        );
      }
      if (url.pathname === "/events")
        return response(await getEvents(url.searchParams, env));
      return response({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof HttpError)
        return response({ error: error.message }, error.status);
      log({ type: "http_error", error: errorKind(error) });
      return response({ error: "Data service unavailable" }, 503);
    }
  },
  async scheduled(controller, env): Promise<void> {
    await synchronize(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
