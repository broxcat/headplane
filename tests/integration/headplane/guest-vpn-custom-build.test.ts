import { expect, test } from "vitest";

import { headscaleFaults } from "../../harness/headscale-faults";
import { createTailnet } from "../../harness/tailnet";
import { createGuestTailnet } from "../../support/guest-tailnet";

test.runIf(Boolean(process.env.HP_GUEST_HEADSCALE_BINARY))(
  "an unaudited custom binary or a replaced control server cannot provision Guest identities",
  async () => {
    await using custom = await createGuestTailnet({ policy: { grants: [] } });
    const denied = await custom.headplane({
      config: {
        headscale: { compatibility: { approved_builds: [] } },
        guest_vpn: { enabled: true, single_policy_writer: true },
      },
    });
    const before = { users: await custom.api.users.list(), policy: await custom.api.policy.get() };
    expect(
      await denied.ctx.guestVpn.provision("01M66M24KNQ66SXYSB28KW5P2P", 1, null),
    ).toMatchObject({
      ok: false,
      error: { code: "disabled" },
    });
    await using proxy = await headscaleFaults(custom);
    const allowed = await custom.headplane({
      config: {
        headscale: { url: proxy.url },
        guest_vpn: { enabled: true, single_policy_writer: true },
      },
    });
    await using replacement = await createTailnet({ policy: { grants: [] } });
    const replacementBefore = {
      users: await replacement.api.users.list(),
      policy: await replacement.api.policy.get(),
    };
    proxy.useServer(replacement.server);
    expect(
      await allowed.ctx.guestVpn.provision("01M66M24KNQ66SXYSB28KW5P2P", 1, null),
    ).toMatchObject({
      ok: false,
      error: { code: "build_changed" },
    });
    expect({ users: await custom.api.users.list(), policy: await custom.api.policy.get() }).toEqual(
      before,
    );
    expect({
      users: await replacement.api.users.list(),
      policy: await replacement.api.policy.get(),
    }).toEqual(replacementBefore);
  },
);
