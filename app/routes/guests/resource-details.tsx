import { useRevalidator } from "react-router";

import ActionDialog from "~/components/action-dialog";
import Button from "~/components/button";
import Callout from "~/components/callout";
import Section from "~/components/section";
import type { Guest, GuestResource } from "~/server/db/schema";
import type { previewGuestAcl } from "~/server/guest-acl-preview";
import type { ResourceCatalog } from "~/utils/guest-resources";

import ResourceEditor from "./resource-editor";

export default function ResourceDetails({
  guest,
  resources,
  catalog,
  preview,
}: {
  guest: Guest;
  resources: GuestResource[];
  catalog: ResourceCatalog;
  preview: ReturnType<typeof previewGuestAcl>;
}) {
  const revalidator = useRevalidator();
  return (
    <>
      <Section
        title="Allowed resources"
        description="Requested permissions stored in Headplane. No ACLs or VPN access are provisioned."
      >
        <Button
          type="button"
          pending={revalidator.state !== "idle"}
          onClick={() => revalidator.revalidate()}
        >
          Refresh inventory and preview
        </Button>
        <p className="text-muted my-2 text-xs" role="status">
          {revalidator.state !== "idle"
            ? "Refreshing Headscale inventory and policy…"
            : "Snapshot loaded; every save rechecks current machine references."}
        </p>
        <ul className="mb-4 flex flex-col gap-2 text-sm">
          {!resources.length && <li className="text-muted">No resources requested.</li>}
          {resources.map((r) => (
            <li key={r.id} className="break-words">
              {r.kind === "lan" ? "LAN service" : "Headscale machine"} ·{" "}
              {catalog.nodes.find((n) => n.id === r.node_id)?.name ??
                `Missing machine #${r.node_id}`}{" "}
              · {r.address} · {r.protocol.toUpperCase()} {r.ports}
              {r.route ? ` · route ${r.route}` : ""}
            </li>
          ))}
        </ul>
        {catalog.error && <Callout variant="error">{catalog.error}</Callout>}
        {guest.status === "draft" && (
          <ActionDialog
            key={guest.revision}
            title="Edit allowed resources"
            intent="save_resources"
            submitLabel="Save resource intentions"
            fields={{ revision: String(guest.revision) }}
            description="Saving updates only the desired plan in SQLite. Invitations and VPN permissions are separate."
            isDisabled={Boolean(catalog.error)}
            trigger={<Button>Edit allowed resources</Button>}
          >
            <ResourceEditor catalog={catalog} initial={resources} />
          </ActionDialog>
        )}
      </Section>
      <Section
        title="ACL Preview"
        description="Read-only static analysis of the current Headscale policy. No Apply ACL action is available."
      >
        <Callout variant={preview.conflicts.length ? "error" : undefined}>{preview.status}</Callout>
        <p className="text-muted my-3 text-xs break-all">
          Checked {preview.checkedAt} · Policy SHA256: {preview.policyHash ?? "Unavailable"}
        </p>
        <h3 className="my-2 font-medium">Conflicts and security warnings</h3>
        <ul className="list-disc space-y-2 pl-5 text-sm">
          {[...preview.conflicts, ...preview.issues].map((issue, i) => (
            <li key={i}>
              {issue.rule ? `${issue.rule}: ` : ""}
              {issue.message}
            </li>
          ))}
        </ul>
        {preview.truncated && (
          <Callout>Analysis output was truncated. Cannot verify guest isolation.</Callout>
        )}
        <h3 className="mt-5 mb-2 font-medium">Proposed rules (non-applicable templates)</h3>
        <p className="text-muted mb-2 text-sm">
          The source placeholder is intentionally unbound and invalid for provisioning. Stale
          resources are excluded. A narrower allow rule cannot cancel existing allow rules.
        </p>
        <pre className="bg-surface-raised border-line max-h-72 overflow-auto rounded-md border p-3 text-xs">
          {JSON.stringify({ acls: preview.proposed }, null, 2)}
        </pre>
        <h3 className="mt-5 mb-2 font-medium">Existing permissions — potentially effective</h3>
        <p className="text-muted mb-2 text-sm">
          These rules are current policy expressions, not verified access for this guest. Source
          membership, tag expansion, routing and policy extensions remain unresolved.
        </p>
        <pre className="bg-surface-raised border-line max-h-72 overflow-auto rounded-md border p-3 text-xs">
          {JSON.stringify(preview.existing, null, 2)}
        </pre>
      </Section>
    </>
  );
}
