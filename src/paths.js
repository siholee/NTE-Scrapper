import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const dataRoot = path.resolve(process.env.NTE_DATA_DIR || path.join(projectRoot, 'data'));
