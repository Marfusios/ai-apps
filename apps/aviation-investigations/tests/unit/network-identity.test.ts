import { describe, expect, it } from 'vitest';
import { compileTrustedProxies, isLoopback, normalizeAddress, resolveNetworkIdentity } from '../../server/http/network-identity.js';

describe('normalizeAddress', () => {
  it('keeps IPv4 and unwraps IPv4-mapped IPv6', () => {
    expect(normalizeAddress('192.0.2.7')).toBe('192.0.2.7');
    expect(normalizeAddress('::ffff:192.0.2.7')).toBe('192.0.2.7');
    expect(normalizeAddress('::FFFF:c000:0207')).toBe('192.0.2.7');
    expect(normalizeAddress('0:0:0:0:0:ffff:192.0.2.7')).toBe('192.0.2.7');
  });

  it('reduces IPv6 to its /64 network', () => {
    expect(normalizeAddress('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(normalizeAddress('2001:DB8:1:2::ffff')).toBe('2001:db8:1:2::/64');
    expect(normalizeAddress('2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(normalizeAddress('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(normalizeAddress('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(normalizeAddress('::1')).toBe('0:0:0:0::/64');
  });

  it('two addresses of one /64 share an identity; neighbouring /64s do not', () => {
    expect(normalizeAddress('2001:db8:1:2::1')).toBe(normalizeAddress('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    expect(normalizeAddress('2001:db8:1:2::1')).not.toBe(normalizeAddress('2001:db8:1:3::1'));
  });

  it('rejects anything that is not exactly one address', () => {
    for (const bad of ['', ' ', 'unknown', '192.0.2.7, 198.51.100.1', '192.0.2.256', '1.2.3', '2001:db8::1::2', 'example.com', '192.0.2.7:443', `${'1'.repeat(70)}`]) {
      expect(normalizeAddress(bad), bad).toBeNull();
    }
  });
});

describe('isLoopback', () => {
  it('recognises IPv4, IPv6 and mapped loopback only', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('198.51.100.1')).toBe(false);
    expect(isLoopback('::2')).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });
});

describe('resolveNetworkIdentity', () => {
  const tunnel = compileTrustedProxies(['203.0.113.0/28', '2001:db8:ffff::/64']);

  it('without trusted proxies uses the socket peer and ignores proxy headers', () => {
    expect(resolveNetworkIdentity('192.0.2.7', '198.51.100.9', null)).toEqual({ ok: true, identity: '192.0.2.7', via: 'socket', peer: '192.0.2.7' });
    expect(resolveNetworkIdentity('::ffff:127.0.0.1', undefined, null)).toMatchObject({ ok: true, identity: '127.0.0.1' });
    expect(resolveNetworkIdentity('2001:db8:1:2::9', undefined, null)).toMatchObject({ ok: true, identity: '2001:db8:1:2::/64' });
  });

  it('refuses a peer outside the trusted networks, whatever header it sends (403)', () => {
    expect(resolveNetworkIdentity('192.0.2.7', '198.51.100.9', tunnel)).toEqual({ ok: false, status: 403, reason: 'untrusted_peer', peer: '192.0.2.7' });
    expect(resolveNetworkIdentity('203.0.113.16', '198.51.100.9', tunnel)).toMatchObject({ ok: false, status: 403 });
    expect(resolveNetworkIdentity('127.0.0.1', '198.51.100.9', tunnel)).toMatchObject({ ok: false, status: 403 });
    expect(resolveNetworkIdentity(undefined, '198.51.100.9', tunnel)).toMatchObject({ ok: false, status: 403, reason: 'no_peer' });
  });

  it('takes CF-Connecting-IP from a trusted peer, also over IPv4-mapped and IPv6 sockets', () => {
    expect(resolveNetworkIdentity('203.0.113.3', '198.51.100.9', tunnel)).toEqual({
      ok: true,
      identity: '198.51.100.9',
      via: 'cf-connecting-ip',
      peer: '203.0.113.3',
    });
    expect(resolveNetworkIdentity('::ffff:203.0.113.3', '2001:db8:aa:bb::1', tunnel)).toMatchObject({ ok: true, identity: '2001:db8:aa:bb::/64' });
    expect(resolveNetworkIdentity('2001:db8:ffff::5', '::ffff:198.51.100.9', tunnel)).toMatchObject({ ok: true, identity: '198.51.100.9' });
  });

  it('refuses a missing, repeated or invalid header from the connector (400), never a shared bucket', () => {
    expect(resolveNetworkIdentity('203.0.113.3', undefined, tunnel)).toMatchObject({ ok: false, status: 400, reason: 'missing_client_ip' });
    expect(resolveNetworkIdentity('203.0.113.3', '  ', tunnel)).toMatchObject({ ok: false, status: 400, reason: 'missing_client_ip' });
    expect(resolveNetworkIdentity('203.0.113.3', ['198.51.100.9', '198.51.100.10'], tunnel)).toMatchObject({ ok: false, status: 400 });
    for (const bad of ['unknown', '198.51.100.9, 198.51.100.10', '198.51.100.9:1234', 'x'.repeat(100)]) {
      expect(resolveNetworkIdentity('203.0.113.3', bad, tunnel), bad).toMatchObject({ ok: false, status: 400, reason: 'invalid_client_ip' });
    }
  });

  it('rejects invalid CIDRs and treats an empty list as no trusted proxy', () => {
    expect(compileTrustedProxies([])).toBeNull();
    expect(() => compileTrustedProxies(['203.0.113.0/33'])).toThrow(/invalid trusted proxy CIDR/);
    expect(() => compileTrustedProxies(['not-a-cidr'])).toThrow(/invalid trusted proxy CIDR/);
  });
});
