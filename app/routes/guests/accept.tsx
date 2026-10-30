import { useEffect, useRef } from "react";
import { createCookie, data, useFetcher, type HeadersFunction } from "react-router";
import * as v from "valibot";

import Button from "~/components/button";
import Callout from "~/components/callout";
import Input from "~/components/input";
import Link from "~/components/link";
import PageHeader from "~/components/page-header";
import { appConfigContext, invitationsContext, guestVpnContext } from "~/server/context";
import {
  equalHash,
  invitationCsrf,
  invitationToken,
  validInvitationToken,
} from "~/server/invitation-tokens";
import { readPublicForm } from "~/server/web/public-form";
import { formValues, parseValues } from "~/utils/form";

import type { Route } from "./+types/accept";
import { invitationStatus } from "./actions";
import { vpnCookie, readVpnSession } from "./vpn-session.server";

export const publicInvitationHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
};

export const headers: HeadersFunction = ({ loaderHeaders, actionHeaders }) => {
  const result = new Headers(publicInvitationHeaders);
  for (const source of [loaderHeaders, actionHeaders])
    for (const cookie of source.getSetCookie()) result.append("Set-Cookie", cookie);
  return result;
};

async function readSession(
  request: Request,
  config: import("~/server/config/config-schema").HeadplaneConfig,
) {
  const cookie = createCookie("_hp_guest_invitation", {
    secrets: [config.server.cookie_secret],
    httpOnly: true,
    sameSite: "strict",
    secure: config.server.cookie_secure,
    path: `${config.server.base_path}/`,
    maxAge: 15 * 60,
  });
  let value: unknown;
  try {
    value = await cookie.parse(request.headers.get("cookie"));
  } catch {
    value = undefined;
  }
  return {
    cookie,
    session: typeof value === "string" && validInvitationToken(value) ? value : undefined,
  };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const config = context.get(appConfigContext);
  const { cookie, session: previous } = await readSession(request, config);
  const session = previous ?? invitationToken();
  const inspected = context.get(invitationsContext).inspect(session);
  const headers = new Headers(publicInvitationHeaders);
  if (!previous) headers.append("Set-Cookie", await cookie.serialize(session));
  const vpn = context.get(guestVpnContext);
  if (vpn.enabled && inspected.ok && inspected.value.stage === "accepted") {
    const id = context.get(invitationsContext).verifiedGuest(session);
    const scoped = await readVpnSession(request, config);
    if (id && vpn.sessionGuest(scoped) !== id) {
      const limited = context.get(invitationsContext).checkRate(`vpn-session:${session}`, 5);
      if (!limited.ok)
        throw data("Onboarding session temporarily unavailable.", { status: 429, headers });
      const opened = vpn.openSession(session);
      if (!opened.ok)
        throw data("Onboarding session temporarily unavailable.", { status: 503, headers });
      headers.append("Set-Cookie", await vpnCookie(config).serialize(opened.value));
    }
  }
  return data(
    {
      stage: inspected.ok ? inspected.value.stage : ("start" as const),
      codeSent: inspected.ok && inspected.value.codeSent,
      expires: inspected.ok ? inspected.value.expires : null,
      csrf: invitationCsrf(config.server.cookie_secret, session),
      vpnEnabled: context.get(guestVpnContext).enabled,
    },
    { headers },
  );
}

const publicForm = v.object({
  intent: v.picklist(["exchange", "send_code", "accept"]),
  csrf: v.pipe(v.string(), v.maxLength(64)),
  token: v.optional(v.pipe(v.string(), v.maxLength(64)), ""),
  code: v.optional(v.pipe(v.string(), v.maxLength(32)), ""),
  consent: v.optional(v.literal("yes")),
});

