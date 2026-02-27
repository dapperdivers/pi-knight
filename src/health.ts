import http from "node:http";
import type { KnightConfig } from "./config.js";
import { registry } from "./metrics.js";
import { getStatus as getNatsStatus } from "./nats.js";
import { handleIntrospect } from "./introspect.js";

let server: http.Server | null = null;
let skillCount = 0;
let activeTaskCount = 0;

export function setSkillCount(n: number): void {
  skillCount = n;
}
export function setActiveTaskCount(n: number): void {
  activeTaskCount = n;
}

export function startHealthServer(config: KnightConfig): void {
  const startTime = Date.now();

  server = http.createServer(async (req, res) => {
    const url = req.url ?? "/";

    if (url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          uptime: Math.floor((Date.now() - startTime) / 1000),
          knight: config.knightName,
        }),
      );
    } else if (url === "/ready") {
      const nats = getNatsStatus();
      const status = nats.connected ? 200 : 503;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: nats.connected ? "ready" : "not_ready",
          nats: nats.connected ? "connected" : "disconnected",
          activeTasks: activeTaskCount,
          skillsLoaded: skillCount,
          model: config.knightModel,
          knight: config.knightName,
        }),
      );
    } else if (url === "/introspect" || url?.startsWith("/introspect?")) {
      const urlObj = new URL(url, "http://localhost");
      const type = (urlObj.searchParams.get("type") ?? "stats") as "stats" | "recent" | "tree";
      const limit = parseInt(urlObj.searchParams.get("limit") ?? "20", 10);
      const result = handleIntrospect({ type, limit }, config);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result, null, 2));
    } else if (url === "/metrics") {
      try {
        const metrics = await registry.metrics();
        res.writeHead(200, { "Content-Type": registry.contentType });
        res.end(metrics);
      } catch {
        res.writeHead(500);
        res.end("Error collecting metrics");
      }
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.listen(config.metricsPort, () => {
    // logged by caller
  });
}

export function stopHealthServer(): Promise<void> {
  return new Promise((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
}
