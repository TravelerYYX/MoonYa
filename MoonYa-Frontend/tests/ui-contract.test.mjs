import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

test('application-owned frontend and native UI sources contain no literal emoji', async () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const violations = [];
    async function scan(dir, extensions) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (['bin', 'obj', 'python', 'agent_runtime', 'crawler_output'].includes(entry.name)) continue;
            const path = join(dir, entry.name);
            if (entry.isDirectory()) await scan(path, extensions);
            else if (extensions.some(extension => path.endsWith(extension))) {
                const source = (await readFile(path, 'utf8')).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
                if (/\p{Extended_Pictographic}/u.test(source)) violations.push(path);
            }
        }
    }
    await scan(join(root, 'MoonYa-Frontend/src'), ['.html', '.js', '.css']);
    await scan(join(root, 'MoonYa-Win/MoonYa-Solution/MoonYa'), ['.xaml', '.html']);
    assert.deepEqual(violations, [], 'Use local SVG icons for application-owned UI; dynamic user content remains untouched.');
});
