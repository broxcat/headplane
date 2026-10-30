import type { RouterContextProvider } from "react-router";

import {
  appConfigContext,
  authContext,
  headscaleContext,
  requestApiContext,
} from "~/server/context";
import { resourceCatalog } from "~/server/guest-resources";
import { ActionError } from "~/server/web/actions";
import { Capabilities } from "~/server/web/roles";
import type { ResourceCatalog } from "~/utils/guest-resources";

export async function loadResourceCatalog(
  request: Request,
  context: Readonly<RouterContextProvider>,
): Promise<ResourceCatalog> {
  await context.get(authContext).requireCapability(request, Capabilities.read_machines);
  try {
    const { api } = await context.get(requestApiContext)(request);
    return { nodes: resourceCatalog(await api.nodes.list()), error: null };
  } catch {
    return {
      nodes: [],
      error:
        "Cannot load current Headscale machines. Reload to retry; saved intentions have not changed.",
    };
  }
}
export async function loadPreviewPolicy(
  request: Request,
  context: Readonly<RouterContextProvider>,
) {
  await context.get(authContext).requireCapability(request, Capabilities.read_policy);
  const hs = context.get(headscaleContext);
  let policy: string | null = null;
  try {
    const { api } = await context.get(requestApiContext)(request);
    policy = (await api.policy.get()).policy;
  } catch {
    /* Unavailable is never an empty policy. */
  }
  return {
    policy,
    supportsGrants: hs.capabilities.policySupportsGrants,
    versionKnown: !hs.version.unknown,
  };
}
export function requireResourceOrigin(request: Request, context: Readonly<RouterContextProvider>) {
  const internal = new URL(request.url);
  const configured = context.get(appConfigContext).server.base_url;
  const expected = configured ? new URL(configured) : internal;
  const origin = request.headers.get("origin");
  if (
    !origin ||
    (origin !== expected.origin && !(expected.host === internal.host && origin === internal.origin))
  )
    throw new ActionError("Resource changes require a same-origin request.", 403);
}
