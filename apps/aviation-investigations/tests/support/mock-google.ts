/**
 * An offline stand-in for Google's OAuth 2.0 and OpenID Connect endpoints as Better
 * Auth's Google provider uses them (developers.google.com/identity/openid-connect): the
 * browser's visit to the authorization endpoint (`authorize`) and the server's code
 * exchange at the token endpoint (`fetch`, which the test installs as the global fetch).
 * Nothing leaves the machine; a request to any other host fails loudly.
 *
 * - `authorize(url, user)` checks the authorization request the way Google would for this
 *   client (client id, redirect URI, response type `code`, the scopes, a PKCE S256
 *   challenge, a state) and returns the callback path Google would send the browser to,
 *   with a fresh code bound to that request and to the user who consented.
 * - `hold()` keeps code exchanges waiting at the token endpoint (a callback paused there).
 * - The token endpoint accepts a code once, with this client's id and secret
 *   (`client_secret_post`), the same redirect URI and the PKCE verifier, and answers with
 *   an access token and an RS256-signed ID token: issuer, audience and `azp` this client,
 *   the user's `sub`, email, `email_verified`, name and picture, an hour's expiry and the
 *   authorization request's nonce. `claims` overrides any claim (`undefined` removes it).
 */
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

export interface GoogleUser {
  sub: string;
  email: string;
  name?: string;
  emailVerified?: boolean;
  picture?: string;
}

interface Grant {
  challenge: string;
  redirectUri: string;
  nonce: string | null;
  user: GoogleUser;
  claims: Record<string, unknown>;
  used: boolean;
}

export interface AuthorizeRequest {
  responseType: string | null;
  clientId: string | null;
  redirectUri: string | null;
  scopes: string[];
  state: string | null;
  nonce: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  prompt: string | null;
  accessType: string | null;
  includeGrantedScopes: string | null;
  loginHint: string | null;
}

export interface TokenRequest {
  grantType: string | null;
  code: string | null;
  clientId: string | null;
  hasSecret: boolean;
  redirectUri: string | null;
  codeVerifier: string | null;
  status: number;
}

const b64url = (data: Buffer | string): string => Buffer.from(data).toString('base64url');

export class MockGoogle {
  readonly tokenRequests: TokenRequest[] = [];
  /** Code exchanges waiting at the token endpoint while it is held. */
  waiting = 0;
  /** Google redeems a code once; false stands in for a provider that would redeem it again. */
  singleUseCodes = true;
  private held: Promise<void> | null = null;
  private readonly grants = new Map<string, Grant>();
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly kid = `test-${randomBytes(4).toString('hex')}`;

  constructor(
    private readonly client: { clientId: string; clientSecret: string; redirectUri: string },
    private readonly now: () => number = Date.now,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = privateKey;
    this.publicKey = publicKey;
  }

  /** What an authorization URL asks for. */
  static parse(url: string): AuthorizeRequest {
    const u = new URL(url);
    const p = u.searchParams;
    return {
      responseType: p.get('response_type'),
      clientId: p.get('client_id'),
      redirectUri: p.get('redirect_uri'),
      scopes: (p.get('scope') ?? '').split(' ').filter(Boolean),
      state: p.get('state'),
      nonce: p.get('nonce'),
      codeChallenge: p.get('code_challenge'),
      codeChallengeMethod: p.get('code_challenge_method'),
      prompt: p.get('prompt'),
      accessType: p.get('access_type'),
      includeGrantedScopes: p.get('include_granted_scopes'),
      loginHint: p.get('login_hint'),
    };
  }

  /**
   * The user consents: the path (with query) of the redirect back to the app. Throws when
   * the request is not one Google would accept for this client.
   */
  authorize(url: string, user: GoogleUser, opts: { claims?: Record<string, unknown> } = {}): string {
    const u = new URL(url);
    if (`${u.origin}${u.pathname}` !== GOOGLE_AUTHORIZE_URL) throw new Error(`not Google's authorization endpoint: ${u.origin}${u.pathname}`);
    const r = MockGoogle.parse(url);
    if (r.responseType !== 'code') throw new Error('response_type must be code');
    if (r.clientId !== this.client.clientId) throw new Error('unknown client_id');
    if (r.redirectUri !== this.client.redirectUri) throw new Error('redirect_uri_mismatch');
    if (!r.state) throw new Error('state missing');
    if (r.codeChallengeMethod !== 'S256' || !r.codeChallenge) throw new Error('PKCE S256 challenge missing');
    const code = `4/${randomBytes(24).toString('base64url')}`;
    this.grants.set(code, {
      challenge: r.codeChallenge,
      redirectUri: r.redirectUri,
      nonce: r.nonce,
      user,
      claims: opts.claims ?? {},
      used: false,
    });
    // What Google's redirect carries besides the code and state.
    const redirect = new URL(r.redirectUri);
    redirect.searchParams.set('state', r.state);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('scope', 'email profile openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile');
    redirect.searchParams.set('authuser', '0');
    redirect.searchParams.set('prompt', 'consent');
    return `${redirect.pathname}${redirect.search}`;
  }

