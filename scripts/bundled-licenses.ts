import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Plugin } from "vite";

// Build-only paths stay in .cache, never in a browser asset or release archive.
export function bundledLicenses(): Plugin {
  return {
    name: "guest-bundled-licenses",
    apply: "build",
    generateBundle(_options, bundle) {
      const roots = new Set<string>();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const [id, module] of Object.entries(chunk.modules)) {
          if (!module.renderedLength || !id.includes("node_modules")) continue;
          let dir = dirname(id.split("?")[0]);
          while (dir.includes("node_modules")) {
            try {
              const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
              if (pkg.name && pkg.version) {
                roots.add(dir);
                break;
              }
            } catch {
              /* an intermediate directory is not a package root */
            }
            dir = dirname(dir);
          }
        }
      }
      mkdirSync(".cache", { recursive: true });
      writeFileSync(
        `.cache/guest-licenses-${this.environment.name}.json`,
        JSON.stringify([...roots].sort()),
      );
    },
  };
}
