import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  lstatSync,
  cpSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export function guestVersion(tag: string, version: string) {
  if (!/^v\d+\.\d+\.\d+-guest$/.test(tag) || tag !== `v${version}`)
    throw new Error("Use v<base-version>-guest matching package.json, without feature counters.");
  return tag.slice(1);
}
export function safeReleasePath(path: string) {
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.split(/[\\/]/).some((part) => ["..", ".git", "node_modules"].includes(part))
  )
    throw new Error("Unsafe release path");
  if (
    /(^|\/)(?:\.env(?:\..*)?|node_modules|DEV_SETUP\.md|HEADSCALE_OPERATIONS\.md|TAILSCALE_MIGRATION_PLAN\.md)$/.test(
      path,
    ) ||
    /\.(?:map|db|sqlite3?|eml|key|pem|log)$/i.test(path)
  )
    throw new Error(`Forbidden release file: ${path}`);
}
export function scanContents(data: Buffer, path: string) {
  safeReleasePath(path);
  const text = data.toString("utf8");
  if (
    data.subarray(0, 16).toString() === "SQLite format 3\0" ||
    /-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----\r?\n[A-Za-z0-9+/=\r\n]{64,}-----END/.test(text) ||
    /\bgh[pousr]_[A-Za-z0-9]{36,}\b/.test(text) ||
    /\/home\/brokcat\/|B550-GAMING-X-V2|192\.168\.0\.120/.test(text)
  )
    throw new Error(`Sensitive material in release file: ${path}`);
  if (/\.(?:js|css)$/.test(path) && text.includes("sourceMappingURL"))
    throw new Error(`Source map reference: ${path}`);
}
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const command = (cmd: string, args: string[], cwd = root) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
const git = (...args: string[]) => command("git", args);
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
function files(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      if (lstatSync(path).isSymbolicLink()) throw Error("Release symlinks are not allowed");
      return statSync(path).isDirectory() ? files(path) : [path];
    });
}

export function verifyTag(tag: string) {
  guestVersion(tag, json(join(root, "package.json")).version);
  if (git("cat-file", "-t", `refs/tags/${tag}`) !== "tag")
    throw Error("An annotated release tag is required");
  if (git("rev-parse", `${tag}^{commit}`) !== git("rev-parse", "HEAD"))
    throw Error("Tag and checkout differ");
  if (!/github\.com[:/]broxcat\/headplane(?:\.git)?$/.test(git("remote", "get-url", "origin")))
    throw Error("Release only from broxcat/headplane");
  command("git", ["merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main"]);
  if (git("status", "--porcelain", "--untracked-files=no"))
    throw Error("Release checkout must be clean");
  for (const file of [
    "app/server/guests.ts",
    "app/server/guest-invitations.ts",
    "app/routes/settings/guest-email.tsx",
    "drizzle/20261029220612_guest_access_duration/migration.sql",
  ])
    if (!existsSync(join(root, file))) throw Error("Guest foundations are missing");
}

