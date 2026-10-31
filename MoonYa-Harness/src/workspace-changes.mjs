// MoonYa persistent adaptation of DeepSeek's per-session TurnRecorder design.
// Scope is a turn's workspace net changes, including concurrent external edits.
import { join, dirname } from 'node:path';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { atomicWrite, jsonFile, snapshot, capture, restore, safePath, equalFile, digest } from './workspace-files.mjs';
import { compareText } from './workspace-compare.mjs';
const TEXT_LIMIT = 2 * 1024 * 1024;
export class WorkspaceChanges {
  constructor(root, workspaces) { this.root = root; this.blobs = join(root, 'blobs'); this.workspaces = workspaces; this.queues = new Map(); this.previews = new Map(); }
  path(session, turn) {
    if (!Number.isSafeInteger(turn) || turn < 1) throw new Error('invalid_turn');
    return join(this.root, 'turns', digest(session.id), turn + '.json');
  }
  async queued(session, operation) {
    const next = (this.queues.get(session.id) || Promise.resolve()).then(operation);
    this.queues.set(session.id, next.catch(() => {}));
    return next;
  }
  async begin(session, turn) {
    return this.queued(session, async () => {
      this.previews.delete(session.id);
      const before = await snapshot(session.workspace, this.blobs, { excludedRoots: [dirname(this.root)] });
      await atomicWrite(this.path(session, turn), { version: 1, revision: 1, session_id: session.id, turn,
        workspace_id: session.workspaceId || null, root: session.workspace, state: 'recording', before });
    });
  }
  async finish(session, turn) {
    return this.queued(session, async () => {
      const path = this.path(session, turn), record = await jsonFile(path);
      if (!record || record.state !== 'recording') return record ? this.public(record) : null;
      const root = this.rootOf(record), after = await snapshot(root, this.blobs, { excludedRoots: [dirname(this.root)] });
      record.files = await this.changedFiles(record.before, after);
      record.after = after; record.state = 'ready'; record.completed_at = new Date().toISOString();
      await atomicWrite(path, record); this.previews.delete(session.id);
      return this.public(record);
    });
  }
  async changedFiles(before, after) {
      const names = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort();
      const files = [];
      for (const name of names) {
        const beforeFile = before.files[name], afterFile = after.files[name];
        if (equalFile(beforeFile, afterFile)) continue;
        const diff = await this.compare(beforeFile, afterFile);
        files.push({ id: digest(name), path: name, display: name.replaceAll('\\', '/'),
          kind: !beforeFile ? 'added' : !afterFile ? 'deleted' : 'modified',
          added: diff.added ?? null, deleted: diff.deleted ?? null, binary: diff.kind === 'binary', oversized: diff.kind === 'oversized', coarse: !!diff.coarse });
      }
      return files;
  }
  async preview(session, turn) {
    return this.queued(session, async () => {
      const record = await jsonFile(this.path(session, turn));
      if (!record || record.state !== 'recording') return record ? this.public(record) : null;
      const after = await snapshot(this.rootOf(record), this.blobs, { excludedRoots: [dirname(this.root)] });
      const preview = { ...record, after, files: await this.changedFiles(record.before, after) };
      this.previews.set(session.id, preview);
      return this.public(preview);
    });
  }
  rootOf(record) { return record.workspace_id ? this.workspaces.pathFor(record.workspace_id) : record.root; }
  public(record) {
    return { version: 1, session_id: record.session_id, turn: record.turn, revision: record.revision,
      state: record.state, files: record.files || [], total: record.files?.length || 0,
      added: (record.files || []).reduce((sum, file) => sum + (file.added || 0), 0),
      deleted: (record.files || []).reduce((sum, file) => sum + (file.deleted || 0), 0), scope: 'workspace_net_changes' };
  }
  async summary(session, turn) { const record = await jsonFile(this.path(session, turn)); return record ? this.public(record) : null; }
  async compare(before, after) {
    if ([before, after].some(file => file?.size > TEXT_LIMIT)) return { kind: 'oversized' };
    const load = file => file ? readFile(join(this.blobs, file.hash)) : null;
    const [a, b] = await Promise.all([load(before), load(after)]);
    if ([a, b].some(bytes => bytes?.subarray(0, 8000).includes(0))) return { kind: 'binary' };
    return { kind: 'text', before: !!before, after: !!after, ...compareText(a?.toString('utf8') ?? null, b?.toString('utf8') ?? null) };
  }
  async diff(session, turn, fileId) {
    return this.queued(session, async () => {
      let record = await jsonFile(this.path(session, turn));
      if (record?.state === 'recording' && this.previews.get(session.id)?.turn === turn) record = this.previews.get(session.id);
      const file = record?.files?.find(item => item.id === fileId);
      if (!file) throw new Error('change_file_not_found');
      return { path: file.path, ...await this.compare(record.before.files[file.path], record.after.files[file.path]) };
    });
  }
  async undo(session, turn, input) {
    return this.queued(session, () => this.workspaces.exclusive(async () => {
      const path = this.path(session, turn), record = await jsonFile(path);
      if (!record) throw new Error('change_record_not_found');
      if (!input.request_id || typeof input.request_id !== 'string' || input.request_id.length > 100) throw new Error('invalid_request_id');
      if (record.state === 'undone') return this.public(record);
      if (record.state !== 'ready' || input.revision !== record.revision) throw new Error('change_record_not_ready');
      const root = this.rootOf(record);
      this.workspaces.blockedRoots.push(root);
      this.workspaces.assertIdle(root);
      const conflicts = [];
      for (const file of record.files) {
        try {
          const current = await capture(await safePath(root, file.path));
          if (!equalFile(current, record.after.files[file.path])) conflicts.push(file.path);
        } catch { conflicts.push(file.path); }
      }
      if (conflicts.length) return { ...this.public(record), error: 'undo_conflict', conflicts };
      // Durable intent precedes the first write. Restart recovery completes this operation.
      record.state = 'undoing'; record.request_id = input.request_id;
      await atomicWrite(path, record);
      try {
        for (const file of record.files) {
          const current = await capture(await safePath(root, file.path));
          if (!equalFile(current, record.after.files[file.path])) throw new Error('undo_conflict_during_restore: ' + file.path);
          await restore(root, file.path, record.before.files[file.path], this.blobs);
        }
        record.state = 'undone'; record.revision++; record.undone_at = new Date().toISOString();
        await atomicWrite(path, record);
        return this.public(record);
      } catch (error) {
        // Compensate only files that still contain our restored bytes; never overwrite an outside edit.
        let recovered = true;
        for (const file of record.files) {
          try {
            const current = await capture(await safePath(root, file.path));
            if (equalFile(current, record.before.files[file.path])) await restore(root, file.path, record.after.files[file.path], this.blobs);
            else if (!equalFile(current, record.after.files[file.path])) recovered = false;
          } catch { recovered = false; }
        }
        record.state = recovered ? 'ready' : 'recovery_required'; record.error = error.message;
        await atomicWrite(path, record);
        throw error;
      }
    }));
  }
  async recover() {
    const turns = join(this.root, 'turns'); await mkdir(turns, { recursive: true });
    for (const sessionName of await readdir(turns)) {
      for (const name of await readdir(join(turns, sessionName))) {
        if (!name.endsWith('.json')) continue;
        const path = join(turns, sessionName, name), record = await jsonFile(path);
        if (record.state !== 'undoing') continue;
        const root = this.rootOf(record);
        let safe = true;
        for (const file of record.files) {
          try { const current = await capture(await safePath(root, file.path)); if (!equalFile(current, record.before.files[file.path]) && !equalFile(current, record.after.files[file.path])) safe = false; }
          catch { safe = false; }
        }
        if (safe) {
          try { for (const file of record.files) await restore(root, file.path, record.before.files[file.path], this.blobs); record.state = 'undone'; record.revision++; }
          catch { record.state = 'recovery_required'; }
        } else record.state = 'recovery_required';
        await atomicWrite(path, record);
      }
    }
  }
}
