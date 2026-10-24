/**
 * Network identity: the key of a request's rate-limit bucket (DESIGN §8, SECURITY_REVIEW).
 *
 * - Without trusted proxies (development, loopback, the dev Compose port) it is the
 *   socket peer address. Proxy headers are ignored.
 * - With trusted proxies (`TRUSTED_PROXY_CIDRS`, tunnel mode) only socket peers inside
 *   those networks are served at all: any other peer is refused (403), so a request
 *   cannot bypass the tunnel. `CF-Connecting-IP` is read only from them and must be
 *   exactly one valid IP address; a missing or invalid value is refused (400) on the
 *   dynamic routes. Neither refusal ever falls back to a shared bucket such as the
 *   connector's own address.
 * - IPv4-mapped IPv6 addresses (`::ffff:192.0.2.1`) are unwrapped to IPv4, and IPv6
 *   addresses are reduced to their /64 network, the unit a single subscriber holds.
 *
 * Fastify's `request.ip` is never used: it may come from proxy headers.
 */
import { BlockList, isIP } from 'node:net';

export type IdentityRefusal = 'untrusted_peer' | 'missing_client_ip' | 'invalid_client_ip' | 'no_peer';

export type IdentityResult =
  | { ok: true; identity: string; via: 'socket' | 'cf-connecting-ip'; peer: string }
  | { ok: false; status: 403 | 400; reason: IdentityRefusal; peer: string | null };

/** Compiled `TRUSTED_PROXY_CIDRS`; null means no proxy is trusted (development mode). */
export interface TrustedProxies {
  readonly cidrs: readonly string[];
  contains(address: string): boolean;
}

export const CLIENT_IP_HEADER = 'cf-connecting-ip';

const MAX_ADDRESS_LENGTH = 64;

