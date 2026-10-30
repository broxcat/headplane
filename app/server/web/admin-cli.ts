import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";

import { loadConfig } from "../config/load";
import { createDbClient } from "../db/client.server";
import { createLocalAuthService } from "./local-auth";

class AdminCommandError extends Error {}

type LocalAuth = ReturnType<typeof createLocalAuthService>;
interface Prompt {
  text(label: string): Promise<string>;
  secret(label: string): Promise<string>;
}

export async function adminCommand(
  local: LocalAuth,
  args: string[],
  prompt: Prompt,
): Promise<string> {
  const [command, username, ...extra] = args;
  if (
    extra.length ||
    (command !== "create" && command !== "list" && !username) ||
    (command === "list" && username)
  )
    throw new AdminCommandError("Invalid arguments.");
  if (command === "list") return JSON.stringify(local.list(), null, 2);
  if (command === "create" || command === "reset-password") {
    const name = username ?? (await prompt.text("Username: "));
    const display = command === "create" ? await prompt.text("Display name: ") : "";
    const password = await prompt.secret("Password: ");
    const confirmation = await prompt.secret("Confirm password: ");
    if (password !== confirmation) throw new AdminCommandError("Passwords do not match.");
    const result =
      command === "create"
        ? await local.create(name, display, password)
        : await local.replacePassword(name, password);
    if (!result.ok) throw new AdminCommandError(result.error);
    return command === "create"
      ? "Administrator created."
      : "Password reset. All sessions revoked.";
  }
  if (command === "enable" || command === "disable" || command === "revoke-sessions") {
    const result =
      command === "revoke-sessions"
        ? local.revokeByUsername(username)
        : local.setEnabled(username, command === "enable");
    if (!result.ok) throw new AdminCommandError(result.error);
    return "Account updated. All sessions revoked.";
  }
  throw new AdminCommandError("Unknown command.");
}

const terminalPrompt: Prompt = {
  async text(label) {
    if (!stdin.isTTY || !stdout.isTTY) throw new Error("An interactive terminal is required.");
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      return await rl.question(label);
    } finally {
      rl.close();
    }
  },
  async secret(label) {
    if (!stdin.isTTY || !stdout.isTTY) throw new Error("An interactive terminal is required.");
    stdout.write(label);
    emitKeypressEvents(stdin);
    const previous = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    return new Promise<string>((resolve, reject) => {
      let value = "";
      const cleanup = () => {
        stdin.off("keypress", onKey);
        stdin.setRawMode(previous);
        stdin.pause();
        stdout.write("\n");
      };
      const onKey = (
        text: string | undefined,
        key: { name?: string; ctrl?: boolean; meta?: boolean },
      ) => {
        if (key.ctrl && (key.name === "c" || key.name === "d")) {
          cleanup();
          reject(new Error("Cancelled."));
        } else if (key.name === "return" || key.name === "enter") {
          cleanup();
          resolve(value);
        } else if (key.name === "backspace") {
          value = [...value].slice(0, -1).join("");
        } else if (
          text &&
          !key.ctrl &&
          !key.meta &&
          ![...text].some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          )
        ) {
          // Refuse oversize input instead of silently truncating it.
          if ([...value, ...text].length > 256) {
            cleanup();
            reject(new Error("Password exceeds 256 characters."));
          } else value += text;
        }
      };
      stdin.on("keypress", onKey);
    });
  },
};

export async function runAdmin(args: string[]) {
  process.umask(0o077);
  const configIndex = args.indexOf("--config");
  let configPath: string | undefined;
  if (configIndex !== -1) {
    configPath = args[configIndex + 1];
    if (!configPath) {
      console.error("--config requires a path.");
      process.exitCode = 1;
      return;
    }
    args = [...args.slice(0, configIndex), ...args.slice(configIndex + 2)];
  }
  if (args.length === 0 || args[0] === "--help") {
    console.log(
      "Usage: node build/server/index.js admin <create|list|enable|disable|reset-password|revoke-sessions> [username] [--config path]",
    );
    return;
  }
  let db: Awaited<ReturnType<typeof createDbClient>> | undefined;
  try {
    const config = await loadConfig(configPath);
    db = await createDbClient(join(config.server.data_path, "hp_persist.db"));
    const local = createLocalAuthService(db, config.server.cookie_secret);
    console.log(await adminCommand(local, args, terminalPrompt));
  } catch (error) {
    // SQL driver exceptions can contain bound credential values. Never print them.
    console.error(
      error instanceof AdminCommandError
        ? error.message
        : "Administrator command failed. Check arguments, configuration, database access and the interactive terminal.",
    );
    process.exitCode = 1;
  } finally {
    db?.$client.close();
  }
}
