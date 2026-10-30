import { execFileSync } from "node:child_process";
import { isIP } from "node:net";
import { join } from "node:path";

import tc, { getContainerRuntimeClient } from "testcontainers";

import type { HeadscaleClient } from "~/server/headscale/api";

import { tempDir } from "../support/temp";
import { HARNESS_LABEL } from "./headscale";
import { TAILSCALE_IMAGE } from "./versions";
import { waitFor } from "./wait";

export interface NodeOptions {
  // Explicit address on this test container's private loopback only.
  lanAddress?: string;
  name: string;
  user?: string;
  tags?: string[];
  ssh?: boolean;
  routes?: string[];
  exitNode?: boolean;
  tailscaleVersion?: string;
}

// The tailnet a node joins.
interface Target {
  id: string;
  network: tc.StartedNetwork;
  api: HeadscaleClient;
  controlUrl: string;
  // Trusted by tailscaled so it can reach Headscale over HTTPS.
  caCert: string;
}

const SOCKET = "/var/run/tailscale/tailscaled.sock";

// Tags ride on the auth key when there is one, which skips tagOwners checks.
function upArgs(target: Target, options: NodeOptions, authKey?: string) {
  const args = [
    `--login-server=${target.controlUrl}`,
    `--hostname=${options.name}`,
    "--accept-dns=false",
  ];

  if (authKey) args.push(`--auth-key=${authKey}`);
  if (options.ssh) args.push("--ssh");
  if (options.exitNode) args.push("--advertise-exit-node");
  if (options.routes?.length) args.push(`--advertise-routes=${options.routes.join(",")}`);
  if (!authKey && options.tags?.length) {
    args.push(`--advertise-tags=${options.tags.join(",")}`);
  }

  return args;
}

async function startDaemon(target: Target, options: NodeOptions) {
  const image = options.tailscaleVersion
    ? `tailscale/tailscale:v${options.tailscaleVersion}`
    : TAILSCALE_IMAGE;

  const container = await new tc.GenericContainer(image)
    .withNetwork(target.network)
    .withName(`hp-harness-${target.id}-${options.name}`)
    .withHostname(options.name)
    .withLabels({ [`${HARNESS_LABEL}.node`]: target.id })
    .withAddedCapabilities(...(options.lanAddress ? ["NET_ADMIN"] : []))
    .withEntrypoint(["tailscaled"])
    .withCommand([
      "--tun=userspace-networking",
      "--statedir=/var/lib/tailscale",
      `--socket=${SOCKET}`,
      "--socks5-server=127.0.0.1:1055",
    ])
    .withEnvironment({ SSL_CERT_FILE: "/etc/ssl/harness.pem" })
    .withCopyContentToContainer([{ content: target.caCert, target: "/etc/ssl/harness.pem" }])
    .withStartupTimeout(30_000)
    .start();

  async function exec(args: string[]) {
    const result = await container.exec(args);
    if (result.exitCode !== 0) {
      throw new Error(`${args.join(" ")} failed:\n${result.output}`);
    }

    return result.stdout;
  }

  const tailscale = (args: string[]) => exec(["tailscale", `--socket=${SOCKET}`, ...args]);
  if (options.lanAddress) {
    if (isIP(options.lanAddress) !== 4)
      throw new Error("The isolated LAN fixture requires an IPv4 literal");
    await exec(["ip", "address", "add", `${options.lanAddress}/32`, "dev", "lo"]);
  }
  await waitFor(`tailscaled on ${options.name}`, () => tailscale(["status", "--json"]), {
    interval: 100,
  });

  return { container, exec, tailscale };
}

async function waitForNode(target: Target, name: string, online = true) {
  return waitFor(`${name} to be ${online ? "online" : "offline"}`, async () => {
    const node = (await target.api.nodes.list()).find((n) => n.name === name);
    if (!node) throw new Error(`${name} isn't registered`);
    if (node.online !== online) throw new Error(`online=${node.online}`);
    return node;
  });
}

export async function startNode(target: Target, options: NodeOptions, authKey: string) {
  const daemon = await startDaemon(target, options);
  try {
    await daemon.tailscale(["up", ...upArgs(target, options, authKey)]);
    const machine = await waitForNode(target, options.name);
    return nodeHandle(target, daemon, machine.id, options.name);
  } catch (error) {
    await daemon.container.stop({ remove: true, removeVolumes: true });
    throw error;
  }
}

