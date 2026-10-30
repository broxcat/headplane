import { createServer } from "node:http";
import { Agent, request } from "node:https";
import type { Socket, AddressInfo } from "node:net";

import type { Tailnet } from "./tailnet";

// A transport fault injector in front of the real server. It never implements
// a Headscale endpoint or fabricates a successful Headscale response.
export async function headscaleFaults(tailnet: Tailnet) {
  const agent = new Agent({ ca: tailnet.server.caCert });
  let unavailable = false;
  let denyUserCreate = false;
  let drop: string | null = null;
  let pause: { path: string; entered(): void; released: Promise<void> } | null = null;
  const sockets = new Set<Socket>();
  const server = createServer((incoming, outgoing) => {
    if (denyUserCreate && incoming.method === "POST" && incoming.url === "/api/v1/user") {
      denyUserCreate = false;
      outgoing.writeHead(503).end('{"message":"isolated create outage"}');
      return;
    }
    if (unavailable) {
      outgoing.writeHead(503).end('{"message":"isolated test outage"}');
      return;
    }
    const upstream = request(
      new URL(incoming.url!, tailnet.server.url),
      { method: incoming.method, headers: incoming.headers, agent },
      async (response) => {
        if (drop === incoming.url && incoming.method === "PUT") {
          drop = null;
          response.resume();
          response.once("end", () => outgoing.destroy());
          return;
        }
        const gate = pause;
        if (gate && gate.path === incoming.url) {
          pause = null;
          gate.entered();
          await gate.released;
        }
        outgoing.writeHead(response.statusCode!, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => outgoing.destroy());
    incoming.pipe(upstream);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    unavailable(value: boolean) {
      unavailable = value;
    },
    denyUserCreationOnce() {
      denyUserCreate = true;
    },
    dropPolicyReply() {
      drop = "/api/v1/policy";
    },
    pausePolicyValidation() {
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      pause = { path: "/api/v1/policy/check", entered, released };
      return { ready, release };
    },
    async [Symbol.asyncDispose]() {
      for (const socket of sockets) socket.destroy();
      agent.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
