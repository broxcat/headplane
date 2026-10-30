import { useId, useState } from "react";

import Button from "~/components/button";
import Callout from "~/components/callout";
import { controlClass } from "~/components/field";
import Input from "~/components/input";
import { canonicalPorts, type ResourceCatalog, type ResourceInput } from "~/utils/guest-resources";

export function resourceInput(r: ResourceInput): ResourceInput {
  const { kind, node_id, address, route, protocol, ports } = r;
  return { kind, node_id, address, route, protocol, ports };
}
export default function ResourceEditor({
  catalog,
  initial = [],
}: {
  catalog: ResourceCatalog;
  initial?: ResourceInput[];
}) {
  const id = useId();
  const [selected, setSelected] = useState<ResourceInput[]>(initial.map(resourceInput));
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [lanAddress, setLanAddress] = useState("");
  const [lanRoute, setLanRoute] = useState("");
  const nodes = catalog.nodes.filter(
    (n) =>
      `${n.name} ${n.owner ?? ""} ${n.addresses.join(" ")} ${n.tags.join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (filter === "all" ||
        (filter === "online"
          ? n.online
          : filter === "offline"
            ? !n.online
            : n.approved.some((r) => n.announced.includes(r)))),
  );
  const routes = catalog.nodes.flatMap((n) =>
    n.approved
      .filter((r) => n.announced.includes(r) && !r.endsWith("/0"))
      .map((route) => ({ value: `${n.id}|${route}`, label: `${n.name} — ${route}` })),
  );
  function change(index: number, patch: Partial<ResourceInput>) {
    setSelected((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="mb-2 font-medium">Allowed resources</legend>
      <p className="text-muted text-xs">
        Intentions only. No network access is granted. Specify explicit ports; no ports are
        preselected.
      </p>
      <input type="hidden" name="resources" value={JSON.stringify(selected)} />
      {catalog.error && <Callout variant="error">{catalog.error}</Callout>}
      <Input label="Search machines" type="search" value={search} onChange={setSearch} />
      <label className="text-sm">
        Machine filter
        <select className={controlClass} value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All machines</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="routers">Subnet routers</option>
        </select>
      </label>
      <div
        className="border-line max-h-48 overflow-auto rounded-md border"
        aria-label="Available Headscale machines"
      >
        {!nodes.length && <p className="text-muted p-3 text-sm">No matching Headscale machines.</p>}
        {nodes.map((n) => (
          <label
            key={n.id}
            className="border-line flex items-start gap-2 border-b p-3 text-sm last:border-0"
          >
            <input
              type="checkbox"
              className="mt-1"
              checked={selected.some((r) => r.kind === "node" && r.node_id === n.id)}
              disabled={!n.addresses.length || Boolean(catalog.error)}
              onChange={(e) =>
                setSelected((rows) =>
                  e.target.checked
                    ? [
                        ...rows,
                        {
                          kind: "node",
                          node_id: n.id,
                          address: n.addresses[0],
                          route: null,
                          protocol: "tcp",
                          ports: "",
                        },
                      ]
                    : rows.filter((r) => r.kind !== "node" || r.node_id !== n.id),
                )
              }
            />
            <span className="min-w-0 break-words">
              <span className="font-medium">{n.name}</span>
              <span className="text-muted block text-xs">
                {n.addresses.join(", ")} · {n.owner ?? "Tagged node"} ·{" "}
                {n.online ? "Online" : "Offline"}
                {n.tags.length ? ` · ${n.tags.join(", ")}` : ""}
              </span>
            </span>
          </label>
        ))}
      </div>
      <details className="border-line rounded-md border p-3">
        <summary className="cursor-pointer text-sm font-medium">Declare a LAN service</summary>
        <p className="text-muted my-2 text-xs">
          A private IP behind an announced and approved route. No LAN scanning. Route approval does
          not prove reachability.
        </p>
        <div className="flex flex-col gap-2">
          <label htmlFor={`${id}-route`} className="text-sm">
            Subnet route
          </label>
          <select
            id={`${id}-route`}
            className={controlClass}
            value={lanRoute}
            onChange={(e) => setLanRoute(e.target.value)}
          >
            <option value="">Choose an approved and announced route</option>
            {routes.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <Input
            label="LAN IP address"
            value={lanAddress}
            onChange={setLanAddress}
            maxLength={64}
          />
          <Button
            type="button"
            disabled={!lanRoute || !lanAddress || Boolean(catalog.error) || selected.length >= 50}
            onClick={() => {
              const [node_id, route] = lanRoute.split("|");
              setSelected((rows) => [
                ...rows,
                { kind: "lan", node_id, route, address: lanAddress, protocol: "tcp", ports: "" },
              ]);
              setLanAddress("");
            }}
          >
            Add LAN service
          </Button>
        </div>
      </details>
      <p className="text-muted text-xs" role="status">
        {selected.length} requested resource(s)
      </p>
      {selected.map((r, i) => (
        <div key={i} className="border-line flex flex-col gap-2 rounded-md border p-3">
          <p className="text-sm font-medium break-all">
            {r.kind === "lan"
              ? "LAN service"
              : (catalog.nodes.find((n) => n.id === r.node_id)?.name ?? "Missing machine")}{" "}
            · {r.address}
          </p>
          {r.kind === "node" && (
            <label className="text-sm">
              Target IP
              <select
                className={controlClass}
                value={r.address}
                onChange={(e) => change(i, { address: e.target.value })}
              >
                {[
                  ...new Set([
                    r.address,
                    ...(catalog.nodes.find((n) => n.id === r.node_id)?.addresses ?? []),
                  ]),
                ].map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
          )}
          {r.route && (
            <p className="text-muted text-xs break-all">
              Router #{r.node_id} · {r.route}
            </p>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-sm">
              Protocol
              <select
                className={controlClass}
                value={r.protocol}
                onChange={(e) => change(i, { protocol: e.target.value as "tcp" | "udp" })}
              >
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
              </select>
            </label>
            <Input
              label={`Ports for resource ${i + 1}`}
              value={r.ports}
              onChange={(ports) => change(i, { ports })}
              required
              maxLength={512}
              placeholder="22,443,8000-8010"
              validate={(value) => {
                try {
                  canonicalPorts(String(value));
                  return null;
                } catch (e) {
                  return e instanceof Error ? e.message : "Invalid ports";
                }
              }}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={selected.length >= 50}
              onClick={() =>
                setSelected((rows) => [
                  ...rows,
                  { ...r, protocol: r.protocol === "tcp" ? "udp" : "tcp", ports: "" },
                ])
              }
            >
              Add other protocol
            </Button>
            <Button
              type="button"
              onClick={() => setSelected((rows) => rows.filter((_, j) => j !== i))}
            >
              Remove resource {i + 1}
            </Button>
          </div>
        </div>
      ))}
    </fieldset>
  );
}
