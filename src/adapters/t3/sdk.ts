import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { Descriptor } from './contracts.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Credential } from './oauth.js';
import { Endpoint, storedProvider } from './oauth.js';
import type { Wire } from './contracts.js';
import { ExecutionFailure } from '../../domain/execution.js';

const boundedFetch: FetchLike = (input, init) => {
  const inherited =
    init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const deadline = AbortSignal.timeout(30000);
  return fetch(input, {
    ...init,
    signal:
      inherited === undefined
        ? deadline
        : AbortSignal.any([inherited, deadline]),
  });
};
export class SdkWire implements Wire {
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;
  constructor(private readonly credential: Credential) {
    Endpoint.parse(credential.endpoint);
  }
  private async connected(): Promise<Client> {
    if (this.client !== undefined) return this.client;
    if (this.connecting !== undefined) return this.connecting;
    this.connecting = (async () => {
      const client = new Client({
        name: 'kinmesh-t3-adapter',
        version: '0.1.0',
      });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(this.credential.endpoint), {
            authProvider: storedProvider(this.credential),
            fetch: boundedFetch,
          }),
        );
        const raw = await client.callTool({
          name: 't3_environment_read',
          arguments: {},
        });
        let value: unknown = raw.structuredContent;
        if (value === undefined) {
          const text = z
            .array(z.object({ type: z.string(), text: z.string().optional() }))
            .parse(raw.content)
            .find((item) => item.type === 'text')?.text;
          try {
            value = JSON.parse(text ?? '');
          } catch {
            throw new ExecutionFailure('incompatible');
          }
        }
        const descriptor = Descriptor.safeParse(value);
        if (
          raw.isError ||
          !descriptor.success ||
          descriptor.data.environmentId !== this.credential.environmentId
        )
          throw new ExecutionFailure('incompatible');
        this.client = client;
        return client;
      } catch (error) {
        await client.close();
        throw error;
      } finally {
        this.connecting = undefined;
      }
    })();
    return this.connecting;
  }
  async list(): Promise<unknown> {
    return (await this.connected()).listTools();
  }
  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 30000,
  ): Promise<unknown> {
    try {
      const client = await this.connected();
      return await client.callTool({ name, arguments: args }, undefined, {
        timeout: timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      await this.close();
      if (signal?.aborted) throw new ExecutionFailure('cancelled');
      throw error;
    }
  }
  async close() {
    const client = this.client;
    this.client = undefined;
    if (client !== undefined) await client.close();
  }
}
