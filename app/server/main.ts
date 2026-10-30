import { resolve } from "node:path";
import process from "node:process";

// Dispatch maintenance before importing app.ts: no HTTP listener, Headscale
// connection, agent or background task is started for server-side recovery.
if (process.argv[2] === "admin") {
  const { runAdmin } = await import("./web/admin-cli");
  await runAdmin(process.argv.slice(3));
} else {
  const { startServer } = await import("./start-server");
  await startServer(resolve(import.meta.dirname, "../client"));
}