export const action = Object.assign(
  async ({ request, context }: Route.ActionArgs) => {
    const config = context.get(appConfigContext);
    const headers = new Headers(publicInvitationHeaders);
    const reject = (message: string, status = 400) =>
      data({ ok: false as const, error: message }, { status, headers });
    // Require a browser Origin as well as the session-bound CSRF value. Never
    // trust X-Forwarded-* supplied by a public visitor for this decision.
    const origin = request.headers.get("origin");
    const expected = config.server.base_url
      ? new URL(config.server.base_url).origin
      : new URL(request.url).origin;
    // The existing runtime aligns same-host HTTPS origins to its internal HTTP scheme.
    const internal = new URL(request.url);
    if (
      !origin ||
      (origin !== expected &&
        !(new URL(expected).host === internal.host && origin === internal.origin))
    )
      return reject("This request could not be verified. Reload the invitation page.", 403);
    const bounded = await readPublicForm(request, 4096);
    if (!bounded.ok) return reject(bounded.error.message, bounded.error.status);
    const parsed = parseValues(publicForm, formValues(bounded.value));
    if (!parsed.ok) return reject("Invalid invitation request.");
    if (parsed.data.intent === "accept" && parsed.data.consent !== "yes")
      return reject("Confirm acceptance of the administrative invitation.");
    const { cookie, session } = await readSession(request, config);
    if (
      !session ||
      !equalHash(parsed.data.csrf, invitationCsrf(config.server.cookie_secret, session))
    )
      return reject("This request could not be verified. Reload the invitation page.", 403);
    const invitations = context.get(invitationsContext);
    if (parsed.data.intent === "exchange") {
      const result = invitations.exchange(parsed.data.token);
      if (!result.ok) return reject(result.error.message, invitationStatus[result.error.code]);
      headers.set("Set-Cookie", await cookie.serialize(result.value));
    } else {
      const result =
        parsed.data.intent === "send_code"
          ? await invitations.sendCode(session)
          : invitations.accept(session, parsed.data.code);
      if (!result.ok) return reject(result.error.message, invitationStatus[result.error.code]);
      if (parsed.data.intent === "accept" && context.get(guestVpnContext).enabled) {
        const onboarding = context.get(guestVpnContext).openSession(session);
        if (!onboarding.ok) return reject(onboarding.error.message, 503);
        headers.append("Set-Cookie", await vpnCookie(config).serialize(onboarding.value));
      }
    }
    return data({ ok: true as const, error: undefined }, { headers });
  },
  { intents: ["exchange", "send_code", "accept"] },
);

export default function AcceptInvitation({ loaderData }: Route.ComponentProps) {
  const fetcher = useFetcher<typeof action>();
  const exchanged = useRef(false);
  useEffect(() => {
    if (exchanged.current) return;
    exchanged.current = true;
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const token = fragment.get("token");
    if (window.location.hash)
      window.history.replaceState(window.history.state, "", window.location.pathname);
    if (token)
      fetcher.submit({ intent: "exchange", token, csrf: loaderData.csrf }, { method: "post" });
  }, [fetcher, loaderData.csrf]);
  const busy = fetcher.state !== "idle";
  return (
    <main className="mx-auto max-w-lg px-6 py-16">
      <PageHeader
        title="Guest invitation"
        description="Accepting this invitation does not create an account or activate VPN access."
      />
      {fetcher.data?.ok === false && (
        <Callout className="mb-4" variant="error">
          {fetcher.data.error}
        </Callout>
      )}
      {loaderData.stage === "accepted" ? (
        <Callout title="Invitation accepted">
          The email address was verified and the administrative invitation was accepted.
          {loaderData.vpnEnabled
            ? " Network access has its own onboarding and provisioning workflow. Open the portal for its current status."
            : " No VPN or network access has been activated."}
          {loaderData.vpnEnabled && (
            <p className="mt-3">
              <Link to="/guest-access">Continue to device onboarding</Link>
            </p>
          )}
        </Callout>
      ) : loaderData.stage === "verify" ? (
        <>
          <p className="text-muted mb-4 text-sm">
            Verify access to the email address recorded by the administrator. The invitation expires{" "}
            {loaderData.expires?.toISOString().replace("T", " ").slice(0, 19)} UTC.
          </p>
          <fetcher.Form method="post" className="mb-6">
            <input type="hidden" name="intent" value="send_code" />
            <input type="hidden" name="csrf" value={loaderData.csrf} />
            <Button type="submit" pending={busy}>
              {loaderData.codeSent ? "Send a new verification code" : "Send verification code"}
            </Button>
          </fetcher.Form>
          {loaderData.codeSent && (
            <fetcher.Form method="post" className="flex flex-col gap-4">
              <input type="hidden" name="intent" value="accept" />
              <input type="hidden" name="csrf" value={loaderData.csrf} />
              <Input
                label="Verification code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{8}"
                maxLength={8}
                required
                description="Enter the eight-digit code sent separately to the invited email address. It expires after ten minutes."
              />
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="consent" value="yes" required className="mt-1" />I
                accept this administrative invitation and understand that no VPN access is being
                granted.
              </label>
              <Button type="submit" variant="primary" pending={busy}>
                Accept invitation
              </Button>
            </fetcher.Form>
          )}
        </>
      ) : (
        <Callout>
          {busy
            ? "Checking invitation…"
            : "Open the full invitation link from the email. Invalid, expired, revoked, or previously used links cannot be accepted."}
        </Callout>
      )}
    </main>
  );
}

export function ErrorBoundary() {
  return (
    <main className="mx-auto max-w-lg px-6 py-16">
      <PageHeader title="Invitation unavailable" />
      <Callout variant="error">
        This invitation could not be loaded. Contact the administrator or try again later.
      </Callout>
    </main>
  );
}
