import ActionDialog from "~/components/action-dialog";
import Attribute from "~/components/attribute";
import Button from "~/components/button";
import Callout from "~/components/callout";
import Section, { SettingList } from "~/components/section";
import type { Guest } from "~/server/db/schema";
import type { GuestVpnService } from "~/server/guest-vpn";
import { accessDurationLabel } from "~/utils/guest-access";

import { guestDate } from "./format";

export type VpnDetailsData = Extract<
  Awaited<ReturnType<GuestVpnService["get"]>>,
  { ok: true }
>["value"];
export default function VpnDetails({
  vpn,
  guest,
  accepted,
  resourceCount,
}: {
  vpn: VpnDetailsData;
  guest: Guest;
  accepted: boolean;
  resourceCount: number;
}) {
  const a = vpn.access;
  const revokeLabel =
    a?.state === "active"
      ? "Revoke Access Now"
      : a?.desired_state === "active"
        ? "Cancel prepared access"
        : "Retry Revocation";
  return (
    <>
      <Section
        title="Identity"
        description="A dedicated Headscale identity is created only after invitation acceptance and provisioning checks."
      >
        <SettingList>
          <Attribute
            name="Headscale user"
            value={a?.headscale_user_id ? `${a.user_name} · ${a.headscale_user_id}` : "Not linked"}
          />
          <Attribute
            name="Linked devices"
            value={String(vpn.nodes.filter((n) => n.tracked).length)}
          />
          <Attribute name="Last verified" value={guestDate(a?.last_sync_at ?? null)} />
        </SettingList>
      </Section>
      <Section
        title="Access"
        description="Invitation validity, network duration and retained guest records have independent lifecycles."
      >
        {!vpn.enabled && <Callout className="mb-4">{vpn.reason}</Callout>}
        {vpn.enabled &&
          vpn.previewError &&
          !["active", "revoked", "expired"].includes(a?.state ?? "") &&
          accepted && (
            <Callout className="mb-4" variant="error">
              {vpn.previewError}
            </Callout>
          )}
        {a?.error_code && (
          <Callout variant="error" className="mb-4">
            Guest isolation cannot be guaranteed. Operation requires review: {a.error_code}. No
            successful activation or revocation is assumed.
          </Callout>
        )}
        <SettingList>
          <Attribute
            name="Access status"
            value={a ? a.state.replaceAll("_", " ") : "VPN access not provisioned"}
          />
          <Attribute name="Access duration" value={accessDurationLabel(guest)} />
          <Attribute name="Activated at" value={guestDate(a?.activated_at ?? null)} />
          {(a?.expires_at || guest.requested_expires_at) && (
            <Attribute
              name="Access expires at"
              value={guestDate(a?.expires_at ?? guest.requested_expires_at)}
            />
          )}
          <Attribute name="Revoked at" value={guestDate(a?.revoked_at ?? null)} />
          <Attribute name="Allowed resources" value={`${resourceCount} planned resource(s)`} />
          <Attribute name="Effective permission status" value={vpn.effectiveStatus} />
        </SettingList>
        <div className="mt-4 flex flex-wrap gap-3">
          {(!a ||
            (a.desired_state === "active" && ["error", "provisioning"].includes(a.state))) && (
            <ActionDialog
              title="Provision guest access?"
              intent="provision_access"
              fields={{ revision: String(guest.revision), preview_hash: vpn.previewHash ?? "" }}
              submitLabel={a ? "Retry Provisioning" : "Provision Access"}
              description="Validate isolation and create a dedicated identity. Network permissions are granted only after verified device onboarding. Headplane must be the only policy writer."
              trigger={
                <Button
                  variant="primary"
                  disabled={!vpn.enabled || !accepted || !resourceCount || !vpn.previewHash}
                >
                  {a ? "Retry Provisioning" : "Provision Access"}
                </Button>
              }
            />
          )}
          {a && !["revoked", "expired"].includes(a.state) && (
            <ActionDialog
              title="Revoke guest access now?"
              isDestructive
              intent="revoke_access"
              fields={{ revision: String(a.revision) }}
              submitLabel={revokeLabel}
              description="Remove the exact managed permissions and expire this guest’s device. Keep the guest record and audit history. Success requires Headscale confirmation."
              trigger={
                <Button variant="danger" disabled={!vpn.enabled}>
                  {revokeLabel}
                </Button>
              }
            />
          )}
        </div>
      </Section>
      <Section
        title="Devices"
        description="This phase supports one interactive device per guest. Expiring it forces reauthentication and revokes guest access; it does not delete the device."
      >
        {vpn.inventoryError && (
          <Callout variant="error">
            Cannot load current Headscale devices. No empty inventory is assumed.
          </Callout>
        )}
        {!vpn.inventoryError && !vpn.nodes.length && (
          <p className="text-muted text-sm">No registered guest device.</p>
        )}
        {vpn.nodes.map((n) => (
          <div className="border-line mb-3 rounded border p-4 text-sm" key={n.id}>
            <p className="font-medium">{n.name}</p>
            {!n.tracked && (
              <p className="text-muted">
                Untracked device — administrator review required. It has not been adopted.
              </p>
            )}
            <p>
              {n.addresses.join(", ")} · {n.online ? "Online" : "Offline"}
            </p>
            <p>Last seen: {guestDate(n.lastSeen ? new Date(n.lastSeen) : null)}</p>
            <p>Device expiry: {guestDate(n.expiry ? new Date(n.expiry) : null)}</p>
            {a?.state === "active" && n.tracked && (
              <ActionDialog
                title="Expire guest device?"
                isDestructive
                intent="expire_device"
                fields={{ revision: String(a.revision), node_id: n.id }}
                submitLabel="Expire device"
                description="Expire this device immediately and revoke guest permissions. The device record is retained."
                trigger={
                  <Button variant="danger" className="mt-3">
                    Expire device
                  </Button>
                }
              />
            )}
          </div>
        ))}
      </Section>
      {!!vpn.events.length && (
        <Section title="Network access history">
          <ol className="divide-line divide-y text-sm">
            {vpn.events.map((e) => (
              <li className="py-3" key={e.id}>
                <p>
                  {e.kind.replaceAll("_", " ")}
                  {e.code ? ` · ${e.code}` : ""}
                </p>
                <p className="text-muted">
                  {guestDate(e.created_at)} · {e.actor_id ?? "Guest or background reconciliation"}
                </p>
              </li>
            ))}
          </ol>
        </Section>
      )}
    </>
  );
}
