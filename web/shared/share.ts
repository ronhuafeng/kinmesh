import { z } from 'zod';

/** Where the service worker keeps what was shared (`sw.ts`). */
const SHARED = 'kinmesh-shared';
/**
 * What the system shared to Kinmesh, by the name the service worker gave
 * it: read as the page loads, before the workspace rewrites the address.
 */
export const sharedId = (() => {
  const id = new URLSearchParams(window.location.search).get('share');
  return id !== null && z.uuid().safeParse(id).success ? id : null;
})();
/** Text and files shared to Kinmesh, on their way into a channel. */
export interface Shared {
  text: string;
  files: File[];
}
const Meta = z.object({
  text: z.string(),
  files: z.array(
    z.object({ index: z.number().int(), name: z.string(), type: z.string() }),
  ),
});
/**
 * What was shared, taken: read once from where the service worker kept it,
 * and gone from there. Null when there is nothing (or no storage).
 */
export async function takeShared(id: string): Promise<Shared | null> {
  if (!('caches' in window)) return null;
  const cache = await caches.open(SHARED);
  const base = `/__shared/${id}/`;
  const meta = await cache.match(base + 'meta');
  if (!meta) return null;
  const parsed = Meta.safeParse(await meta.json());
  const files: File[] = [];
  if (parsed.success)
    for (const f of parsed.data.files) {
      const kept = await cache.match(base + String(f.index));
      if (kept)
        files.push(new File([await kept.blob()], f.name, { type: f.type }));
    }
  for (const key of await cache.keys())
    if (new URL(key.url).pathname.startsWith(base)) await cache.delete(key);
  return parsed.success ? { text: parsed.data.text, files } : null;
}