function licenses(target: string) {
  const entries: object[] = [];
  const overrides = json(join(root, "release/license-overrides.json"));
  const roots = new Set<string>();
  for (const name of readdirSync(join(root, ".cache")).filter((n) =>
    /^guest-licenses-.*\.json$/.test(n),
  ))
    for (const path of json(join(root, ".cache", name))) roots.add(path);
  // Font CSS is extracted as an asset and can have no rendered JS module.
  roots.add(join(root, "node_modules/@fontsource-variable/inter"));
  const copyLicenses = (dir: string, where: string) => {
    mkdirSync(where, { recursive: true });
    const found = readdirSync(dir).filter(
      (n) =>
        /^(?:licen[sc]e|copying|notice|copyright|ofl)(?:[._-]|$)/i.test(n) &&
        statSync(join(dir, n)).isFile(),
    );
    for (const name of found) cpSync(join(dir, name), join(where, name));
    return found;
  };
  for (const dir of [...roots].sort()) {
    const pkg = json(join(dir, "package.json"));
    const id = `${pkg.name}@${pkg.version}`;
    const dest = join(target, "THIRD_PARTY/node", id.replace(/[^A-Za-z0-9_.-]/g, "_"));
    let found = copyLicenses(dir, dest);
    if (!found.length) {
      const fallback = overrides[id];
      if (!fallback) throw Error(`Missing bundled license: ${id}`);
      writeFileSync(join(dest, "LICENSE"), fallback.text);
      writeFileSync(
        join(dest, "SOURCE.json"),
        JSON.stringify({ source: fallback.source, blob: fallback.blob }, null, 2),
      );
      found = ["LICENSE"];
    }
    entries.push({
      ecosystem: "npm",
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      notices: relative(target, dest),
    });
  }
  const modules = new Map<string, string>();
  for (const binary of [".cache/guest-bin/hp_agent", ".cache/guest-bin/hp_healthcheck"])
    for (const match of command("go", ["version", "-m", join(root, binary)]).matchAll(
      /^\s*dep\s+(\S+)\s+(\S+)/gm,
    ))
      modules.set(match[1], match[2]);
  const wasmDependencies = execFileSync(
    "go",
    [
      "list",
      "-deps",
      "-tags",
      readFileSync(join(root, "cmd/hp_ssh/build-tags.txt"), "utf8").trim(),
      "-f",
      "{{if .Module}}{{.Module.Path}} {{.Module.Version}}{{end}}",
      "./cmd/hp_ssh",
    ],
    {
      cwd: root,
      env: { ...process.env, GOOS: "js", GOARCH: "wasm", CGO_ENABLED: "0" },
      encoding: "utf8",
    },
  );
  for (const line of wasmDependencies.split("\n")) {
    const [name, version] = line.trim().split(/\s+/);
    if (name && version) modules.set(name, version);
  }
  for (const [name, version] of [...modules].sort()) {
    const mod = JSON.parse(command("go", ["list", "-m", "-json", name]));
    const dir = mod.Replace?.Dir ?? mod.Dir;
    if (!dir) throw Error(`Missing Go module source: ${name}`);
    const dest = join(
      target,
      "THIRD_PARTY/go",
      `${name}@${version}`.replace(/[^A-Za-z0-9_.-]/g, "_"),
    );
    const found = copyLicenses(dir, dest);
    if (!found.length) throw Error(`Missing Go license: ${name}`);
    const text = found.map((n) => readFileSync(join(dir, n), "utf8")).join("\n");
    if (/Mozilla Public License|GNU (?:LESSER |AFFERO )?GENERAL PUBLIC LICENSE/.test(text))
      cpSync(dir, join(dest, "SOURCE"), { recursive: true });
    entries.push({ ecosystem: "go", name, version, notices: relative(target, dest) });
  }
  const goroot = command("go", ["env", "GOROOT"]);
  mkdirSync(join(target, "THIRD_PARTY/go-toolchain"), { recursive: true });
  for (const name of ["LICENSE", "PATENTS"])
    if (existsSync(join(goroot, name)))
      cpSync(join(goroot, name), join(target, "THIRD_PARTY/go-toolchain", name));
  writeFileSync(
    join(target, "THIRD_PARTY/inventory.json"),
    JSON.stringify(entries, null, 2) + "\n",
  );
  writeFileSync(
    join(target, "THIRD_PARTY_NOTICES.md"),
    "# Third-party notices\n\nOriginal dependency licenses and notices are in THIRD_PARTY/. inventory.json lists the bundled npm packages and Go modules. Font licensing and Go runtime notices are included. Where a module requires corresponding source, it is included alongside its license. The Tailscale WASM modification is supplied in patches/. Node.js is a separate prerequisite and is not redistributed in this archive.\n",
  );
}

