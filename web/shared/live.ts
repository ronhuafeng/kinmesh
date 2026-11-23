import { createContext, useContext } from 'react';
import type { Resource } from '../../src/workspace/events.js';

/** Resources a page reads besides the workspace. */
export type PageResource = Exclude<Resource, 'workspace'>;
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
  reads: { t3: 0, runs: 0, grants: 0 },
  begin: () => undefined,
  settle: () => undefined,
  drop: () => undefined,
});
export const useLive = () => useContext(LiveContext);
