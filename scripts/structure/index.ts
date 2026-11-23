import { checkWebRoot } from './placement.js';
import { checkRepositories, checkRoutes } from './responsibility.js';
import { readSources, type Source } from './sources.js';
import { checkState } from './state.js';
import { checkTests } from './tests.js';

/**
 * What dependency-cruiser can't say about how code is placed: the root of
 * web, composition roots, repositories, routes and tests. Layers and cycles
 * are its (`.dependency-cruiser.json`).
 */
export function checkSources(sources: Source[]): string[] {
  return [
    ...checkWebRoot(sources),
    ...checkRepositories(sources),
    ...checkRoutes(sources),
    ...checkState(sources),
    ...checkTests(sources),
  ];
}
export const checkStructure = (root: string) => checkSources(readSources(root));
