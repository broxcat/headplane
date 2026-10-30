import { DrizzleQueryError } from "drizzle-orm";
import { Form, redirect, useNavigation } from "react-router";
import * as v from "valibot";

import Attribute from "~/components/attribute";
import Button from "~/components/button";
import Callout from "~/components/callout";
import Input from "~/components/input";
import Section, { SettingList } from "~/components/section";
import { authContext, localAuthContext } from "~/server/context";
import { ActionError, createAction } from "~/server/web/actions";
import { requireSameOrigin } from "~/server/web/csrf";
import { Capabilities } from "~/server/web/roles";

import type { Route } from "./+types/account";

export async function loader({ request, context }: Route.LoaderArgs) {
  const principal = await context
    .get(authContext)
    .requireCapability(request, Capabilities.ui_access);
  // An explicit public profile, never a credential record or complete principal.
  return {
    method: principal.kind,
    username: principal.kind === "local_admin" ? principal.profile.username : undefined,
    displayName: principal.kind === "api_key" ? principal.displayName : principal.profile.name,
  };
}

export const action = createAction({
  capability: Capabilities.configure_iam,
  async setup({ request, context }) {
    requireSameOrigin(request);
    const auth = context.get(authContext);
    return {
      request,
      auth,
      principal: await auth.requireCapability(request, Capabilities.ui_access),
      local: context.get(localAuthContext),
    };
  },
  intents: {
    change_password: {
      fields: {
        current_password: v.string(),
        new_password: v.string(),
        confirm_password: v.string(),
      },
      async handler(input, { principal, auth, local, request }) {
        if (principal.kind !== "local_admin" || !principal.profile.username)
          throw new ActionError("Password changes are available for local accounts only.");
        if (input.new_password !== input.confirm_password)
          throw new ActionError("The new passwords do not match.");
        const changed = await local
          .replacePassword(
            principal.profile.username,
            input.new_password,
            { password: input.current_password, userId: principal.user.id },
            auth.clientAddress(request),
          )
          .catch((error: unknown) => {
            if (error instanceof DrizzleQueryError)
              throw new ActionError("Account storage is temporarily unavailable.", 503);
            throw error;
          });
        if (!changed.ok) throw new ActionError(changed.error);
        // Revoke every session, including this one, and clear the browser cookie.
        return redirect("/login", {
          headers: { "Set-Cookie": await auth.destroySession(request) },
        });
      },
    },
  },
});

export default function Account({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  return (
    <Section title="Account" description="Profile and authentication for the current account.">
      <SettingList>
        {loaderData.username && <Attribute name="Username" value={loaderData.username} />}
        <Attribute name="Display name" value={loaderData.displayName} />
        <Attribute
          name="Authentication method"
          value={
            loaderData.method === "local_admin"
              ? "Local administrator"
              : loaderData.method === "oidc"
                ? "Single sign-on"
                : loaderData.method === "proxy"
                  ? "Trusted proxy"
                  : "Headscale API key"
          }
        />
      </SettingList>
      {loaderData.method === "local_admin" && (
        <Form method="POST" className="mt-6 flex max-w-md flex-col gap-4">
          <h3 className="font-medium">Change password</h3>
          <p className="text-muted text-sm">
            Use 12–256 characters. Changing the password signs out every session, including this
            one.
          </p>
          {actionData?.ok === false && (
            <Callout variant="error">{Object.values(actionData.errors).join(" ")}</Callout>
          )}
          <input type="hidden" name="intent" value="change_password" />
          <input
            type="hidden"
            name="username"
            autoComplete="username"
            value={loaderData.username}
          />
          <Input
            label="Current password"
            name="current_password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={512}
          />
          <Input
            label="New password"
            name="new_password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={512}
          />
          <Input
            label="Confirm new password"
            name="confirm_password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={512}
          />
          <Button type="submit" variant="primary" pending={navigation.state === "submitting"}>
            Change password
          </Button>
        </Form>
      )}
    </Section>
  );
}
