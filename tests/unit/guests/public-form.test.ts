import { expect, test } from "vitest";

import { readPublicForm } from "~/server/web/public-form";

test("public body limits apply without Content-Length and count encoded bytes", async () => {
  const request = new Request("https://headplane.test/invite", {
    method: "POST",
    body: new URLSearchParams({ value: "ééé" }),
  });
  expect(request.headers.has("content-length")).toBe(false);
  expect(await readPublicForm(request, 12)).toMatchObject({ ok: false, error: { status: 413 } });
});

test("public form parsing rejects duplicate credentials and unsupported content types", async () => {
  const duplicate = new Request("https://headplane.test/invite", {
    method: "POST",
    body: new URLSearchParams([
      ["csrf", "one"],
      ["csrf", "two"],
    ]),
  });
  expect(await readPublicForm(duplicate, 100)).toMatchObject({ ok: false, error: { status: 400 } });
  const otherType = new Request("https://headplane.test/invite", { method: "POST", body: "{}" });
  expect(await readPublicForm(otherType, 100)).toMatchObject({ ok: false, error: { status: 415 } });
});

test("URL-encoded browser credentials survive bounded parsing unchanged", async () => {
  const result = await readPublicForm(
    new Request("https://headplane.test/invite", {
      method: "POST",
      body: new URLSearchParams({ csrf: "abc", intent: "accept", code: "12345678" }),
    }),
    100,
  );
  expect(result.ok && Object.fromEntries(result.value)).toEqual({
    csrf: "abc",
    intent: "accept",
    code: "12345678",
  });
});
