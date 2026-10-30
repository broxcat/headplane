/** Resource intentions only; never a statement of effective VPN access. */
export interface ResourceNode {
  id: string;
  name: string;
  addresses: string[];
  owner: string | null;
  tags: string[];
  online: boolean;
  announced: string[];
  approved: string[];
}

export interface ResourceInput {
  kind: "node" | "lan";
  node_id: string;
  address: string;
  route: string | null;
  protocol: "tcp" | "udp";
  ports: string;
}

export interface ResourceCatalog {
  nodes: ResourceNode[];
  error: string | null;
}

/** Reject overlaps as well as repeated ports: duplicates usually hide an input mistake. */
export function parseResourcePorts(input: string): number[][] {
  if (!input || input.length > 512) throw new Error("Specify ports, for example 22,443,8000-8010.");
  const ranges = input
    .split(",")
    .map((part) => {
      if (!/^\d{1,5}(-\d{1,5})?$/.test(part.trim()))
        throw new Error("Use explicit ports or ranges, without wildcards.");
      const [start, end = start] = part.trim().split("-").map(Number);
      if (start < 1 || end > 65535 || end < start || end - start >= 100)
        throw new Error("Use ports 1–65535 and ranges of at most 100 ports.");
      return [start, end];
    })
    .sort((a, b) => a[0] - b[0]);
  if (ranges.length > 32 || ranges.reduce((n, [a, b]) => n + b - a + 1, 0) > 256)
    throw new Error("Use at most 32 ranges and 256 ports per resource.");
  if (ranges.some(([start], i) => i > 0 && start <= ranges[i - 1][1]))
    throw new Error("Remove duplicate or overlapping ports.");
  return ranges;
}

export function canonicalPorts(input: string) {
  return parseResourcePorts(input)
    .map(([a, b]) => (a === b ? String(a) : `${a}-${b}`))
    .join(",");
}