/** Parse an IPv6 address into eight 16-bit groups (an embedded IPv4 tail allowed); null if invalid. */
function ipv6Groups(address: string): number[] | null {
  if (isIP(address) !== 6) return null;
  let text = address.toLowerCase();
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return null;
    const [a, b, c, d] = tail.split('.').map(Number) as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const parse = (part: string): number[] => (part === '' ? [] : part.split(':').map((g) => parseInt(g, 16)));
  let groups: number[];
  const double = text.indexOf('::');
  if (double >= 0) {
    const head = parse(text.slice(0, double));
    const rest = parse(text.slice(double + 2));
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    groups = parse(text);
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

const isMapped = (g: readonly number[]): boolean => g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
const mappedV4 = (g: readonly number[]): string => {
  const hi = g[6] as number;
  const lo = g[7] as number;
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
};
const stripZone = (raw: string): string => raw.trim().replace(/%[0-9A-Za-z_.-]+$/, '');

/**
 * A canonical client address: IPv4 dotted quad (IPv4-mapped IPv6 unwrapped), or the
 * IPv6 /64 network as `xxxx:xxxx:xxxx:xxxx::/64`. Null when `raw` is not one IP
 * address. A zone index (`fe80::1%eth0`) is dropped.
 */
export function normalizeAddress(raw: string): string | null {
  const address = stripZone(raw);
  if (address.length === 0 || address.length > MAX_ADDRESS_LENGTH) return null;
  const family = isIP(address);
  if (family === 4) return address.split('.').map((o) => String(Number(o))).join('.');
  if (family !== 6) return null;
  const g = ipv6Groups(address);
  if (!g) return null;
  if (isMapped(g)) return mappedV4(g);
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/** The peer address for CIDR checks: IPv4-mapped IPv6 unwrapped, zone dropped. */
function peerAddress(raw: string): { address: string; family: 'ipv4' | 'ipv6'; groups: number[] | null } | null {
  const address = stripZone(raw);
  const family = isIP(address);
  if (family === 4) return { address, family: 'ipv4', groups: null };
  if (family !== 6) return null;
  const g = ipv6Groups(address);
  if (!g) return null;
  if (isMapped(g)) return { address: mappedV4(g), family: 'ipv4', groups: null };
  return { address, family: 'ipv6', groups: g };
}

/** Compile `TRUSTED_PROXY_CIDRS`; an empty list gives null (no trusted proxy). Throws on an invalid CIDR. */
export function compileTrustedProxies(cidrs: readonly string[]): TrustedProxies | null {
  if (cidrs.length === 0) return null;
  const list = new BlockList();
  for (const cidr of cidrs) {
    const m = /^([^/]+)\/(\d{1,3})$/.exec(cidr.trim());
    const family = m ? isIP(m[1] as string) : 0;
    const bits = m ? Number(m[2]) : -1;
    if (!m || family === 0 || bits > (family === 4 ? 32 : 128)) throw new Error(`invalid trusted proxy CIDR ${JSON.stringify(cidr)}`);
    list.addSubnet(m[1] as string, bits, family === 4 ? 'ipv4' : 'ipv6');
  }
  return {
    cidrs: [...cidrs],
    contains(raw: string): boolean {
      const peer = peerAddress(raw);
      return peer !== null && list.check(peer.address, peer.family);
    },
  };
}

/**
 * Why `TRUSTED_PROXY_CIDRS` is not acceptable on live, or null (platform review P4). Each
 * network must be private and narrow: IPv4 in an RFC 1918 range at /16 or narrower (the
 * tunnel overlay sets it from `EDGE_SUBNET`, which the Compose wrapper holds to /16 to /29),
 * IPv6 in fc00::/7 (unique local) at /64 or narrower. A wider or public network would make
 * every peer in it a trusted proxy whose `CF-Connecting-IP` is believed, so any container
 * on the host's Docker networks could mint identities (SECURITY_REVIEW F3). The reason
 * names the setting only, never its value.
 */
export function trustedProxyProblem(cidrs: readonly string[]): string | null {
  if (cidrs.length === 0) return 'TRUSTED_PROXY_CIDRS is empty: live runs in tunnel mode only';
  for (const cidr of cidrs) {
    const m = /^([^/]+)\/(\d{1,3})$/.exec(cidr.trim());
    const family = m ? isIP(m[1] as string) : 0;
    const bits = m ? Number(m[2]) : -1;
    if (family === 4) {
      const [a, b] = (m![1] as string).split('.').map(Number) as [number, number, number, number];
      const rfc1918 = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
      if (!rfc1918 || bits < 16 || bits > 32) {
        return 'TRUSTED_PROXY_CIDRS must list only private (RFC 1918) IPv4 networks of /16 or narrower, or unique-local IPv6 networks of /64 or narrower, on live';
      }
    } else if (family === 6) {
      const g = ipv6Groups(m![1] as string);
      const uniqueLocal = g !== null && (g[0]! & 0xfe00) === 0xfc00;
      if (!uniqueLocal || bits < 64 || bits > 128) {
        return 'TRUSTED_PROXY_CIDRS must list only private (RFC 1918) IPv4 networks of /16 or narrower, or unique-local IPv6 networks of /64 or narrower, on live';
      }
    } else {
      return 'TRUSTED_PROXY_CIDRS holds an entry that is not a CIDR';
    }
  }
  return null;
}

/** Loopback peers (the container's own health check). */
export function isLoopback(raw: string | undefined): boolean {
  const peer = raw ? peerAddress(raw) : null;
  if (!peer) return false;
  if (peer.family === 'ipv4') return peer.address.startsWith('127.');
  const g = peer.groups as number[];
  return g.slice(0, 7).every((x) => x === 0) && g[7] === 1;
}

/**
 * Resolve the network identity of one request from its socket peer and its
 * `CF-Connecting-IP` header (as Node delivers it: a string, or an array when repeated).
 */
export function resolveNetworkIdentity(
  peer: string | undefined,
  clientIpHeader: string | string[] | undefined,
  trusted: TrustedProxies | null,
): IdentityResult {
  if (!peer) return { ok: false, status: 403, reason: 'no_peer', peer: null };
  if (trusted === null) {
    const identity = normalizeAddress(peer);
    return identity
      ? { ok: true, identity, via: 'socket', peer }
      : { ok: false, status: 403, reason: 'no_peer', peer };
  }
  if (!trusted.contains(peer)) return { ok: false, status: 403, reason: 'untrusted_peer', peer };
  if (clientIpHeader === undefined || (typeof clientIpHeader === 'string' && clientIpHeader.trim() === '')) {
    return { ok: false, status: 400, reason: 'missing_client_ip', peer };
  }
  if (typeof clientIpHeader !== 'string') return { ok: false, status: 400, reason: 'invalid_client_ip', peer };
  const identity = normalizeAddress(clientIpHeader);
  if (!identity) return { ok: false, status: 400, reason: 'invalid_client_ip', peer };
  return { ok: true, identity, via: 'cf-connecting-ip', peer };
}
