import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, symlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Workspaces } from '../src/workspaces.mjs';
import { WorkspaceChanges } from '../src/workspace-changes.mjs';
import { atomicWrite, jsonFile, snapshot, digest } from '../src/workspace-files.mjs';
const exec = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'moonya-changes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = [], workspaces = new Workspaces(join(root, 'runtime/workspaces'), join(root, 'default'), () => sessions);
  await workspaces.initialize();
  const binding = await workspaces.bind('user:1', 'chat:1');
  const session = { id: 'root-1', workspace: binding.path, workspaceId: binding.id, status: 'idle' }; sessions.push(session);
  const changes = new WorkspaceChanges(join(root, 'runtime/changes'), workspaces);
  const write = (name, value) => writeFile(join(session.workspace, name), value);
  return { root, session, sessions, workspaces, changes, write };
}
test('whole workspace captures command/subagent files, net edits, creation and deletion, preserves raw bytes on undo', async t => {
  const f = await fixture(t);
  const original = Buffer.from('\ufeffold\r\ncontext\r\n', 'utf8');
  await f.write('edited.cs', original); await f.write('deleted.txt', 'remove me\n'); await f.write('unchanged.txt', 'keep\n');
  await f.changes.begin(f.session, 1);
  await f.write('edited.cs', 'middle\n'); await f.write('edited.cs', 'new\r\ncontext\r\n');
  await f.write('command.txt', 'from PowerShell\n'); await f.write('child.txt', 'from child\n');
  await f.write('unchanged.txt', 'changed'); await f.write('unchanged.txt', 'keep\n');
  await rm(join(f.session.workspace, 'deleted.txt'));
  const summary = await f.changes.finish(f.session, 1);
  assert.deepEqual(summary.files.map(file => file.path), ['child.txt', 'command.txt', 'deleted.txt', 'edited.cs']);
  assert.equal(summary.added, 3); assert.equal(summary.deleted, 2);
  const edited = summary.files.find(file => file.path === 'edited.cs');
  const diff = await f.changes.diff(f.session, 1, edited.id);
  assert.ok(diff.hunks[0].lines.includes('+new'));
  const undone = await f.changes.undo(f.session, 1, { revision: summary.revision, request_id: 'one' });
  assert.equal(undone.state, 'undone'); assert.deepEqual(await readFile(join(f.session.workspace, 'edited.cs')), original);
  assert.equal(await readFile(join(f.session.workspace, 'deleted.txt'), 'utf8'), 'remove me\n');
  await assert.rejects(access(join(f.session.workspace, 'child.txt')));
  assert.equal((await f.changes.undo(f.session, 1, { revision: 1, request_id: 'one' })).state, 'undone');
});
test('running previews track net changes without finalizing the baseline and final review remains immutable', async t => {
  const f = await fixture(t); await f.write('a.txt', 'before\n');
  await f.changes.begin(f.session, 1);
  assert.equal((await f.changes.preview(f.session, 1)).total, 0);
  await f.write('a.txt', 'middle\n'); await f.write('new.txt', 'one\ntwo\n');
  const live = await f.changes.preview(f.session, 1);
  assert.equal(live.state, 'recording'); assert.equal(live.total, 2); assert.equal(live.added, 3); assert.equal(live.deleted, 1);
  const saved = await f.changes.summary(f.session, 1); assert.equal(saved.state, 'recording'); assert.equal(saved.total, 0);
  assert.equal((await jsonFile(f.changes.path(f.session, 1))).after, undefined);
  const liveDiff = await f.changes.diff(f.session, 1, live.files.find(file => file.path === 'a.txt').id);
  assert.deepEqual(liveDiff.hunks[0].lines, ['-before', '+middle']);
  await assert.rejects(f.changes.undo(f.session, 1, { revision: 1, request_id: 'live' }), /change_record_not_ready/);
  await f.write('a.txt', 'before\n'); assert.equal((await f.changes.preview(f.session, 1)).total, 1);
  await f.write('new.txt', 'final\n');
  const [final, finishingDiff] = await Promise.all([f.changes.finish(f.session, 1), f.changes.diff(f.session, 1, live.files.find(file => file.path === 'new.txt').id)]);
  assert.equal(final.state, 'ready'); assert.equal(final.added, 1); assert.equal(final.deleted, 0);
  assert.deepEqual(finishingDiff.hunks[0].lines, ['+final']);
  await f.write('new.txt', 'later\n'); assert.deepEqual(await f.changes.preview(f.session, 1), final);
  assert.deepEqual((await f.changes.diff(f.session, 1, final.files[0].id)).hunks[0].lines, ['+final']);
});

