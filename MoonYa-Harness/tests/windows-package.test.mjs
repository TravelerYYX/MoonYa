import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, cp, rm, unlink, rmdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

test('incremental builds back up legacy server payloads once and refuse source-directory cleanup',
  { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'moonya-legacy-payload-'));
    const script = fileURLToPath(new URL('../scripts/retire-legacy-client-payload.ps1', import.meta.url));
    const retire = output => spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-OutputRoot', output],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    let backup;
    try {
      await mkdir(join(root, 'wwwroot'), { recursive: true });
      await mkdir(join(root, 'win-x64', 'wwwroot'), { recursive: true });
      await writeFile(join(root, 'wwwroot', '.env'), 'old configuration fixture');
      await writeFile(join(root, 'win-x64', 'wwwroot', 'index.php'), '<?php /* old UI fixture */');
      await writeFile(join(root, 'MoonYa.dll'), 'current desktop fixture');
      const result = retire(root);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const first = result.stdout.split(/\r?\n/).find(line => line.startsWith('Retired legacy server payload to backup: '));
      backup = dirname(first.slice('Retired legacy server payload to backup: '.length));
      assert.equal(await readFile(join(backup, 'wwwroot', '.env'), 'utf8'), 'old configuration fixture');
      assert.equal(await readFile(join(backup, 'win-x64', 'wwwroot', 'index.php'), 'utf8'), '<?php /* old UI fixture */');
      assert.equal(await readFile(join(root, 'MoonYa.dll'), 'utf8'), 'current desktop fixture');
      await assert.rejects(readFile(join(root, 'wwwroot', '.env')), { code: 'ENOENT' });
      const repeated = retire(root);
      assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
      assert.equal(repeated.stdout.trim(), '');
      const source = fileURLToPath(new URL('../../MoonYa-Backend', import.meta.url));
      const refused = retire(source);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stdout + refused.stderr, /generated output directory/);
    } finally {
      await rm(root, { recursive: true, force: true });
      if (backup) {
        // Remove only this test's known fixture files, with no recursive backup deletion.
        await unlink(join(backup, 'wwwroot', '.env'));
        await unlink(join(backup, 'win-x64', 'wwwroot', 'index.php'));
        await unlink(join(backup, 'backup-info.json'));
        await rmdir(join(backup, 'wwwroot'));
        await rmdir(join(backup, 'win-x64', 'wwwroot'));
        await rmdir(join(backup, 'win-x64'));
        await rmdir(backup);
      }
    }
  });

test('folder publishing accepts workspace bin output and still refuses source roots and bin lookalikes',
  { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
    const project = fileURLToPath(new URL('../../', import.meta.url));
    const bin = join(project, 'bin');
    await mkdir(bin, { recursive: true });
    const root = await mkdtemp(join(bin, 'publish-cleanup-test-'));
    const script = fileURLToPath(new URL('../scripts/retire-legacy-client-payload.ps1', import.meta.url));
    const retire = output => spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-OutputRoot', output],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    let backup;
    try {
      await mkdir(join(root, 'wwwroot'));
      await writeFile(join(root, 'wwwroot', 'index.php'), '<?php /* legacy publish fixture */');
      const result = retire(root);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const line = result.stdout.split(/\r?\n/).find(value => value.startsWith('Retired legacy server payload to backup: '));
      backup = dirname(line.slice('Retired legacy server payload to backup: '.length));
      assert.equal(await readFile(join(backup, 'wwwroot', 'index.php'), 'utf8'), '<?php /* legacy publish fixture */');
      await assert.rejects(readFile(join(root, 'wwwroot', 'index.php')), { code: 'ENOENT' });
      assert.equal(retire(root).status, 0);
      for (const refused of [project, join(project, 'MoonYa-Backend'), join(project, 'bin-source')]) {
        const rejection = retire(refused);
        assert.notEqual(rejection.status, 0, `Unsafe output accepted: ${refused}`);
        assert.match(rejection.stdout + rejection.stderr, /Unsafe build output root|generated output directory/);
      }
    } finally {
      await rmdir(root);
      if (backup) {
        await unlink(join(backup, 'wwwroot', 'index.php'));
        await unlink(join(backup, 'backup-info.json'));
        await rmdir(join(backup, 'wwwroot'));
        await rmdir(backup);
      }
    }
  });

