import { createServer, type Server } from "node:http";

export function startHealthServer(portValue: string | undefined): Server | undefined {
  if (portValue === undefined) return undefined;
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("HEALTH_PORT должен быть целым числом от 1 до 65535.");
  }

  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ status: "ok" }));
  });
  server.listen(port, "127.0.0.1");
  return server;
}
