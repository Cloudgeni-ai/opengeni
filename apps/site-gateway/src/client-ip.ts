/**
 * The client-IP part of a rate-limit key. One IPv6 subscriber usually holds
 * a whole /64, so IPv6 addresses are limited per /64 prefix; IPv4 addresses
 * (including IPv4-mapped IPv6) are limited per address.
 */
export function rateLimitIp(ip: string): string {
  const address = ip.trim().toLowerCase().replace(/%.*$/u, "");
  if (!address) return "unknown";
  if (!address.includes(":")) return address;
  const groups = expandIpv6(address);
  if (!groups) return address;
  // ::ffff:a.b.c.d is an IPv4 client.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff)
    return `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

/** The eight 16-bit groups of an IPv6 address, or null when it is malformed. */
function expandIpv6(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    const pieces = part.split(":");
    for (const [index, piece] of pieces.entries()) {
      if (index === pieces.length - 1 && piece.includes(".")) {
        const octets = piece.split(".").map(Number);
        if (
          octets.length !== 4 ||
          octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
        )
          return null;
        out.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
      } else {
        if (!/^[0-9a-f]{1,4}$/u.test(piece)) return null;
        out.push(Number.parseInt(piece, 16));
      }
    }
    return out;
  };
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...Array<number>(missing).fill(0), ...tail];
}
