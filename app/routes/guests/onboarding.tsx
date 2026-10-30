import { data, useFetcher, type HeadersFunction } from "react-router";

import Button from "~/components/button";
import Callout from "~/components/callout";
import Input from "~/components/input";
import PageHeader from "~/components/page-header";
import { appConfigContext, guestVpnContext, invitationsContext } from "~/server/context";
import { equalHash, invitationCsrf, tokenHash } from "~/server/invitation-tokens";
import { readPublicForm } from "~/server/web/public-form";

import type { Route } from "./+types/onboarding";
import { publicInvitationHeaders } from "./accept";
import { readVpnSession } from "./vpn-session.server";

export const headers: HeadersFunction = () => publicInvitationHeaders;
export async function loader({ request, context }: Route.LoaderArgs) {
  const config = context.get(appConfigContext);
  const session = await readVpnSession(request, config);
  const result = await context.get(guestVpnContext).portal(session);
  if (!result.ok)
    throw data("Guest onboarding is unavailable. Contact the administrator.", {
      status: 401,
      headers: publicInvitationHeaders,
    });
  return data(
    { ...result.value, csrf: invitationCsrf(config.server.cookie_secret, session) },
    { headers: publicInvitationHeaders },
  );
}
export const action = Object.assign(
  async ({ request, context }: Route.ActionArgs) => {
    const config = context.get(appConfigContext);
    const session = await readVpnSession(request, config);
    const internal = new URL(request.url);
    const expected = config.server.base_url ? new URL(config.server.base_url) : internal;
    const origin = request.headers.get("origin");
    const reject = (message: string, status = 400) =>
      data({ ok: false as const, error: message }, { status, headers: publicInvitationHeaders });
    if (
      !session ||
      !origin ||
      (origin !== expected.origin &&
        !(expected.host === internal.host && origin === internal.origin))
    )
      return reject("This request could not be verified.", 403);
    const bounded = await readPublicForm(request, 2048);
    if (!bounded.ok) return reject(bounded.error.message, bounded.error.status);
    const form = bounded.value;
    const csrf = form.get("csrf"),
      authId = form.get("auth_id");
    if (
      typeof csrf !== "string" ||
      csrf.length > 64 ||
      !equalHash(csrf, invitationCsrf(config.server.cookie_secret, session))
    )
      return reject("This request could not be verified.", 403);
    if (form.get("intent") !== "register" || typeof authId !== "string" || authId.length > 160)
      return reject("Invalid registration request.");
    const limited = context
      .get(invitationsContext)
      .checkRate(`vpn-onboarding:${tokenHash(session)}`, 5);
    if (!limited.ok) return reject(limited.error.message, 429);
    const result = await context.get(guestVpnContext).register(session, authId);
    if (!result.ok) return reject(result.error.message, result.error.code === "busy" ? 409 : 400);
    return data({ ok: true as const, error: undefined }, { headers: publicInvitationHeaders });
  },
  { intents: ["register"] },
);

export default function Onboarding({ loaderData: info }: Route.ComponentProps) {
  const fetcher = useFetcher<typeof action>();
  const active = info.state === "active" && info.verified;
  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <PageHeader
        title="Guest device onboarding"
        description="Use a personal device. The administrator must prepare a dedicated identity before registration."
      />
      <Callout
        className="mb-6"
        title={
          active
            ? "VPN access active"
            : info.state === "active" || info.state === "error"
              ? "VPN access verification unavailable"
              : ["revoked", "expired"].includes(info.state)
                ? `VPN access ${info.state}`
                : "VPN access not provisioned"
        }
      >
        Invitation accepted · Access status: {info.state.replaceAll("_", " ")}
        <p>
          Planned access: {info.duration}. Relative durations begin only after confirmed activation.
        </p>
        {!info.expires && info.plannedExpires && (
          <p>Planned absolute deadline: {new Date(info.plannedExpires).toLocaleString()}.</p>
        )}
        {info.expires && <p>Access expires at {new Date(info.expires).toLocaleString()}.</p>}
      </Callout>
      {fetcher.data?.error && (
        <Callout variant="error" className="mb-4">
          {fetcher.data.error}
        </Callout>
      )}
      <ol className="mb-6 list-inside list-decimal space-y-4 text-sm">
        <li>
          Install the official Tailscale client for Windows, macOS or Linux through the operating
          system’s trusted installation channel.
        </li>
        <li>
          Choose “Use a custom coordination server” where the client provides it. On Windows, open
          PowerShell; on macOS or Linux, open Terminal. Connect using:
          <pre className="bg-surface-raised mt-2 overflow-x-auto rounded p-3">
            <code>tailscale up --login-server {info.loginServer}</code>
          </pre>
          <p className="text-muted mt-2">
            Windows: use an administrator PowerShell if required. macOS: allow the VPN extension.
            Linux: use sudo if required. Register only a device that belongs to this guest; never
            submit someone else’s Auth ID.
          </p>
        </li>
        <li>
          Open the registration page shown by Tailscale. Copy its Auth ID into the form below.
          Possession of an Auth ID is a device-registration authorization; keep it private.
        </li>
      </ol>
      {info.usesSubnetRoutes && (
        <Callout className="mb-4">
          The selected services include a subnet route. Enable “Use subnet routes” in the Tailscale
          client settings, or run <code>tailscale set --accept-routes=true</code>. This does not
          grant any additional permissions.
        </Callout>
      )}
      {!active && info.phase === "awaiting_device" && (
        <fetcher.Form method="post" className="space-y-4">
          <input type="hidden" name="intent" value="register" />
          <input type="hidden" name="csrf" value={info.csrf} />
          <Input
            label="Auth ID"
            name="auth_id"
            type="password"
            required
            autoComplete="off"
            maxLength={160}
            description="Single use. No API key or pre-auth key is required."
          />
          <Button type="submit" variant="primary" pending={fetcher.state !== "idle"}>
            Register my device
          </Button>
        </fetcher.Form>
      )}
      {!active && info.phase !== "awaiting_device" && (
        <p className="text-muted">
          Contact the administrator to prepare or review this access. Refresh after the
          administrator confirms readiness.
        </p>
      )}
      {info.nodes.map((n) => (
        <p key={n.id} className="mt-4 text-sm">
          Device: {n.name} · {n.online ? "Online" : "Offline"} · {n.addresses.join(", ")}
        </p>
      ))}
    </main>
  );
}

// Keep errors inside this public route so its no-store/CSP headers survive
// React Router error bubbling and no administrative exception detail is shown.
export function ErrorBoundary() {
  return (
    <main className="mx-auto max-w-lg px-6 py-16">
      <PageHeader title="Guest onboarding unavailable" />
      <Callout variant="error">
        This onboarding session is unavailable or expired. Contact the administrator.
      </Callout>
    </main>
  );
}