// Resolves with the register URL a node without an auth key prints.
export async function startPendingNode(target: Target, options: NodeOptions) {
  const daemon = await startDaemon(target, options);
  const command = ["tailscale", `--socket=${SOCKET}`, "up", ...upArgs(target, options)].join(" ");
  await daemon.exec(["sh", "-c", `${command} > /tmp/up.log 2>&1 &`]);

  const pattern = new RegExp(`${target.controlUrl}/register/\\S+`);
  const registerUrl = await waitFor("a registration URL", async () => {
    const match = (await daemon.exec(["cat", "/tmp/up.log"])).match(pattern);
    if (!match) throw new Error("not printed yet");
    return match[0];
  });

  return {
    name: options.name,
    registerUrl,
    async joined({ online = true }: { online?: boolean } = {}) {
      const machine = await waitForNode(target, options.name, online);
      return nodeHandle(target, daemon, machine.id, options.name);
    },
    async stop() {
      await daemon.container.stop({ remove: true, removeVolumes: true });
    },
  };
}

function nodeHandle(
  target: Target,
  daemon: Awaited<ReturnType<typeof startDaemon>>,
  id: string,
  name: string,
) {
  let networkToolReady: Promise<void> | undefined;
  const tool = "/tmp/hp-network-tool";
  const networkTool = () =>
    (networkToolReady ??= (async () => {
      const source = join(await tempDir(), "network-service");
      execFileSync("go", ["build", "-o", source, "./tests/harness/fixtures/network-service.go"], {
        env: { ...process.env, CGO_ENABLED: "0", GOOS: "linux" },
      });
      await daemon.container.copyFilesToContainer([{ source, target: tool, mode: 0o755 }]);
    })());
  return {
    id,
    name,
    exec: daemon.exec,
    tailscale: daemon.tailscale,
    copyFiles: (files: Array<{ source: string; target: string; mode?: number }>) =>
      daemon.container.copyFilesToContainer(files),

    // A real TCP service behind the Tailscale userspace stack, plus bounded
    // probes. Both allowed and denied ports have a listener, so a negative
    // probe is not merely a stopped service.
    async serveHttp(port: number) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid test port");
      await networkTool();
      await daemon.exec([
        "sh",
        "-c",
        '"$1" "$2" >/tmp/hp-network-service.log 2>&1 &',
        "sh",
        tool,
        String(port),
      ]);
      await daemon.tailscale(["serve", "--bg", `--tcp=${port}`, `tcp://127.0.0.1:${port}`]);
    },

    async canConnect(address: string, port: number) {
      await networkTool();
      const result = await daemon.container.exec([tool, "probe", address, String(port)]);
      if (result.exitCode !== 0 && result.exitCode !== 2)
        throw new Error(
          `Network probe failed (${result.exitCode}): ${result.stderr || result.stdout}`,
        );
      return result.stdout.includes("headplane-network-ok");
    },

    async serveUdp(port: number) {
      await networkTool();
      await daemon.exec([
        "sh",
        "-c",
        '"$1" udp-serve "$2" >/tmp/hp-udp-service.log 2>&1 &',
        "sh",
        tool,
        String(port),
      ]);
    },
    async startStream(address: string, port: number) {
      await networkTool();
      await daemon.exec([
        "sh",
        "-c",
        '"$1" stream "$2" "$3" "$4" >/tmp/hp-stream.log 2>&1 &',
        "sh",
        tool,
        address,
        String(port),
        `/tmp/hp-stream-${port}`,
      ]);
    },
    async lastStreamPacket(port: number) {
      return Number(await daemon.exec(["cat", `/tmp/hp-stream-${port}`]));
    },
    async canConnectUdp(address: string, port: number) {
      await networkTool();
      const result = await daemon.container.exec([tool, "probe-udp", address, String(port)]);
      if (result.exitCode !== 0 && result.exitCode !== 2)
        throw new Error(`UDP probe failed (${result.exitCode}): ${result.stderr}`);
      return result.stdout.includes("headplane-network-ok");
    },

    machine() {
      return target.api.nodes.get(id);
    },

    async status() {
      return JSON.parse(await daemon.tailscale(["status", "--json"])) as Record<string, unknown>;
    },

    // Stops the container, like a machine that's switched off.
    async down() {
      const client = await getContainerRuntimeClient();
      await client.container.stop(client.container.getById(daemon.container.getId()), {
        timeout: 5,
      });
      await waitForNode(target, name, false);
    },

    async up() {
      const client = await getContainerRuntimeClient();
      await client.container.start(client.container.getById(daemon.container.getId()));
      await waitForNode(target, name, true);
    },

    async stop() {
      await daemon.container.stop({ remove: true, removeVolumes: true });
    },
  };
}
