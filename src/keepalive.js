import http from "node:http";

import { logger } from "./util.js";

export function startHealthServer(port, statusFn) {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      const body = JSON.stringify({
        ok: true,
        uptime_s: Math.floor(process.uptime()),
        ...statusFn()
      });
      res.writeHead(200, {
        "content-type": "application/json"
      });
      res.end(body);
      return;
    }
    res.writeHead(200, {
      "content-type": "text/plain"
    });
    res.end("ok");
  });
  server.listen(port, "0.0.0.0", () => {
    logger.info(`health server listening on :${port}`);
  });
  server.on("error", err => logger.error("health server error:", err.message));
  return server;
}
