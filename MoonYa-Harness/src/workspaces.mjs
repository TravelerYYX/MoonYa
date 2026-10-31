import { join, resolve, isAbsolute } from 'node:path';
import { mkdir, rm, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { atomicWrite, jsonFile, digest, snapshot, restore, safePath, samePath, inside, equalFile, removeCapturedTree } from './workspace-files.mjs';

/** Stable bindings separate a chat's identity from its movable default directory. */
export class Workspaces {
  constructor(root, defaultRoot, sessions = () => []) {
    this.root = root; this.defaultRoot = resolve(defaultRoot); this.sessions = sessions;
    this.path = join(root, 'registry.json'); this.journal = join(root, 'migration.json');
    this.registry = { version: 1, preferences: {}, bindings: {} };
    this.chain = Promise.resolve(); this.mutating = false; this.blockedRoots = [];
  }
  async initialize() {
    this.registry = await jsonFile(this.path, this.registry);
    await this.recoverMigration();
  }
  async exclusive(operation) {
    const run = this.chain.then(async () => { this.mutating = true; this.blockedRoots = []; try { return await operation(); } finally { this.mutating = false; this.blockedRoots = []; } });
    this.chain = run.catch(() => {}); return run;
  }
  assertAvailable(root) { if (root && this.blockedRoots.some(blocked => inside(blocked, root) || inside(root, blocked))) throw new Error('workspace_operation_in_progress'); }
  assertIdle(root) {
    for (const session of this.sessions()) {
      if (inside(root, session.workspace) || inside(session.workspace, root)) {
        if (session.status === 'running' || session.turnPromise || session.messageAdmission || session.workspacePreparing)
          throw new Error('workspace_is_running');
        // Finite and persistent background host commands may outlive an AI turn.
        if (session.backgroundCommands?.size) throw new Error('workspace_has_background_commands');
      }
    }
  }
  settings(user) {
    return { root: this.registry.preferences[user] || this.defaultRoot,
      retained_paths: this.registry.retainedPaths?.[user] || [],
      workspaces: Object.values(this.registry.bindings).filter(binding => binding.user === user).map(binding => ({ id: binding.id, path: binding.path })) };
  }
  async bind(user, chat) {
    return this.exclusive(async () => {
      const id = digest(user + '\0' + chat);
      let binding = this.registry.bindings[id];
      if (!binding) {
        const root = this.settings(user).root;
        const path = join(root, digest(user).slice(0, 16), digest(chat).slice(0, 32));
        await safePath(path); await mkdir(path, { recursive: true });
        binding = { id, user, chat, path };
        this.registry.bindings[id] = binding;
        try { await atomicWrite(this.path, this.registry); } catch (error) { delete this.registry.bindings[id]; throw error; }
      }
      await safePath(binding.path); await mkdir(binding.path, { recursive: true });
      return binding;
    });
  }
  pathFor(id) { const binding = this.registry.bindings[id]; if (!binding) throw new Error('workspace_binding_not_found'); return binding.path; }
  async update(user, target, migrate = false) {
    if (typeof target !== 'string' || !isAbsolute(target.trim())) throw new Error('workspace_root_must_be_absolute');
    const root = resolve(target.trim());
    await safePath(root);
    if (inside(root, this.root) || inside(this.root, root)) throw new Error('workspace_root_overlaps_runtime_data');
    return this.exclusive(async () => {
      if (migrate) this.blockedRoots = this.settings(user).workspaces.map(binding => binding.path);
      await this.recoverMigration();
      const previous = structuredClone(this.registry);
      if (!migrate) {
        await mkdir(root, { recursive: true });
        this.registry.preferences[user] = root;
        try { await atomicWrite(this.path, this.registry); } catch (error) { this.registry = previous; throw error; }
        return this.settings(user);
      }
      const bindings = Object.values(this.registry.bindings).filter(binding => binding.user === user);
      const entries = [];
      for (const binding of bindings) {
        this.assertIdle(binding.path);
        const destination = join(root, digest(user).slice(0, 16), digest(binding.chat).slice(0, 32));
        if (samePath(destination, binding.path)) continue;
        this.blockedRoots.push(destination); this.assertIdle(destination);
        if (inside(binding.path, destination) || inside(destination, binding.path)) throw new Error('workspace_migration_paths_overlap');
        for (const other of Object.values(this.registry.bindings)) if (inside(other.path, destination) || inside(destination, other.path)) throw new Error('workspace_migration_paths_overlap');
        await safePath(destination);
        if (await exists(destination)) throw new Error('workspace_migration_target_exists: ' + destination);
        entries.push({ id: binding.id, source: binding.path, destination });
      }
      const journal = { version: 1, id: randomUUID(), state: 'copying', user, root, previous, entries };
      await atomicWrite(this.journal, journal);
      const blobs = join(this.root, 'migration-blobs');
      try {
        for (const entry of entries) {
          entry.snapshot = await snapshot(entry.source, blobs, { all: true });
          await atomicWrite(this.journal, journal);
          await mkdir(entry.destination, { recursive: true });
          for (const name of entry.snapshot.directories || []) await mkdir(await safePath(entry.destination, name), { recursive: true });
          for (const [name, file] of Object.entries(entry.snapshot.files)) await restore(entry.destination, name, file, blobs);
          // Include ignored files and .git, and reject source changes during the copy.
          const destination = await snapshot(entry.destination, undefined, { all: true });
          const source = await snapshot(entry.source, undefined, { all: true });
          if (!sameSnapshot(entry.snapshot, destination) || !sameSnapshot(entry.snapshot, source)) throw new Error('workspace_migration_verification_failed');
        }
        for (const entry of entries) this.registry.bindings[entry.id].path = entry.destination;
        this.registry.preferences[user] = root;
        await atomicWrite(this.path, this.registry);
        journal.state = 'committed'; await atomicWrite(this.journal, journal);
        this.rebindSessions();
        await this.cleanupMigration(journal);
        return this.settings(user);
      } catch (error) {
        // Once registry commit is durable, recovery must finish cleanup rather than reverse bindings.
        const saved = await jsonFile(this.path);
        if (entries.some(entry => saved?.bindings[entry.id]?.path === entry.destination)) {
          this.registry = saved; journal.state = 'committed'; await atomicWrite(this.journal, journal); this.rebindSessions();
          throw new Error('workspace_migration_cleanup_pending: ' + error.message);
        }
        this.registry = previous;
        await this.rollbackMigration(journal);
        throw error;
      }
    });
  }
  rebindSessions() {
    for (const session of this.sessions()) if (session.workspaceId) {
      session.workspace = this.pathFor(session.workspaceId);
      // Runtime tool paths and child contexts use this binding, not Foundation's historic cwd.
    }
  }
  async cleanupMigration(journal) {
    const retained = [];
    for (const entry of journal.entries) {
      if (!await exists(entry.source)) continue;
      // Checked absolute, registry-owned leaf paths only; never delete the selected root.
      await safePath(entry.source);
      if (samePath(entry.source, journal.previous.preferences[journal.user] || this.defaultRoot)) throw new Error('workspace_migration_invalid_source');
      if (!await removeCapturedTree(entry.source, entry.snapshot)) retained.push(entry.source);
    }
    this.registry.retainedPaths ||= {}; this.registry.retainedPaths[journal.user] = retained;
    await atomicWrite(this.path, this.registry);
    await rm(this.journal, { force: true }); await rm(join(this.root, 'migration-blobs'), { recursive: true, force: true });
  }
  async rollbackMigration(journal) {
    const retained = [];
    for (const entry of journal.entries) {
      // A destination created by us can only be removed when its content is our captured content.
      if (await exists(entry.destination)) {
        if (!await removeCapturedTree(entry.destination, entry.snapshot || { files: {} })) retained.push(entry.destination);
      }
    }
    this.registry.retainedPaths ||= {}; this.registry.retainedPaths[journal.user] = retained;
    await atomicWrite(this.path, this.registry);
    await rm(this.journal, { force: true }); await rm(join(this.root, 'migration-blobs'), { recursive: true, force: true });
  }
  async recoverMigration() {
    const journal = await jsonFile(this.journal); if (!journal) return;
    const committed = journal.state === 'committed' || journal.entries.some(entry => this.registry.bindings[entry.id]?.path === entry.destination);
    if (committed) { this.rebindSessions(); await this.cleanupMigration(journal); }
    else await this.rollbackMigration(journal);
  }
}
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
const sameSnapshot = (a, b) => JSON.stringify(a.directories || []) === JSON.stringify(b.directories || []) && Object.keys(a.files).length === Object.keys(b.files).length && Object.entries(a.files).every(([name, file]) => equalFile(file, b.files[name]));
