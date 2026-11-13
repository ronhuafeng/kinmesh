import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Resource, type Revisions } from '../src/workspace/events.js';

/** Resources a page reads besides the workspace. */
type PageResource = Exclude<Resource, 'workspace'>;
/** How a view tells what it reads, so each change is read once. */
export interface Reading {
  /** A read of the resource started. */
  begin: (resource: Resource) => void;
  /** It returned this revision. */
  settle: (resource: Resource, revision: string) => void;
  /** It failed, or its page closed: nothing of it is held. */
  drop: (resource: Resource) => void;
}
export interface Live extends Reading {
  /** Grows each time the resource should be read again. */
  reads: Record<PageResource, number>;
}
export const LiveContext = createContext<Live>({
  reads: { t3: 0, runs: 0 },
  begin: () => undefined,
  settle: () => undefined,
  drop: () => undefined,
});
export const useLive = () => useContext(LiveContext);

/**
 * The revisions on screen, and which resources to read again when the hub
 * names new ones. A resource being read notes the named revision and is
 * read again only if its read comes back with another.
 */
export function useRevisions(readWorkspace: () => void) {
  const held = useRef(new Map<Resource, string>());
  const named = useRef(new Map<Resource, string>());
  const loading = useRef(new Set<Resource>());
  const [reads, setReads] = useState<Record<PageResource, number>>({
    t3: 0,
    runs: 0,
  });
  const readAgain = useCallback(
    (resource: Resource) => {
      if (resource === 'workspace') readWorkspace();
      else setReads((r) => ({ ...r, [resource]: r[resource] + 1 }));
    },
    [readWorkspace],
  );
  const begin = useCallback((resource: Resource) => {
    loading.current.add(resource);
  }, []);
  const settle = useCallback(
    (resource: Resource, revision: string) => {
      loading.current.delete(resource);
      held.current.set(resource, revision);
      const told = named.current.get(resource);
      named.current.delete(resource);
      if (told !== undefined && told !== revision) readAgain(resource);
    },
    [readAgain],
  );
  const drop = useCallback((resource: Resource) => {
    loading.current.delete(resource);
    held.current.delete(resource);
    named.current.delete(resource);
  }, []);
  /** The hub named these revisions. */
  const receive = useCallback(
    (revisions: Revisions) => {
      for (const resource of Resource.options) {
        const revision = revisions[resource];
        if (revision === undefined || revision === held.current.get(resource))
          continue;
        if (loading.current.has(resource))
          named.current.set(resource, revision);
        else readAgain(resource);
      }
    },
    [readAgain],
  );
  /** The person asked to read everything on screen again. */
  const readAll = useCallback(() => {
    setReads((r) => ({ t3: r.t3 + 1, runs: r.runs + 1 }));
  }, []);
  const live = useMemo<Live>(
    () => ({ reads, begin, settle, drop }),
    [reads, begin, settle, drop],
  );
  return { live, receive, readAll };
}
