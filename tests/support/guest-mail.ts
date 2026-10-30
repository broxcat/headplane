import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function guestMessages(dataPath: string) {
  const directory = join(dataPath, "guest-mail");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".eml")).sort();
  return Promise.all(
    files.map(async (name) =>
      (await readFile(join(directory, name), "utf8"))
        .replace(/=\r?\n/g, "")
        .replace(/=([A-Fa-f0-9]{2})/g, (_, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        ),
    ),
  );
}

export function mailToken(messages: string[]) {
  const match = [...messages]
    .reverse()
    .map((message) => message.match(/#token=([A-Za-z0-9_-]{43})/))
    .find(Boolean);
  if (!match) throw new Error("No invitation message was captured");
  return match[1];
}

export function mailCode(messages: string[]) {
  const match = [...messages]
    .reverse()
    .map((message) => message.match(/code is (\d{8})/))
    .find(Boolean);
  if (!match) throw new Error("No verification message was captured");
  return match[1];
}
