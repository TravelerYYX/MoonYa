import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { mkdirSync } from 'node:fs';

export const APP_DATA_ROOT = resolve(process.env.MOONYA_DATA_ROOT || join(homedir(), '.MoonYa'));
const temporary = join(APP_DATA_ROOT, 'temp');
mkdirSync(temporary, { recursive:true });
process.env.TEMP = process.env.TMP = process.env.TMPDIR = temporary;
export const dataPath = (...parts) => join(APP_DATA_ROOT, ...parts);
