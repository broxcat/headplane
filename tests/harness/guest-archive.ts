import { randomBytes } from "node:crypto";

import tc from "testcontainers";
import { stringify } from "yaml";

import { HARNESS_LABEL } from "./headscale";
import type { Tailnet } from "./tailnet";
import { NODE_IMAGE } from "./versions";

export async function startGuestArchive(tailnet: Tailnet, archive: string) {
  const config = {
    server: {
      host: "0.0.0.0",
      port: 3000,
      base_path: "/console",
      base_url: "http://localhost:3000",
      data_path: "/data",
      cookie_secret: randomBytes(16).toString("hex"),
      cookie_secure: false,
    },
    headscale: {
      url: tailnet.server.controlUrl,
      api_key: tailnet.server.apiKey,
      tls_cert_path: "/test/headscale-ca.pem",
    },
    guest_invitations: { enabled: true, transport: "file" },
  };
  const container = await new tc.GenericContainer(NODE_IMAGE)
    .withNetwork(tailnet.network)
    .withLabels({ [HARNESS_LABEL + ".guest-archive"]: tailnet.id })
    .withExposedPorts(3000)
    .withEnvironment({
      HEADPLANE_CONFIG_PATH: "/test/config.yaml",
      HEADPLANE_LISTEN_FILE: "/tmp/headplane-listen",
      NODE_ENV: "production",
    })
    .withCopyFilesToContainer([{ source: archive, target: "/release.tar.gz" }])
    .withCopyContentToContainer([
      { content: stringify(config), target: "/test/config.yaml" },
      { content: tailnet.server.caCert!, target: "/test/headscale-ca.pem" },
    ])
    .withCommand([
      "sh",
      "-ec",
      "mkdir -p /app /data\ntar -xzf /release.tar.gz --strip-components=1 -C /app\ncd /app\nexec node build/server/index.js",
    ])
    .withWaitStrategy(tc.Wait.forHttp("/console/healthz", 3000).forStatusCode(200))
    .start();
  return {
    container,
    base: `http://${container.getHost()}:${container.getMappedPort(3000)}/console`,
    async [Symbol.asyncDispose]() {
      await container.stop({ remove: true });
    },
  };
}
