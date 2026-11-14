import { z } from 'zod';
import type { Config } from './config.js';

const SCOPE = 'contact:user.email:readonly contact:user.employee:readonly';
/** Hosts of Feishu's authorization (accounts) and user info (open) APIs. */
const ACCOUNTS = 'https://accounts.feishu.cn';
const OPEN = 'https://open.feishu.cn';

export interface FeishuProfile {
  email: unknown;
  enterprise: unknown;
  tenant: unknown;
}
/** What Kinmesh asks of Feishu to sign a person in. */
export interface Feishu {
  authorizeUrl(state: string, redirectUri: string): string;
  /** The user's access token for an authorization code. */
  exchange(code: string, redirectUri: string): Promise<string>;
  profile(accessToken: string): Promise<FeishuProfile>;
}

/**
 * A failure is named by stage and status only: nothing Feishu sent, no code
 * and no token, ever reaches an error message or a log.
 */
export class FeishuFailure extends Error {
  constructor(stage: 'token' | 'profile', status: number) {
    super(`feishu_${stage}_${String(status)}`);
    this.name = 'FeishuFailure';
  }
}

const Envelope = z.looseObject({
  code: z.number().optional(),
  error: z.string().optional(),
  access_token: z.string().optional(),
  data: z.looseObject({ access_token: z.string().optional() }).optional(),
});
const Profile = z.looseObject({
  code: z.number().optional(),
  data: z
    // Feishu leaves out what an account does not have.
    .looseObject({
      email: z.unknown().optional(),
      enterprise_email: z.unknown().optional(),
      tenant_key: z.unknown().optional(),
    })
    .optional(),
});

export function feishuClient(config: Config['feishu']): Feishu {
  const accounts = config.standIn ?? ACCOUNTS;
  const open = config.standIn ?? OPEN;
  const read = async (response: Response) => {
    try {
      return (await response.json()) as unknown;
    } catch {
      return null;
    }
  };
  return {
    authorizeUrl(state, redirectUri) {
      const url = new URL('/open-apis/authen/v1/authorize', accounts);
      url.searchParams.set('client_id', config.appId);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('scope', SCOPE);
      return url.href;
    },
    async exchange(code, redirectUri) {
      const response = await fetch(new URL('/oauth/v3/token', accounts), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: config.appId,
          client_secret: config.appSecret,
          code,
          redirect_uri: redirectUri,
        }),
        signal: AbortSignal.timeout(8000),
      });
      const body = Envelope.safeParse(await read(response));
      const token = body.success
        ? (body.data.access_token ?? body.data.data?.access_token)
        : undefined;
      if (
        !response.ok ||
        !body.success ||
        body.data.error !== undefined ||
        (body.data.code !== undefined && body.data.code !== 0) ||
        !token
      )
        throw new FeishuFailure('token', response.status);
      return token;
    },
    async profile(accessToken) {
      const response = await fetch(
        new URL('/open-apis/authen/v1/user_info', open),
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(8000),
        },
      );
      const body = Profile.safeParse(await read(response));
      if (
        !response.ok ||
        !body.success ||
        !body.data.data ||
        (body.data.code !== undefined && body.data.code !== 0)
      )
        throw new FeishuFailure('profile', response.status);
      return {
        email: body.data.data.email,
        enterprise: body.data.data.enterprise_email,
        tenant: body.data.data.tenant_key,
      };
    },
  };
}

/** A mailbox as Kinmesh keeps it: trimmed and lower-case, or null. */
export function canonicalMailbox(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (
    email.length > 254 ||
    /[\s\u0000-\u001f\u007f]/.test(email) ||
    !/^[^@]+@[^@]+$/.test(email)
  )
    return null;
  return email;
}
/**
 * The organization mailbox a profile vouches for: the enterprise address
 * first, then the account's own, and only within the organization's domain.
 */
export function organizationMailbox(
  profile: FeishuProfile,
  domain: string,
): string | null {
  for (const value of [profile.enterprise, profile.email]) {
    const email = canonicalMailbox(value);
    if (email?.slice(email.lastIndexOf('@') + 1) === domain) return email;
  }
  return null;
}
