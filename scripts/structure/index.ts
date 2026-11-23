import { checkCycles, checkLayers } from './layers.js';
import {
  checkComponents,
  checkRepositories,
  checkRoutes,
} from './responsibility.js';
import { readSources, type Source } from './sources.js';
import { checkState } from './state.js';
import { checkTests } from './tests.js';

/** Everything wrong with how the code is placed; placed by structure, never by size. */
export function checkSources(sources: Source[]): string[] {
  return [
    ...checkLayers(sources),
    ...checkCycles(sources),
    ...checkComponents(sources),
    ...checkRepositories(sources),
    ...checkRoutes(sources),
    ...checkState(sources),
    ...checkTests(sources),
  ];
}
export const checkStructure = (root: string) => checkSources(readSources(root));
