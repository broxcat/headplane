import type { Machine } from "~/types";

import type { Capabilities } from "../capabilities";
import type { Transport } from "../transport";

export interface AuthApi {
  register(user: string, authId: string): Promise<Machine>;
  /**
   * Approve a pending Headscale authentication request.
   * Used by the Headplane agent to auto-approve its own registration.
   */
  approve(authId: string): Promise<void>;
}

export function makeAuthApi(
  transport: Transport,
  _capabilities: Capabilities,
  apiKey: string,
): AuthApi {
  return {
    register: async (user, authId) => {
      // Auth IDs belong in the JSON body, never in URLs or transport errors.
      const { node } = await transport.request<{ node: Machine }>({
        method: "POST",
        path: "v1/auth/register",
        apiKey,
        body: { user, authId },
      });
      return { ...node, tags: node.tags ?? [] };
    },
    approve: async (authId) => {
      await transport.request({
        method: "POST",
        path: "v1/auth/approve",
        apiKey,
        body: { authId },
      });
    },
  };
}