test('physical release needs no driver and rejects disabled configuration or legacy desktop hosts',
  { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'moonya-physical-package-'));
    const config = join(root, 'launcher_config.json');
    const verify = () => spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      fileURLToPath(new URL('../../MoonYa-Win/Installer/Test-ReleasePackage.ps1', import.meta.url)), '-PublishPath', root],
    { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    try {
      for (const name of ['MoonYa.exe', 'MoonYa.DesktopCapture.dll', 'python/python.exe', 'agent_runtime/src/computer_python/runner.py', 'agent_runtime/src/desktop-gateway.mjs']) {
        const target = join(root, name);
        await mkdir(join(target, '..'), { recursive: true });
        await writeFile(target, 'package fixture');
      }
      await cp(new URL('../../MoonYa-Frontend/dist',import.meta.url),join(root,'frontend'),{recursive:true});
      await writeFile(config, JSON.stringify({ desktop_automation: { provider: 'physical' } }));
      let result = verify();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      await writeFile(config, JSON.stringify({ desktop_automation: { provider: 'disabled' } }));
      result = verify();
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /physical desktop provider/);
      await writeFile(config, JSON.stringify({ desktop_automation: { provider: 'physical' } }));
      await mkdir(join(root, 'virtual_display'));
      await writeFile(join(root, 'virtual_display', 'MoonYa.DisplayHost.exe'), 'legacy host');
      result = verify();
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /Legacy virtual desktop component/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test('CEF flattening preserves the application and package verification detects stale Python and conversation assets',
  { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'moonya-package-'));
    try {
      const old = join(root, 'win-x64');
      await mkdir(join(old, 'agent_runtime', 'src'), { recursive: true });
      await mkdir(join(old, 'wwwroot'), { recursive: true });
      await writeFile(join(root, 'launcher_config.json'), 'current configuration');
      await writeFile(join(old, 'launcher_config.json'), 'stale configuration');
      await writeFile(join(old, 'agent_runtime', 'src', 'server.mjs'), 'stale harness');
      await writeFile(join(old, 'wwwroot', 'index.php'), 'stale website');
      await writeFile(join(old, 'chrome_elf.dll'), 'CEF asset fixture');
      const website = await readFile(new URL('../../MoonYa-Frontend/dist/index.html', import.meta.url), 'utf8');
      await mkdir(join(old,'frontend'),{recursive:true});
      await writeFile(join(old,'frontend','index.html'),'stale frontend');
      const project = fileURLToPath(new URL('../../MoonYa-Win/MoonYa-Solution/MoonYa/MoonYa.csproj', import.meta.url));
      const build = spawnSync('dotnet', ['msbuild', project, '-t:FlattenCefSharpNative', '-p:Configuration=Debug',
        '-p:Platform=x64', `-p:OutDir=${root}\\`, '-nologo', '-v:quiet'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
      // The old nested wwwroot is intentionally forbidden by the new build verifier.
      assert.notEqual(build.status, 0);
      assert.equal(await readFile(join(root, 'launcher_config.json'), 'utf8'), 'current configuration');
      assert.equal(await readFile(join(root, 'frontend', 'index.html'), 'utf8'), website);
      assert.equal(await readFile(join(root, 'chrome_elf.dll'), 'utf8'), 'CEF asset fixture');
      assert.equal(await readFile(join(root, 'agent_runtime', 'src', 'server.mjs'), 'utf8'),
        await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8'));
      await unlink(join(old,'wwwroot','index.php'));
      const runner = join(root, 'agent_runtime', 'src', 'computer_python', 'runner.py');
      await writeFile(runner, 'stale Python bridge');
      const verification = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        fileURLToPath(new URL('../scripts/verify-runtime-package.ps1', import.meta.url)), '-OutputRoot', root],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      assert.notEqual(verification.status, 0);
      assert.match(verification.stdout + verification.stderr, /runner.py/);
      await copyFile(new URL('../src/computer_python/runner.py', import.meta.url), runner);
      await writeFile(join(root, 'frontend', 'subagent-chat.js'), 'stale conversation renderer');
      const staleConversation = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        fileURLToPath(new URL('../scripts/verify-runtime-package.ps1', import.meta.url)), '-OutputRoot', root],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      assert.notEqual(staleConversation.status, 0);
      assert.match(staleConversation.stdout + staleConversation.stderr, /subagent-chat.js/);
      await copyFile(new URL('../../MoonYa-Frontend/dist/subagent-chat.js',import.meta.url),join(root,'frontend','subagent-chat.js'));
      await writeFile(join(old,'wwwroot','index.php'),'forbidden server fixture');
      const forbidden=spawnSync('powershell',['-NoProfile','-ExecutionPolicy','Bypass','-File',
        fileURLToPath(new URL('../scripts/verify-runtime-package.ps1',import.meta.url)),'-OutputRoot',root],
        {encoding:'utf8',windowsHide:true,timeout:5000});
      assert.notEqual(forbidden.status,0);assert.match(forbidden.stdout+forbidden.stderr,/Server-only file/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
