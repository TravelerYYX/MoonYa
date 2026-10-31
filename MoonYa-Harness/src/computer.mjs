import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

let cellQueue = Promise.resolve();
export async function desktopRequest(context, action, args = {}) {
  const response = await fetch(`${context.localServiceUrl}/desktop/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-moonya-host-token': process.env.MOONYA_DESKTOP_HOST_TOKEN || '' },
    body: JSON.stringify({ ...args, session_id: context.session.id }),
    signal: context.signal,
  });
  const result = await response.json();
  if (!response.ok || result.success === false) throw Object.assign(new Error(result.error || result.message || `Desktop HTTP ${response.status}`), { code: result.error_code });
  return result;
}

export async function closeDesktop(context) {
  if (!context.session.desktopActive) return;
  // Cleanup must not inherit an already-aborted turn signal.
  try { return await desktopRequest({ ...context, signal: AbortSignal.timeout(10000) }, 'stop'); }
  catch { /* Host idle watchdog is the final cleanup backstop. */ }
  finally { context.session.desktopActive = false; }
}

export async function executeComputerCell(args, context) {
  if (!context.session.desktopSkillLoaded || !context.session.desktopCompatibilityLoaded) {
    return { success: false, error_code: 'desktop_skill_required', error: 'Read computer-use-automation SKILL.md and references/moonya-runtime.md before executing desktop cells.' };
  }
  if (args.plane !== 'cu' || !String(args.code || '').trim() || !String(args.title || '').trim()) {
    return { success: false, error_code: 'invalid_desktop_cell', error: 'Require plane=cu, code and title.' };
  }
  const previous = cellQueue;
  let release;
  cellQueue = new Promise(resolve => { release = resolve; });
  try {
    await previous;
    context.signal?.throwIfAborted();
    const desktop = await desktopRequest(context, 'start');
    context.session.desktopActive = true;
    await context.onDesktop?.({ session_id: context.session.id, title: args.title, display: desktop.display });
    return await runCell(args, context);
  } finally { release(); }
}

function runCell(args, context) {
  return new Promise((resolve, reject) => {
    const python = process.env.MOONYA_DESKTOP_PYTHON;
    if (!python) return reject(new Error('Bundled desktop Python is not configured.'));
    const runner = process.env.MOONYA_DESKTOP_RUNNER || fileURLToPath(new URL('./computer_python/runner.py', import.meta.url));
    const child = spawn(python, ['-u', runner], {
      cwd: context.workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let result, stderr = '', protocolError, pending = Promise.resolve();
    const screenshots = [];
    let screenshotBytes = 0;
    const cellAbort = new AbortController();
    const rpcContext = { ...context, signal: cellAbort.signal };
    const operationId = randomUUID();
    const fail = error => { protocolError = error; cellAbort.abort(error); child.kill(); };
    const timeout = setTimeout(() => fail(new Error('Desktop cell exceeded 5 minutes. Execution state may be unknown; observe before retrying.')), 300000);
    const abort = () => fail(context.signal.reason || new Error('Desktop cell cancelled'));
    context.signal?.addEventListener('abort', abort, { once: true });
    if (context.signal?.aborted) abort();
    child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-16000); });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      pending = pending.then(async () => {
        const message = JSON.parse(line);
        if (message.kind === 'result') { result = message.result; return; }
        if (message.kind !== 'rpc') throw new Error('Invalid desktop Python protocol');
        let reply;
        try {
          reply = await desktopRequest(rpcContext, 'rpc', { method: message.method, args: message.args, operation_id: `${operationId}:${message.id}` });
          if (message.method === 'screenshot' && reply.image) {
            screenshotBytes += Buffer.byteLength(reply.image, 'base64');
            if (screenshots.length >= 16 || screenshotBytes > 32 * 1024 * 1024) throw new Error('Desktop cell screenshot limit exceeded (16 frames or 32 MiB).');
            screenshots.push({ image: reply.image, tag: message.args.tag, display: reply.display });
          }
        } catch (error) { reply = { success: false, error_code: error.code || 'desktop_rpc_failed', error: error.message }; }
        if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({ id: message.id, result: reply }) + '\n');
      }).catch(fail);
    });
    child.on('error', error => { protocolError = error; });
    child.on('close', async code => {
      clearTimeout(timeout); context.signal?.removeEventListener('abort', abort); lines.close();
      await pending;
      // No held inputs survive a cell, including exceptions and cancellation.
      await desktopRequest({ ...context, signal: AbortSignal.timeout(5000) }, 'release').catch(() => {});
      if (protocolError) return reject(protocolError);
      resolve({ ...(result || { success: false, error_code: 'desktop_python_failed', error: stderr || `Python exit ${code}` }), screenshots, title: args.title });
    });
    child.stdin.write(JSON.stringify({ code: args.code }) + '\n');
  });
}
