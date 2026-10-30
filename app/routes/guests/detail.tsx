import { data } from "react-router";

import ActionDialog from "~/components/action-dialog";
import Attribute from "~/components/attribute";
import Button from "~/components/button";
import Callout from "~/components/callout";
import Input from "~/components/input";
import Link from "~/components/link";
import PageError from "~/components/page-error";
import PageHeader from "~/components/page-header";
import Section, { SettingList } from "~/components/section";
import {
  authContext,
  guestsContext,
  invitationsContext,
  guestResourcesContext,
  guestVpnContext,
} from "~/server/context";
import { previewGuestAcl } from "~/server/guest-acl-preview";
import { Capabilities } from "~/server/web/roles";
import { toastClientAction } from "~/utils/toast";

import type { Route } from "./+types/detail";
import { editGuestAction, guestData, invitationData, parseGuestId } from "./actions";
import { guestDate } from "./format";
import GuestDialog from "./guest-dialog";
import ResourceDetails from "./resource-details";
import { loadResourceCatalog, loadPreviewPolicy } from "./resources.server";
import VpnDetails from "./vpn-details";

export async function loader({ request, context, params }: Route.LoaderArgs) {
  await context.get(authContext).requireCapability(request, Capabilities.manage_guests);
  const invitations = context.get(invitationsContext);
  const id = parseGuestId(params.id);
  const history = invitationData(invitations.get(id));
  const [catalog, policy] = await Promise.all([
    loadResourceCatalog(request, context),
    loadPreviewPolicy(request, context),
  ]);
  const resources = guestData(context.get(guestResourcesContext).list(id));
  const vpn = await context.get(guestVpnContext).get(id);
  if (!vpn.ok) throw data("Guest access data could not be loaded.", { status: 503 });
  return {
    vpn: vpn.value,
    catalog,
    resources,
    preview: previewGuestAcl({
      resources,
      nodes: catalog.nodes,
      catalogError: catalog.error,
      ...policy,
    }),
    guest: guestData(context.get(guestsContext).get(id)),
    ...history,
    invitationEnabled: invitations.enabled,
    maxValidityHours: invitations.maxValidityHours,
  };
}

export const action = editGuestAction;
export const clientAction = toastClientAction;

