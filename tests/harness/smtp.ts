import type { AddressInfo } from "node:net";

import { SMTPServer } from "smtp-server";

import { harnessCertificate } from "./headscale";

// A real SMTP listener confined to loopback, with the harness certificate.
// Messages are kept only in memory, and no external recipient is contacted.
export async function startTestSmtp(
  options: {
    security: "tls" | "starttls";
    reject?: "temporary" | "permanent";
    hideStartTls?: boolean;
  } = { security: "starttls" },
) {
  const tls = await harnessCertificate();
  const messages: string[] = [];
  let attempts = 0;
  const server = new SMTPServer({
    secure: options.security === "tls",
    key: tls.key,
    cert: tls.cert,
    hideSTARTTLS: options.hideStartTls,
    disabledCommands: options.hideStartTls ? ["STARTTLS"] : [],
    logger: false,
    onAuth(auth, _session, callback) {
      callback(
        auth.username === "test-user" && auth.password === "test-password"
          ? null
          : new Error("Authentication refused"),
        { user: "test-user" },
      );
    },
    onMailFrom(_address, _session, callback) {
      attempts++;
      if (options.reject)
        return callback(
          Object.assign(new Error("Delivery refused"), {
            responseCode: options.reject === "temporary" ? 451 : 550,
          }),
        );
      callback();
    },
    onData(stream, _session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        messages.push(Buffer.concat(chunks).toString("utf8"));
        callback();
      });
      stream.on("error", callback);
    },
  });
  server.on("error", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.server.address() as AddressInfo).port;
  const stop = () => new Promise<void>((resolve) => server.close(resolve));
  return {
    port,
    caPath: tls.certPath,
    messages,
    attempts: () => attempts,
    stop,
    [Symbol.asyncDispose]: stop,
  };
}
