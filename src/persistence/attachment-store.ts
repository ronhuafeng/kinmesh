import { readdir, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { z } from 'zod';
import { DomainError } from '../domain/errors.js';

const Environment = z.object({
  /** Where the hub, the Inbox worker and Team MCP reach the store. */
  KINMESH_S3_ENDPOINT: z.url({ protocol: /^https?$/ }),
  /** Where browsers reach it to upload; the endpoint when unset. */
  KINMESH_S3_PUBLIC_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
  KINMESH_S3_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .default('kinmesh-files'),
  KINMESH_S3_REGION: z.string().min(1).default('us-east-1'),
  KINMESH_S3_ACCESS_KEY_ID: z.string().min(1),
  KINMESH_S3_SECRET_ACCESS_KEY: z.string().min(1),
});
export type StoreConfig = ReturnType<typeof storeConfig>;
export function storeConfig(env: NodeJS.ProcessEnv) {
  const value = Environment.parse(env);
  return {
    endpoint: value.KINMESH_S3_ENDPOINT,
    publicEndpoint:
      value.KINMESH_S3_PUBLIC_ENDPOINT ?? value.KINMESH_S3_ENDPOINT,
    bucket: value.KINMESH_S3_BUCKET,
    region: value.KINMESH_S3_REGION,
    credentials: {
      accessKeyId: value.KINMESH_S3_ACCESS_KEY_ID,
      secretAccessKey: value.KINMESH_S3_SECRET_ACCESS_KEY,
    },
  };
}

/** How long a browser has to start an upload it was given. */
const UPLOAD_SECONDS = 15 * 60;
/** Enough of a file to tell its type and an image's pixels. */
export const HEAD_BYTES = 512 * 1024;
/** Kept bytes, by their SHA-256. */
const kept = (sha256: string) => `files/${sha256}`;
/** Bytes a browser uploaded and no one kept yet: gone after a day. */
const incoming = (sha256: string) => `incoming/${sha256}`;
const SHA256 = /^[a-f0-9]{64}$/;
const checked = (sha256: string) => {
  if (!SHA256.test(sha256)) throw new DomainError('invalid');
  return sha256;
};
const missing = (error: unknown) =>
  error instanceof S3ServiceException &&
  (error.$metadata.httpStatusCode === 404 ||
    error.name === 'NotFound' ||
    error.name === 'NoSuchKey');

/**
 * Attachments' bytes in an S3-compatible bucket, each kept once by its
 * SHA-256. Browsers upload to it directly, and every read streams, so no
 * process holds a whole file.
 */
export type AttachmentStore = ReturnType<typeof attachmentStore>;
export function attachmentStore(config: StoreConfig) {
  const client = (endpoint: string) =>
    new S3Client({
      endpoint,
      region: config.region,
      credentials: config.credentials,
      forcePathStyle: true,
      // Checksums are the browser's, signed into its upload; reads never ask.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  const s3 = client(config.endpoint);
  const signer =
    config.publicEndpoint === config.endpoint
      ? s3
      : client(config.publicEndpoint);
  const Bucket = config.bucket;
  const size = async (Key: string) => {
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket, Key }));
      return head.ContentLength ?? 0;
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  };
  const read = async (Key: string, range?: { start: number; end: number }) => {
    const object = await s3.send(
      new GetObjectCommand({
        Bucket,
        Key,
        ...(range && {
          Range: `bytes=${String(range.start)}-${String(range.end)}`,
        }),
      }),
    );
    if (!(object.Body instanceof Readable)) throw new Error('No body');
    return object.Body;
  };
  return {
    /** The bucket, and uploads no one kept leaving after a day. */
    async prepare() {
      try {
        await s3.send(new HeadBucketCommand({ Bucket }));
      } catch (error) {
        if (!missing(error)) throw error;
        await s3.send(new CreateBucketCommand({ Bucket }));
      }
      await s3.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket,
          LifecycleConfiguration: {
            Rules: [
              {
                ID: 'incoming',
                Status: 'Enabled',
                Filter: { Prefix: 'incoming/' },
                Expiration: { Days: 1 },
              },
            ],
          },
        }),
      );
    },
    /**
     * Where a browser PUTs exactly `size` bytes whose SHA-256 is `sha256`;
     * the store refuses any others. Null: they are kept already.
     */
    async uploadUrl(sha256: string, bytes: number) {
      if ((await size(kept(checked(sha256)))) !== null) return null;
      return getSignedUrl(
        signer,
        new PutObjectCommand({
          Bucket,
          Key: incoming(sha256),
          ContentLength: bytes,
          ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
        }),
        {
          expiresIn: UPLOAD_SECONDS,
          signableHeaders: new Set(['content-length', 'x-amz-checksum-sha256']),
          unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
        },
      );
    },
    /**
     * Uploaded or kept bytes: their size and first bytes. Null: there are
     * none under this hash.
     */
    async find(sha256: string) {
      for (const Key of [kept(checked(sha256)), incoming(sha256)]) {
        const bytes = await size(Key);
        if (bytes === null) continue;
        if (bytes === 0) return { size: 0, head: Buffer.alloc(0) };
        const head = await read(Key, {
          start: 0,
          end: Math.min(bytes, HEAD_BYTES) - 1,
        });
        return { size: bytes, head: Buffer.concat(await head.toArray()) };
      }
      return null;
    },
    /** Keeps uploaded bytes under their hash; kept already changes nothing. */
    async keep(sha256: string) {
      const Key = kept(checked(sha256));
      if ((await size(Key)) !== null) return;
      try {
        await s3.send(
          new CopyObjectCommand({
            Bucket,
            Key,
            CopySource: `${Bucket}/${incoming(sha256)}`,
          }),
        );
      } catch (error) {
        // Not uploaded, or gone after a day: upload again.
        if (missing(error)) throw new DomainError('invalid');
        throw error;
      }
      await s3.send(new DeleteObjectCommand({ Bucket, Key: incoming(sha256) }));
    },
    /** Kept bytes as a stream: all of them, or `start` to `end` inclusive. */
    read: (sha256: string, range?: { start: number; end: number }) =>
      read(kept(checked(sha256)), range),
    async remove(sha256: string) {
      await s3.send(
        new DeleteObjectCommand({ Bucket, Key: kept(checked(sha256)) }),
      );
    },
    /**
     * Bytes an earlier hub kept in its state directory (`attachments/ab/…`)
     * move to the store, once, as the hub starts.
     */
    async adopt(state: string) {
      const root = join(state, 'attachments');
      if (!(await stat(root).catch(() => null))) return;
      for (const shard of await readdir(root))
        for (const name of await readdir(join(root, shard))) {
          if (!SHA256.test(name)) continue;
          const path = join(root, shard, name);
          if ((await size(kept(name))) !== null) continue;
          await s3.send(
            new PutObjectCommand({
              Bucket,
              Key: kept(name),
              Body: createReadStream(path),
              ContentLength: (await stat(path)).size,
            }),
          );
        }
      await rm(root, { recursive: true, force: true });
    },
  };
}
