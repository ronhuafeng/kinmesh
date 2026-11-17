import { z } from 'zod';
import type { Config } from './config.js';
import { personName } from '../domain/contracts.js';
import { AVATAR_LIMIT } from '../persistence/agents.js';

const SCOPE = 'contact:user.email:readonly contact:user.employee:readonly';
/** Hosts of Feishu's authorization (accounts) and user info (open) APIs. */
const ACCOUNTS = 'https://accounts.feishu.cn';
const OPEN = 'https://open.feishu.cn';

export interface FeishuProfile {
  /** The person, the same across the developer's apps. */
  union: unknown;
  /** The enterprise mailbox, which only the organization hands out. */
  enterprise: unknown;
  tenant: unknown;
  /** The name the organization knows them by. */
  name?: unknown;
  /** Where Feishu keeps their picture. */
  avatar?: unknown;
}
/** What Kinmesh asks of Feishu to sign a person in. */
export interface Feishu {
  authorizeUrl(state: string, redirectUri: string): string;
  /** The user's access token for an authorization code. */
  exchange(code: string, redirectUri: string): Promise<string>;
  profile(accessToken: string): Promise<FeishuProfile>;
  /** The organization's name, read as the app itself (tenant:tenant:readonly). */
  organization(): Promise<string>;
  /** A person's picture from where the profile says it is; at most AVATAR_LIMIT bytes. */
  picture(url: string): Promise<Buffer>;
  /**
   * A message from the app's bot to one person, by their union_id
   * (im:message:send_as_bot): a title, a line, and a link to open.
   */
  message(
    union: string,
    post: { title: string; text: string; url: string },
  ): Promise<void>;
}

/**
 * A failure is named by stage and status only: nothing Feishu sent, no code
 * and no token, ever reaches an error message or a log.
 */
export class FeishuFailure extends Error {
  constructor(
    stage: 'token' | 'profile' | 'tenant' | 'picture' | 'message',
    status: number,
  ) {
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
const Tenant = z.looseObject({
  code: z.number().optional(),
  tenant_access_token: z.string().optional(),
  data: z
    .looseObject({ tenant: z.looseObject({ name: z.string() }).optional() })
    .optional(),
});
const Profile = z.looseObject({
  code: z.number().optional(),
  data: z
    // Feishu leaves out what an account does not have.
    .looseObject({
      union_id: z.unknown().optional(),
      enterprise_email: z.unknown().optional(),
      tenant_key: z.unknown().optional(),
      name: z.unknown().optional(),
      // 240 × 240: sharp on the largest face, well within a picture's limit.
      avatar_middle: z.unknown().optional(),
      avatar_url: z.unknown().optional(),
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
  /** The app's own token (tenant_access_token), asked for each time. */
  const tenantToken = async (stage: 'tenant' | 'message') => {
    const issued = await fetch(
      new URL('/open-apis/auth/v3/tenant_access_token/internal', open),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: config.appId,
          app_secret: config.appSecret,
        }),
        signal: AbortSignal.timeout(8000),
      },
    );
    const token = Tenant.safeParse(await read(issued));
    if (!issued.ok || !token.success || !token.data.tenant_access_token)
      throw new FeishuFailure(stage, issued.status);
    return token.data.tenant_access_token;
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
        union: body.data.data.union_id,
        enterprise: body.data.data.enterprise_email,
        tenant: body.data.data.tenant_key,
        name: body.data.data.name,
        avatar: body.data.data.avatar_middle ?? body.data.data.avatar_url,
      };
    },
    async organization() {
      const token = await tenantToken('tenant');
      const response = await fetch(
        new URL('/open-apis/tenant/v2/tenant/query', open),
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(8000),
        },
      );
      const body = Tenant.safeParse(await read(response));
      const name = body.success ? body.data.data?.tenant?.name : undefined;
      if (
        !response.ok ||
        !body.success ||
        (body.data.code !== undefined && body.data.code !== 0) ||
        name === undefined
      )
        throw new FeishuFailure('tenant', response.status);
      return name;
    },
    async message(union, post) {
      const token = await tenantToken('message');
      const url = new URL('/open-apis/im/v1/messages', open);
      url.searchParams.set('receive_id_type', 'union_id');
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          receive_id: union,
          msg_type: 'post',
          content: JSON.stringify({
            zh_cn: {
              title: post.title,
              content: [
                [{ tag: 'text', text: post.text }],
                [{ tag: 'a', text: '在 Kinmesh 中打开', href: post.url }],
              ],
            },
          }),
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
      const body = Envelope.safeParse(await read(response));
      if (
        !response.ok ||
        !body.success ||
        (body.data.code !== undefined && body.data.code !== 0)
      )
        throw new FeishuFailure('message', response.status);
    },
    async picture(address) {
      // Only Feishu's own HTTPS, or the stand-in a test runs; nothing it
      // redirects to, and never more than a picture may hold.
      const url = new URL(address);
      const standIn = config.standIn && new URL(config.standIn).origin;
      if (
        (url.protocol !== 'https:' && url.origin !== standIn) ||
        url.username !== '' ||
        url.password !== ''
      )
        throw new FeishuFailure('picture', 0);
      const response = await fetch(url, {
        headers: { Accept: 'image/png, image/jpeg, image/webp' },
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok || !response.body)
        throw new FeishuFailure('picture', response.status);
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        // Leaving the loop cancels the rest of the download.
        if (size > AVATAR_LIMIT)
          throw new FeishuFailure('picture', response.status);
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
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
 * Who a profile vouches for: a Feishu person of a tenant, admitted by an
 * enterprise mailbox in the organization's domain. The account's own
 * mailbox, which the person sets, never admits. The mailbox only admits;
 * the union_id says who. Null for anyone else.
 */
export function organizationMember(
  profile: FeishuProfile,
  domain: string,
): { feishuId: string; email: string; name: string | null } | null {
  const { union, tenant } = profile;
  const email = canonicalMailbox(profile.enterprise);
  if (
    typeof union !== 'string' ||
    union.trim() === '' ||
    union.length > 256 ||
    typeof tenant !== 'string' ||
    tenant.trim() === '' ||
    email?.slice(email.lastIndexOf('@') + 1) !== domain
  )
    return null;
  return { feishuId: union, email, name: personName(profile.name) };
}