export default function Page({
  loaderData: {
    guest,
    invitation,
    events,
    invitationEnabled,
    maxValidityHours,
    catalog,
    resources,
    preview,
    vpn,
  },
}: Route.ComponentProps) {
  const state = invitation?.status ?? guest.status;
  const sendable = guest.status === "draft" && !["accepted", "revoked"].includes(state);
  return (
    <>
      <Link className="focus-ring text-accent mb-4 inline-block rounded-sm text-sm" to="/guests">
        ← Guests
      </Link>
      <PageHeader
        title={<span className="break-words">{guest.display_name ?? guest.email}</span>}
        description={<span className="break-all">{guest.email}</span>}
        actions={
          guest.status === "draft" &&
          state !== "accepted" && (
            <>
              {!invitation && <GuestDialog key={guest.revision} guest={guest} catalog={catalog} />}
              {sendable && (
                <ActionDialog
                  title={invitation ? "Resend invitation?" : "Send invitation?"}
                  intent="send_invitation"
                  submitLabel={invitation ? "Resend invitation" : "Send invitation"}
                  fields={{ revision: String(guest.revision) }}
                  description="Send a secure link to the guest email address. A separate verification code is required for acceptance. Sending again immediately invalidates the previous link, even if the new delivery fails. No VPN access is activated."
                  trigger={
                    <Button
                      disabled={!invitationEnabled || invitation?.delivery_state === "sending"}
                      variant="primary"
                    >
                      {invitation ? "Resend" : "Send Invitation"}
                    </Button>
                  }
                >
                  <Input
                    label="Invitation validity (hours)"
                    name="validity_hours"
                    type="number"
                    min={1}
                    max={maxValidityHours}
                    step={1}
                    required
                    defaultValue={String(Math.min(24, maxValidityHours))}
                    description={`Between 1 and ${maxValidityHours} hours. This is the validity of the invitation link, separate from the requested network duration.`}
                  />
                </ActionDialog>
              )}
              <ActionDialog
                title={invitation ? "Revoke invitation?" : "Revoke guest draft?"}
                intent="revoke"
                submitLabel={invitation ? "Revoke invitation" : "Revoke draft"}
                isDestructive
                fields={{ revision: String(guest.revision) }}
                description="This permanently closes the draft. It does not revoke any Headscale user, device, or network access."
                trigger={
                  <Button variant="danger">
                    {invitation ? "Revoke invitation" : "Revoke draft"}
                  </Button>
                }
              />
            </>
          )
        }
      />
      {!invitationEnabled && guest.status === "draft" && (
        <Callout className="mb-4">
          Invitation delivery is disabled. Configure guest_invitations and server.base_url to send
          invitations.
        </Callout>
      )}
      <Callout className="mb-6">
        {state === "accepted"
          ? "Invitation accepted after email verification. Check Access below for the independent network status."
          : state === "pending"
            ? "Invitation pending. The recipient must verify their email and explicitly accept. No VPN access is active."
            : state === "expired"
              ? "The unused invitation expired. No network access was activated or revoked."
              : guest.status === "revoked"
                ? "This draft was administratively revoked and can no longer be edited."
                : "This is a draft. No invitation has been sent and no VPN access has been provisioned."}
      </Callout>
      <Section
        title="Guest details"
        description="Administrative information stored only in Headplane."
      >
        <SettingList>
          <Attribute name="Invitation status" value={state[0].toUpperCase() + state.slice(1)} />
          <Attribute name="Display name" value={guest.display_name ?? "—"} />
          <Attribute name="Email" value={guest.email} />
          <Attribute name="Created at" value={guestDate(guest.created_at)} />
          <Attribute name="Modified" value={guestDate(guest.updated_at)} />
          <Attribute
            name="Created by"
            value={guest.created_by ?? "API key session (no local account)"}
          />
          {guest.revoked_at && <Attribute name="Revoked at" value={guestDate(guest.revoked_at)} />}
        </SettingList>
      </Section>
      {invitation && (
        <Section
          title="Invitation"
          description="Email delivery and administrative acceptance are separate from VPN provisioning."
        >
          <SettingList>
            <Attribute name="Issued" value={guestDate(invitation.issued_at)} />
            <Attribute name="Invitation expires at" value={guestDate(invitation.expires_at)} />
            <Attribute name="Last sent" value={guestDate(invitation.last_sent_at)} />
            <Attribute name="Successful sends" value={String(invitation.send_count)} />
            <Attribute name="Delivery" value={invitation.delivery_state} />
            <Attribute name="Accepted at" value={guestDate(invitation.accepted_at)} />
            <Attribute name="Revoked at" value={guestDate(invitation.revoked_at)} />
          </SettingList>
          {invitation.delivery_state === "failed" && (
            <Callout className="mt-4" variant="error">
              Email delivery failed or was interrupted. The link is invalid. Check the mail
              configuration and resend after one minute.
            </Callout>
          )}
        </Section>
      )}
      <p className="text-muted mb-6 text-sm">
        Guest records are retained for audit after invitation expiry or revocation. Invitation
        expiry does not delete the record or revoke VPN access; network expiry and revocation are
        managed separately in Access.
      </p>
      {events.length > 0 && (
        <Section
          title="Invitation history"
          description="The latest 100 events. Tokens and email credentials are never recorded here."
        >
          <ol className="divide-line divide-y text-sm">
            {events.map((event) => (
              <li key={event.id} className="py-3">
                <p className="font-medium">{event.kind.replaceAll("_", " ")}</p>
                <p className="text-muted">
                  {guestDate(event.created_at)} ·{" "}
                  {event.actor_id ??
                    (event.kind === "accepted" ? "Verified recipient" : "System or API session")}
                </p>
              </li>
            ))}
          </ol>
        </Section>
      )}
      <Section title="Administrative notes">
        <p className="text-sm break-words whitespace-pre-wrap">{guest.notes ?? "No notes."}</p>
      </Section>
      {guest.requested_expires_at && guest.requested_duration_seconds && (
        <Callout className="mb-4">
          This legacy record includes both a duration and a deadline. The absolute deadline takes
          precedence. Edit the draft to choose one intention; historical data is retained until
          then.
        </Callout>
      )}
      <ResourceDetails
        guest={guest}
        resources={resources}
        catalog={catalog}
        preview={preview}
        networkLocked={Boolean(
          vpn.access && !["revoked", "expired", "not_provisioned"].includes(vpn.access.state),
        )}
        managed={vpn.access?.permission}
        effectiveStatus={vpn.effectiveStatus}
      />
      <VpnDetails
        vpn={vpn}
        guest={guest}
        accepted={state === "accepted"}
        resourceCount={resources.length}
      />
    </>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <PageError error={error} page="guest details" />;
}
