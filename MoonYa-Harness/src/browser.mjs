// Browser automation client for the Agent Runtime.
//
// The runtime drives the SAME loopback contract the delegated Browser Agent used
// (BrowserAutomationGateway.php / BrowserProtocol.cs), so the C# safety gate stays
// the single enforcement point: first-visit site approval, TLS certificate
// challenges and sensitive-action confirmation all still happen there.  This
// module only carries the request and mirrors the backend's action-level risk
// classification so the runtime reports the same effect/risk the UI already shows.

import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const DEFAULT_SERVICE_URL = 'http://127.0.0.1:58905';

export const BROWSER_EXECUTE_ROUTE = '/browser/execute';
export const BROWSER_AUTHORIZE_ROUTE = '/browser/authorize';
export const BROWSER_CANCEL_ROUTE = '/browser/cancel';

/** Public browser actions. Mirrors BrowserAutomationGateway::ACTIONS. */
export const BROWSER_ACTIONS = Object.freeze([
  'start', 'status', 'stop',
  'navigate', 'back', 'forward', 'reload',
  'inspect', 'screenshot',
  'click', 'fill', 'hover', 'press', 'select', 'check', 'uncheck',
  'scroll', 'wait',
  'new_tab', 'list_tabs', 'switch_tab', 'close_tab',
  'list_downloads',
]);

// Mirrors RiskPolicy::effectivePolicy for browser_automation_control.  The tool's
// declared risk is a single value, so the action decides read/write and level;
// this keeps confirmation timing identical to the delegated path.
const READ_ACTIONS = new Set(['screenshot', 'inspect', 'read', 'get_content']);
const HIGH_RISK_ACTIONS = new Set([
  'upload', 'submit_sensitive', 'purchase', 'payment',
  'send_credentials', 'confirm_payment',
]);

export function browserEffectAndRisk(action) {
  const normalized = String(action || '').trim().toLowerCase();
  if (READ_ACTIONS.has(normalized)) return { effect: 'read', riskLevel: 'low' };
  if (HIGH_RISK_ACTIONS.has(normalized)) return { effect: 'write', riskLevel: 'high' };
  return { effect: 'write', riskLevel: 'medium' };
}

function serviceUrl() {
  return (process.env.MOONYA_BROWSER_SERVICE_URL || DEFAULT_SERVICE_URL).replace(/\/$/, '');
}

function timeoutMs() {
  const configured = Number(process.env.MOONYA_BROWSER_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) {
    throw new Error('MOONYA_BROWSER_TIMEOUT_MS is missing or invalid');
  }
  return configured;
}

function unreachable(error) {
  return {
    success: false,
    error_code: 'browser_service_unreachable',
    error: `无法连接本机浏览器服务（${serviceUrl()}），请确认 MoonYa 桌面端正在运行且浏览器自动化已启动。`
      + (error ? ` 详情：${error}` : ''),
  };
}

function combineSignal(signal, timeout) {
  const timeoutSignal = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

async function postJson(path, payload, context) {
  const signal = combineSignal(context?.signal, timeoutMs());
  const response = await fetch(`${serviceUrl()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`browser service returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

/**
 * Execute one browser action against the loopback service.
 *
 * @param {object} args        Tool arguments (action plus action-specific fields).
 * @param {object} context     Runtime tool context; `userContext` scopes site trust.
 * @returns {Promise<object>}  The browser result with screenshot bytes retained
 *                             and optional saved-copy metadata added.
 */
export async function executeBrowser(args, context = {}) {
  const action = String(args?.action || '').trim().toLowerCase();
  if (!BROWSER_ACTIONS.includes(action)) {
    return {
      success: false,
      error_code: action === '' ? 'invalid_request' : 'unknown_action',
      error: action === '' ? '缺少浏览器 action。' : `未知浏览器 action: ${action}`,
    };
  }

  const payload = { ...args, action, operation_id: randomUUID() };
  if (context.userContext) payload.user_context = context.userContext;
  context.signal?.throwIfAborted();
  const cancel = () => {
    void postJson(BROWSER_CANCEL_ROUTE, {
      browser: args.browser || 'builtin', operation_id: payload.operation_id,
      user_context: context.userContext || '',
    }, {}).catch(() => {});
  };
  context.signal?.addEventListener('abort', cancel, { once: true });

  let result;
  try {
    result = await postJson(BROWSER_EXECUTE_ROUTE, payload, context);
  } catch (error) {
    if (context.signal?.aborted) throw context.signal.reason || error;
    if (String(error?.message || '').includes('MOONYA_BROWSER_TIMEOUT_MS')) {
      return { success: false, error_code: 'invalid_configuration', error: '浏览器客户端超时配置缺失或无效。' };
    }
    if (error?.name === 'TimeoutError') {
      cancel();
      return { success: false, error_code: 'timeout', error: `浏览器操作超时（${timeoutMs()}ms）: ${action}` };
    }
    if (error?.name === 'AbortError') throw error;
    return unreachable(error?.message || String(error));
  } finally {
    context.signal?.removeEventListener('abort', cancel);
  }
  if (!result || typeof result !== 'object') {
    return { success: false, error_code: 'invalid_response', error: '本机浏览器服务返回了无效响应。' };
  }

  // The runtime projects these bytes into image_url blocks, never tool text.
  // Saving a copy must not remove the model's visual observation.
  const screenshot = typeof result.screenshot === 'string' ? result.screenshot : '';
  if (screenshot) {
    result.screenshot_saved_to = await persistScreenshot(screenshot, args?.save_screenshot_to).catch(error => {
      result.screenshot_save_error = error?.message || String(error);
      return '';
    });
    result.screenshot_bytes = Math.floor((screenshot.length * 3) / 4);
  }
  return result;
}

async function persistScreenshot(base64, target) {
  if (!target) return '';
  const file = resolve(String(target));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, Buffer.from(base64, 'base64'));
  return file;
}

/**
 * Submit a site/TLS/sensitive authorization decision for a pending challenge.
 * Returns the raw authorize response so the caller can surface failures verbatim.
 */
export async function authorizeBrowser(payload, context = {}) {
  const body = { ...payload };
  if (context.userContext && !body.user_context) body.user_context = context.userContext;
  try {
    return await postJson(BROWSER_AUTHORIZE_ROUTE, body, context);
  } catch (error) {
    if (String(error?.message || '').includes('MOONYA_BROWSER_TIMEOUT_MS')) {
      return { success: false, error_code: 'invalid_configuration', error: '浏览器客户端超时配置缺失或无效。' };
    }
    if (error?.name === 'AbortError') throw error;
    return unreachable(error?.message || String(error));
  }
}

/** Human-readable reason shown on the approval card. */
export function describeChallenge(challenge) {
  const kind = String(challenge?.approval_kind || challenge?.error || 'site');
  const domain = String(challenge?.domain || challenge?.url || '');
  const reason = String(challenge?.reason || '').trim();
  if (reason) return `${reason}（${domain}）`;
  if (kind === 'tls') return `TLS 证书校验失败（${domain}）`;
  if (kind === 'sensitive') return `该操作属于敏感动作，需要单独确认（${domain}）`;
  return `首次访问该站点，需要用户授权（${domain}）`;
}
