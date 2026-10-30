import { checkRepository } from './boundaries.js';
const errors = checkRepository(process.cwd());
if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else
  console.info(
    'PASS: source imports, resource calls, manifests, language and domain boundaries. Static guard only; review still required.',
  );