export function packageGuest(tag: string, output: string) {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw Error("Package on Linux AMD64 only");
  const version = guestVersion(tag, json(join(root, "package.json")).version);
  const out = resolve(output);
  mkdirSync(out, { recursive: true });
  const temporary = mkdtempSync(join(tmpdir(), "headplane-guest-package-"));
  const name = `headplane-${version}-linux-amd64`;
  const target = join(temporary, name);
  mkdirSync(target);
  try {
    for (const dir of ["build/client", "build/server", "drizzle"])
      cpSync(join(root, dir), join(target, dir), { recursive: true });
    for (const binary of ["hp_agent", "hp_healthcheck"])
      cpSync(join(root, ".cache/guest-bin", binary), join(target, binary));
    for (const path of [
      "LICENSE",
      "config.example.yaml",
      "release/INSTALL.md",
      "release/RELEASE-NOTES.md",
      "release/headplane.service.example",
    ])
      cpSync(join(root, path), join(target, basename(path)));
    writeFileSync(
      join(target, "README.md"),
      `# Headplane ${version} — Guest fork\n\nLinux AMD64 archive. Node.js 24 is required separately; no runtime node_modules is needed.\n\n- [Installation, update and rollback](INSTALL.md)\n- [Release notes and limitations](RELEASE-NOTES.md)\n- [Guest management](docs/guest-management.md)\n- [Invitations and SMTP](docs/guest-invitations.md)\n- [Version and source metadata](release.json)\n- [Third-party notices](THIRD_PARTY_NOTICES.md)\n\nOriginal Headplane by Aarnav Tale and contributors: https://github.com/tale/headplane. Guest fork: https://github.com/broxcat/headplane. Keep LICENSE and THIRD_PARTY/ with redistributed copies. Guest acceptance grants no VPN access.\n`,
    );
    mkdirSync(join(target, "docs"));
    for (const file of ["guest-management.md", "guest-invitations.md"])
      cpSync(join(root, "docs/features", file), join(target, "docs", file));
    mkdirSync(join(target, "patches"));
    cpSync(
      join(root, "patches/tailscale-netcheck-derp-port.patch"),
      join(target, "patches/tailscale-netcheck-derp-port.patch"),
    );
    licenses(target);
    const epoch = Number(git("show", "-s", "--format=%ct", "HEAD"));
    writeFileSync(
      join(target, "release.json"),
      JSON.stringify(
        {
          version,
          baseVersion: version.replace(/-guest$/, ""),
          tag,
          commit: git("rev-parse", "HEAD"),
          sourceTree: git("rev-parse", "HEAD^{tree}"),
          sourceDirty: !!git("status", "--porcelain", "--untracked-files=no"),
          sourceDateEpoch: epoch,
          platform: "linux",
          arch: "amd64",
          toolchains: json(join(root, "release/toolchains.json")),
          runtime: {
            node: json(join(root, "package.json")).engines.node,
            nodeModulesRequired: false,
          },
          upstream: "https://github.com/tale/headplane",
          sourcemaps: false,
        },
        null,
        2,
      ) + "\n",
    );
    const manifest = Object.fromEntries(
      files(target).map((path) => {
        scanContents(readFileSync(path), relative(target, path));
        return [relative(target, path), sha(readFileSync(path))];
      }),
    );
    writeFileSync(
      join(target, "MANIFEST.sha256"),
      Object.entries(manifest)
        .map(([name, digest]) => `${digest}  ${name}`)
        .join("\n") + "\n",
    );
    const tar = execFileSync(
      "tar",
      [
        "--sort=name",
        `--mtime=@${epoch}`,
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--mode=u+rwX,go+rX,go-w",
        "-cf",
        "-",
        name,
      ],
      { cwd: temporary, maxBuffer: 512 * 1024 * 1024 },
    );
    const archive = `${name}.tar.gz`;
    writeFileSync(join(out, archive), gzipSync(tar, { level: 9 }));
    for (const file of ["INSTALL.md", "RELEASE-NOTES.md", "release.json", "THIRD_PARTY_NOTICES.md"])
      cpSync(join(target, file), join(out, file));
    const assets = [
      archive,
      "INSTALL.md",
      "RELEASE-NOTES.md",
      "release.json",
      "THIRD_PARTY_NOTICES.md",
    ];
    writeFileSync(
      join(out, "SHA256SUMS"),
      assets.map((file) => `${sha(readFileSync(join(out, file)))}  ${file}`).join("\n") + "\n",
    );
    console.log(
      JSON.stringify({
        archive: join(out, archive),
        version,
        files: Object.keys(manifest).length,
        sha256: sha(readFileSync(join(out, archive))),
      }),
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, tag, output] = process.argv.slice(2);
  if (operation === "verify-tag") verifyTag(tag);
  else if (operation === "package" && output) packageGuest(tag, output);
  else throw Error("Usage: guest-release.ts verify-tag <tag> | package <tag> <output-directory>");
}