test('one conflict rejects the entire turn without modifying any file', async t => {
  const f = await fixture(t); await f.write('a.txt', 'a'); await f.write('b.txt', 'b');
  await f.changes.begin(f.session, 1); await f.write('a.txt', 'after'); await f.write('b.txt', 'after');
  const summary = await f.changes.finish(f.session, 1); await f.write('b.txt', 'user edit');
  const result = await f.changes.undo(f.session, 1, { revision: summary.revision, request_id: 'conflict' });
  assert.deepEqual(result.conflicts, ['b.txt']); assert.equal(await readFile(join(f.session.workspace, 'a.txt'), 'utf8'), 'after');
  assert.equal(await readFile(join(f.session.workspace, 'b.txt'), 'utf8'), 'user edit');
});
test('record and immutable diff survive restart and later file edits', async t => {
  const f = await fixture(t); await f.write('a.txt', 'before'); await f.changes.begin(f.session, 1); await f.write('a.txt', 'after');
  const summary = await f.changes.finish(f.session, 1);
  const restarted = new WorkspaceChanges(f.changes.root, f.workspaces); await restarted.recover();
  assert.deepEqual(await restarted.summary(f.session, 1), summary);
  await f.write('a.txt', 'later');
  const diff = await restarted.diff(f.session, 1, summary.files[0].id);
  assert.deepEqual(diff.hunks[0].lines, ['-before', '+after']);
});
test('binary and oversized files keep byte backups and remain undoable', async t => {
  const f = await fixture(t); const original = Buffer.alloc(3 * 1024 * 1024, 45);
  await f.write('large.bin', original); await f.write('binary.dat', Buffer.from([0, 1, 2]));
  await f.changes.begin(f.session, 1); await f.write('large.bin', Buffer.alloc(original.length, 46)); await f.write('binary.dat', Buffer.from([0, 3]));
  const summary = await f.changes.finish(f.session, 1);
  assert.ok(summary.files.find(file => file.path === 'large.bin').oversized);
  assert.ok(summary.files.find(file => file.path === 'binary.dat').binary);
  await f.changes.undo(f.session, 1, { revision: 1, request_id: 'large' });
  assert.deepEqual(await readFile(join(f.session.workspace, 'large.bin')), original);
});
test('Git tracks existing dirty baselines and respects ignore while retaining ignored tracked files', async t => {
  const f = await fixture(t), cwd = f.session.workspace;
  await exec('git', ['init', cwd], { windowsHide: true });
  await f.write('.gitignore', 'ignored.txt\ntracked.txt\n'); await f.write('tracked.txt', 'original');
  await exec('git', ['-C', cwd, 'add', '-f', 'tracked.txt'], { windowsHide: true });
  await f.write('tracked.txt', 'already dirty'); await f.write('ignored.txt', 'ignored');
  await f.changes.begin(f.session, 1); await f.write('tracked.txt', 'changed this turn'); await f.write('ignored.txt', 'still ignored'); await f.write('new.txt', 'new');
  const summary = await f.changes.finish(f.session, 1);
  assert.deepEqual(summary.files.map(file => file.path), ['new.txt', 'tracked.txt']);
  await f.changes.undo(f.session, 1, { revision: 1, request_id: 'git' });
  assert.equal(await readFile(join(cwd, 'tracked.txt'), 'utf8'), 'already dirty');
  const { stdout } = await exec('git', ['-C', cwd, 'show', ':tracked.txt'], { windowsHide: true }); assert.equal(stdout, 'original');
});
test('plain directories exclude dependencies/builds and apply nested gitignore files', async t => {
  const f = await fixture(t); await mkdir(join(f.session.workspace, 'node_modules')); await mkdir(join(f.session.workspace, 'src'));
  await f.write('.gitignore', '*.log\n*.txt\n'); await f.write('src/.gitignore', '!keep.txt\n');
  await f.changes.begin(f.session, 1);
  await f.write('node_modules/dependency.js', 'build'); await f.write('src/secret.txt', 'secret'); await f.write('src/keep.txt', 'included'); await f.write('trace.log', 'noise'); await f.write('src/main.js', 'code');
  const summary = await f.changes.finish(f.session, 1); assert.deepEqual(summary.files.map(file => file.path), ['src/keep.txt', 'src/main.js']);
});
test('default chats are isolated; changing preference affects only new chats; migration preserves snapshots and undo', async t => {
  const f = await fixture(t); const other = await f.workspaces.bind('user:1', 'chat:2');
  assert.notEqual(other.path, f.session.workspace); assert.equal((await f.workspaces.bind('user:1', 'chat:1')).path, f.session.workspace);
  await f.write('a.txt', 'before'); await f.write('.hidden', 'also move');
  await mkdir(join(f.session.workspace, 'empty-folder'));
  await f.changes.begin(f.session, 1); await f.write('a.txt', 'after'); await f.changes.finish(f.session, 1);
  const old = f.session.workspace, newRoot = join(f.root, 'new-default');
  await f.workspaces.update('user:1', newRoot, false);
  assert.equal(f.workspaces.pathFor(f.session.workspaceId), old);
  const next = await f.workspaces.bind('user:1', 'chat:3'); assert.ok(next.path.startsWith(newRoot));
  await f.workspaces.update('user:1', newRoot, true);
  assert.notEqual(f.session.workspace, old); await assert.rejects(access(old));
  assert.equal(await readFile(join(f.session.workspace, '.hidden'), 'utf8'), 'also move');
  await access(join(f.session.workspace, 'empty-folder'));
  const restarted = new Workspaces(f.workspaces.root, f.workspaces.defaultRoot, () => f.sessions); await restarted.initialize();
  const changes = new WorkspaceChanges(f.changes.root, restarted);
  await changes.undo(f.session, 1, { revision: 1, request_id: 'after-move' });
  assert.equal(await readFile(join(f.session.workspace, 'a.txt'), 'utf8'), 'before');
});
test('running roots/children and background commands block migration and undo; overlapping and occupied destinations are rejected', async t => {
  const f = await fixture(t); await f.changes.begin(f.session, 1); await f.write('a', 'after'); await f.changes.finish(f.session, 1);
  f.session.status = 'running';
  await assert.rejects(f.changes.undo(f.session, 1, { revision: 1, request_id: 'busy' }), /workspace_is_running/);
  await assert.rejects(f.workspaces.update('user:1', join(f.root, 'new'), true), /workspace_is_running/);
  f.session.status = 'idle'; f.session.backgroundCommands = new Set(['job']);
  await assert.rejects(f.changes.undo(f.session, 1, { revision: 1, request_id: 'busy' }), /background/);
  f.session.backgroundCommands.clear();
  await assert.rejects(f.workspaces.update('user:1', join(f.session.workspace, 'nested'), true), /overlap/);
  const newRoot = join(f.root, 'occupied'), destination = join(newRoot, digest('user:1').slice(0, 16), digest('chat:1').slice(0, 32));
  await mkdir(destination, { recursive: true }); await writeFile(join(destination, 'user.txt'), 'retain');
  await assert.rejects(f.workspaces.update('user:1', newRoot, true), /target_exists/);
  assert.equal(await readFile(join(destination, 'user.txt'), 'utf8'), 'retain');
});
test('interrupted undo journal completes safely on restart and never overwrites an unrelated edit', async t => {
  const f = await fixture(t); await f.write('a', 'old'); await f.changes.begin(f.session, 1); await f.write('a', 'new'); await f.changes.finish(f.session, 1);
  const path = f.changes.path(f.session, 1), record = await jsonFile(path); record.state = 'undoing'; await atomicWrite(path, record);
  await f.changes.recover(); assert.equal((await f.changes.summary(f.session, 1)).state, 'undone'); assert.equal(await readFile(join(f.session.workspace, 'a'), 'utf8'), 'old');
  await f.changes.begin(f.session, 2); await f.write('a', 'next'); await f.changes.finish(f.session, 2);
  const second = await jsonFile(f.changes.path(f.session, 2)); second.state = 'undoing'; await atomicWrite(f.changes.path(f.session, 2), second); await f.write('a', 'user');
  await f.changes.recover(); assert.equal((await f.changes.summary(f.session, 2)).state, 'recovery_required'); assert.equal(await readFile(join(f.session.workspace, 'a'), 'utf8'), 'user');
});
test('unfinished migration rolls back owned target copies and preserves original files after restart', async t => {
  const f = await fixture(t); await f.write('a', 'source');
  const destination = join(f.root, 'interrupted-target'); await mkdir(destination); await writeFile(join(destination, 'a'), 'source');
  const captured = await snapshot(f.session.workspace, undefined, { all: true });
  await atomicWrite(f.workspaces.journal, { version: 1, state: 'copying', previous: f.workspaces.registry, user: 'user:1', root: join(f.root, 'new'),
    entries: [{ id: f.session.workspaceId, source: f.session.workspace, destination, snapshot: captured }] });
  await f.workspaces.initialize(); await assert.rejects(access(destination)); assert.equal(await readFile(join(f.session.workspace, 'a'), 'utf8'), 'source');
});
test('migration recovery preserves externally changed target files and reports their retained directory', async t => {
  const f = await fixture(t); await f.write('a', 'source');
  const destination = join(f.root, 'modified-target'); await mkdir(destination); await writeFile(join(destination, 'a'), 'external edit');
  const captured = await snapshot(f.session.workspace, undefined, { all: true });
  await atomicWrite(f.workspaces.journal, { version: 1, state: 'copying', previous: f.workspaces.registry, user: 'user:1', root: join(f.root, 'new'),
    entries: [{ id: f.session.workspaceId, source: f.session.workspace, destination, snapshot: captured }] });
  await f.workspaces.initialize();
  assert.equal(await readFile(join(destination, 'a'), 'utf8'), 'external edit');
  assert.equal(await readFile(join(f.session.workspace, 'a'), 'utf8'), 'source');
  assert.deepEqual(f.workspaces.settings('user:1').retained_paths, [destination]);
});
test('path traversal and a symlink replacing a recorded file cannot redirect undo outside the workspace', async t => {
  const f = await fixture(t), outside = join(f.root, 'external-directory');
  await mkdir(outside); await writeFile(join(outside, 'retain.txt'), 'outside'); await f.write('a', 'old'); await f.changes.begin(f.session, 1); await f.write('a', 'new'); await f.changes.finish(f.session, 1);
  await assert.rejects(f.changes.diff(f.session, 1, '../a'), /not_found/);
  await rm(join(f.session.workspace, 'a'));
  try { await symlink(outside, join(f.session.workspace, 'a'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Host does not allow file symlinks'); return; } throw error; }
  const result = await f.changes.undo(f.session, 1, { revision: 1, request_id: 'link' });
  assert.deepEqual(result.conflicts, ['a']); assert.equal(await readFile(join(outside, 'retain.txt'), 'utf8'), 'outside');
});
test('undo restores read-only files and removes read-only files newly added by commands', async t => {
  const f = await fixture(t); await f.write('existing', 'original');
  await f.changes.begin(f.session, 1); await f.write('existing', 'after'); await f.write('added', 'new');
  await chmod(join(f.session.workspace, 'existing'), 0o444); await chmod(join(f.session.workspace, 'added'), 0o444);
  await f.changes.finish(f.session, 1); await f.changes.undo(f.session, 1, { revision: 1, request_id: 'readonly' });
  assert.equal(await readFile(join(f.session.workspace, 'existing'), 'utf8'), 'original');
  await assert.rejects(access(join(f.session.workspace, 'added')));
});
test('failed restore compensates earlier files and leaves the turn unchanged', async t => {
  const f = await fixture(t); await f.write('a', 'old a'); await f.write('b', 'old b');
  await f.changes.begin(f.session, 1); await f.write('a', 'new a'); await f.write('b', 'new b'); await f.changes.finish(f.session, 1);
  const record = await jsonFile(f.changes.path(f.session, 1));
  await rm(join(f.changes.blobs, record.before.files.b.hash));
  await assert.rejects(f.changes.undo(f.session, 1, { revision: 1, request_id: 'failure' }), /ENOENT/);
  assert.equal(await readFile(join(f.session.workspace, 'a'), 'utf8'), 'new a');
  assert.equal(await readFile(join(f.session.workspace, 'b'), 'utf8'), 'new b');
  assert.equal((await f.changes.summary(f.session, 1)).state, 'ready');
});
