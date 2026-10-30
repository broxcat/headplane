import { readFile } from "node:fs/promises";

import { guestBuildCompatibility } from "~/server/headscale/api/build-info";
import type { ApprovedBuild } from "~/server/headscale/api/build-info";

import { createTailnet, type TailnetOptions } from "../harness/tailnet";
import { LATEST_HEADSCALE } from "../harness/versions";
import type { TestAppOptions } from "./app";

// Explicit, opt-in validation of an audited binary. Never infer an approval
// from the server being tested. Neither variable is used by application code.
export async function guestBuildApprovals(): Promise<ApprovedBuild[] | undefined> {
  if (!process.env.HP_GUEST_HEADSCALE_BINARY) return undefined;
  const path = process.env.HP_GUEST_BUILD_APPROVAL;
  if (!path) throw new Error("An independently audited build approval file is required.");
  return [JSON.parse(await readFile(path, "utf8"))];
}

export async function createGuestTailnet(options: TailnetOptions = {}) {
  const binaryPath = process.env.HP_GUEST_HEADSCALE_BINARY;
  if (!binaryPath) return createTailnet(options);
  if (options.version && options.version !== LATEST_HEADSCALE)
    throw new Error("Custom Guest validation must run separately from the multiversion matrix.");
  const approvals = (await guestBuildApprovals())!;
  const tailnet = await createTailnet({ ...options, binaryPath });
  try {
    if (guestBuildCompatibility(tailnet.headscale.build, approvals) !== "approved_build")
      throw new Error("The isolated binary does not match the independently audited approval.");
  } catch (error) {
    await tailnet.dispose();
    throw error;
  }
  return {
    ...tailnet,
    async headplane(appOptions: Pick<TestAppOptions, "config"> = {}) {
      return tailnet.headplane({
        config: {
          ...appOptions.config,
          headscale: {
            compatibility: { approved_builds: approvals },
            ...appOptions.config?.headscale,
          },
        },
      });
    },
  };
}
