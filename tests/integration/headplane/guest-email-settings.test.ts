import { expect, test } from "vitest";

import { loader, action } from "~/routes/settings/guest-email";

import { createTailnet } from "../../harness/tailnet";
import { statusOf } from "../../support/app";

test("email settings expose only safe metadata and file checks send nothing or change Headscale", async () => {
  await using tailnet = await createTailnet({ policy: { acls: [] } });
  const before = await tailnet.api.policy.get();
  const app = await tailnet.headplane({
    config: {
      server: { base_url: "https://headplane.test" },
      guest_invitations: {
        enabled: true,
        transport: "file",
        smtp: {
          host: "unused.example.test",
          username: "private-login",
          password: "never-serialize-this-password",
        },
      },
    },
  });
  const admin = (await app.signIn("admin")).cookie;
  const read = await app.call(loader, "/settings/guest-email", { as: admin });
  expect(statusOf(read)).toBe(200);
  expect(JSON.stringify(read)).not.toMatch(/never-serialize-this-password|private-login|password/);
  const checked = await app.call(action, "/settings/guest-email", {
    as: admin,
    form: { intent: "check_connection" },
  });
  expect(statusOf(checked)).toBe(200);
  expect(checked).toMatchObject({
    ok: true,
    message: "Local file transport is writable. No email was sent.",
  });
  const refused = await app.call(action, "/settings/guest-email", {
    as: admin,
    form: { intent: "check_connection" },
  });
  expect(statusOf(refused)).toBe(429);
  const member = (await app.signIn("member")).cookie;
  expect(statusOf(await app.call(loader, "/settings/guest-email", { as: member }))).toBe(403);
  expect(
    statusOf(
      await app.call(action, "/settings/guest-email", {
        as: member,
        form: { intent: "check_connection" },
      }),
    ),
  ).toBe(403);
  expect(await tailnet.api.policy.get()).toEqual(before);
});