  /** Keep code exchanges waiting at the token endpoint until the returned function is called. */
  hold(): () => void {
    let release!: () => void;
    this.held = new Promise<void>((resolve) => (release = resolve));
    return () => {
      this.held = null;
      release();
    };
  }

  /** The user refuses at Google: the error redirect back to the app. */
  deny(url: string): string {
    const r = MockGoogle.parse(url);
    const redirect = new URL(r.redirectUri ?? this.client.redirectUri);
    redirect.searchParams.set('error', 'access_denied');
    if (r.state) redirect.searchParams.set('state', r.state);
    return `${redirect.pathname}${redirect.search}`;
  }

  /** The global fetch for the test: Google's token and certificate endpoints only. */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const target = `${url.origin}${url.pathname}`;
    if (target === GOOGLE_TOKEN_URL) {
      const body = input instanceof Request ? await input.text() : String(init?.body ?? '');
      if (this.held) {
        this.waiting += 1;
        await this.held;
        this.waiting -= 1;
      }
      return this.token(body);
    }
    if (target === GOOGLE_CERTS_URL) return Response.json({ keys: [this.jwk()] });
    throw new Error(`unexpected outbound request to ${url.origin}`);
  };

  private token(rawBody: string): Response {
    const p = new URLSearchParams(rawBody);
    const req: TokenRequest = {
      grantType: p.get('grant_type'),
      code: p.get('code'),
      clientId: p.get('client_id'),
      hasSecret: p.get('client_secret') === this.client.clientSecret,
      redirectUri: p.get('redirect_uri'),
      codeVerifier: p.get('code_verifier'),
      status: 400,
    };
    this.tokenRequests.push(req);
    const fail = (error: string) => Response.json({ error }, { status: 400 });
    if (req.grantType !== 'authorization_code') return fail('unsupported_grant_type');
    if (req.clientId !== this.client.clientId || !req.hasSecret) return fail('invalid_client');
    const grant = req.code ? this.grants.get(req.code) : undefined;
    if (!grant || (grant.used && this.singleUseCodes)) return fail('invalid_grant');
    grant.used = true;
    if (req.redirectUri !== grant.redirectUri) return fail('redirect_uri_mismatch');
    if (!req.codeVerifier || b64url(createHash('sha256').update(req.codeVerifier).digest()) !== grant.challenge) return fail('invalid_grant');
    req.status = 200;
    const iat = Math.floor(this.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: 'https://accounts.google.com',
      azp: this.client.clientId,
      aud: this.client.clientId,
      sub: grant.user.sub,
      email: grant.user.email,
      email_verified: grant.user.emailVerified ?? true,
      name: grant.user.name ?? 'Test Pilot',
      picture: grant.user.picture ?? 'https://lh3.googleusercontent.com/a/test-picture',
      given_name: 'Test',
      family_name: 'Pilot',
      iat,
      exp: iat + 3600,
      ...(grant.nonce ? { nonce: grant.nonce } : {}),
    };
    for (const [k, v] of Object.entries(grant.claims)) {
      if (v === undefined) delete claims[k];
      else claims[k] = v;
    }
    return Response.json({
      access_token: `ya29.${randomBytes(24).toString('base64url')}`,
      expires_in: 3599,
      scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
      token_type: 'Bearer',
      id_token: this.sign(claims),
    });
  }

  /** An RS256 JWT over `claims`, signed with this mock's key. */
  sign(claims: Record<string, unknown>): string {
    const header = b64url(JSON.stringify({ alg: 'RS256', kid: this.kid, typ: 'JWT' }));
    const payload = b64url(JSON.stringify(claims));
    const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(this.privateKey);
    return `${header}.${payload}.${b64url(signature)}`;
  }

  private jwk(): Record<string, unknown> {
    return { ...this.publicKey.export({ format: 'jwk' }), kid: this.kid, alg: 'RS256', use: 'sig' };
  }
}

/**
 * One browser's cookies: what the server set (`Set-Cookie`, Max-Age=0 removes), sent back
 * as a `Cookie` header. Paths and domains are not modelled: every cookie here is Path=/,
 * host-only.
 */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  store(setCookie: string | string[] | undefined): void {
    for (const line of setCookie === undefined ? [] : Array.isArray(setCookie) ? setCookie : [setCookie]) {
      const [pair] = line.split(';', 1);
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const maxAge = /;\s*max-age=(-?\d+)/i.exec(line)?.[1];
      if (maxAge !== undefined && Number(maxAge) <= 0) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  delete(name: string): void {
    this.cookies.delete(name);
  }

  /** A copy (another tab shares the cookies; another browser starts from a copy). */
  clone(): CookieJar {
    const copy = new CookieJar();
    for (const [k, v] of this.cookies) copy.set(k, v);
    return copy;
  }

  header(): string | undefined {
    return this.cookies.size === 0 ? undefined : [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}
