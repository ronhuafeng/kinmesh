import { checkRepository } from './boundaries.js';
import { checkStructure } from './structure/index.js';

const errors = [
  ...checkRepository(process.cwd()),
  ...checkStructure(process.cwd()),
];
if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else
  console.info(
    'PASS: source imports, resource calls, manifests, language, domain and adapter boundaries; layers, cycles, one responsibility per file, state ownership and test structure. Static guard only; review still required.',
  );
