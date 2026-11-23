import { checkStructure } from './structure/index.js';

const errors = checkStructure(process.cwd());
for (const error of errors) console.error(error);
if (errors.length > 0) process.exitCode = 1;
else
  console.info(
    'PASS: layers, cycles, one responsibility per file, state ownership and test structure.',
  );
