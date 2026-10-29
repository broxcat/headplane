import ActionDialog from "~/components/action-dialog";
import Attribute from "~/components/attribute";
import Button from "~/components/button";
import Callout from "~/components/callout";
import PageError from "~/components/page-error";
import Section, { SettingList } from "~/components/section";
import { appConfigContext, authContext, guestMailerContext } from "~/server/context";
import { ActionError, createAction } from "~/server/web/actions";
import { Capabilities } from "~/server/web/roles";
import { ok } from "~/utils/form";
import { toastClientAction } from "~/utils/toast";

import type { Route } from "./+types/guest-email";

export async function loader({ request, context }: Route.LoaderArgs) {
  await context.get(authContext).requireCapability(request, Capabilities.manage_guests);
  const config = context.get(appConfigContext);
  const options = config.guest_invitations;
  // Explicit allowlist: never serialize the SMTP object, credentials or secret paths.
  return {
    enabled: options?.enabled ?? false,
    transport: options?.transport ?? "smtp",
    from: options ? `${options.from_name} <${options.from_address}>` : "Not configured",
    publicUrl: config.server.base_url ?? "Not configured",
    host: options?.smtp?.host ?? "Not configured",
    port: options?.smtp?.port ?? 587,
    security: options?.smtp?.security ?? "starttls",
    authentication: options?.smtp?.username ? "Configured" : "None",
    timeout: options?.timeout_ms ?? 10000,
    retries: options?.retries ?? 1,
  };
}
export const action = createAction({
  capability: Capabilities.manage_guests,
  async setup({ request, context }) {
    return {
      principal: await context.get(authContext).require(request),
      mailer: context.get(guestMailerContext),
    };
  },
  intents: {
    check_connection: {
      fields: {},
      async handler(_input, { mailer }) {
        const checked = await mailer.check();
        if (!checked.ok)
          throw new ActionError(
            checked.error === "disabled"
              ? "Invitation delivery is disabled. Configure guest_invitations first."
              : checked.error === "rate_limited"
                ? "Wait one minute before checking again."
                : "Connection failed. Check SMTP TLS, authentication and timeout settings on the server.",
            checked.error === "rate_limited" ? 429 : 503,
          );
        return ok(
          checked.value === "file"
            ? "Local file transport is writable. No email was sent."
            : "SMTP connection, TLS and authentication succeeded. No email was sent.",
        );
      },
    },
  },
});
export const clientAction = toastClientAction;
export default function Page({ loaderData: settings }: Route.ComponentProps) {
  return (
    <Section
      title="Guest email"
      description="Configure delivery on the server. Passwords are never shown or edited in this interface."
    >
      <Callout className="mb-5">
        {!settings.enabled
          ? "Invitation delivery is disabled."
          : settings.transport === "file"
            ? "Development file transport: messages stay on this server. No external email is sent."
            : "SMTP is configured. Sending an invitation delivers real email; check the connection before enabling delivery for recipients."}
      </Callout>
      <SettingList>
        <Attribute name="Transport" value={settings.transport} />
        <Attribute name="Sender" value={settings.from} />
        <Attribute name="Public Headplane URL" value={settings.publicUrl} />
        {settings.transport === "smtp" && (
          <>
            <Attribute name="SMTP host" value={settings.host} />
            <Attribute name="Port" value={String(settings.port)} />
            <Attribute
              name="Security"
              value={settings.security === "tls" ? "Implicit TLS" : "STARTTLS (required)"}
            />
            <Attribute name="Authentication" value={settings.authentication} />
            <Attribute name="Timeout" value={`${settings.timeout} ms`} />
            <Attribute name="Retries" value={String(settings.retries)} />
          </>
        )}
      </SettingList>
      <div className="mt-5">
        <ActionDialog
          title="Check email connection?"
          intent="check_connection"
          submitLabel="Check connection"
          description="Check the configured transport without sending a message. SMTP checks connect, negotiate TLS and authenticate; file checks verify directory access. A successful check does not guarantee that the provider will accept a sender or recipient."
          trigger={<Button disabled={!settings.enabled}>Check connection</Button>}
        />
      </div>
      <p className="text-muted mt-4 text-sm">
        Set guest_invitations, SMTP secret files and server.base_url in the server configuration.
        Delivery remains opt-in. This page never changes configuration or grants VPN access.
      </p>
    </Section>
  );
}
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <PageError error={error} page="guest email settings" />;
}
