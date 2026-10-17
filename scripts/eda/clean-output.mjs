import { lstatSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const output = resolve(root, 'dist');
if (dirname(output) !== root || basename(output) !== 'dist') throw new Error('UNSAFE_BUILD_OUTPUT');
try {
  if (lstatSync(output).isSymbolicLink()) throw new Error('BUILD_OUTPUT_LINK_FORBIDDEN');
  rmSync(output, { recursive: true, force: true });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
