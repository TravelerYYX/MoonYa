'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

class FakePort {
    constructor() {
        this.messages = [];
        this.onmessage = null;
    }
    postMessage(message) { this.messages.push(JSON.parse(JSON.stringify(message))); }
    start() {}
    close() {}
    send(message) { this.onmessage({ data: message }); }
    response(requestId) {
        return this.messages.findLast(message => message.type === 'response' && message.requestId === requestId);
    }
}

const workerPath = path.join(__dirname, '../../MoonYa-Frontend/src', 'workers', 'conversation-runtime-worker.js');
const sandbox = { Set, Map, Math, Number, String, Object, Array, JSON };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(workerPath, 'utf8'), sandbox, { filename: workerPath });

const main = new FakePort();
const popout = new FakePort();
sandbox.onconnect({ ports: [main] });
sandbox.onconnect({ ports: [popout] });

main.send({ action: 'start', requestId: 'start-a', clientId: 'main', conversationId: 11, clientMessageId: 'message-a' });
assert(main.response('start-a').ok === true, 'first task should acquire conversation 11');

popout.send({ action: 'start', requestId: 'duplicate-a', clientId: 'popout', conversationId: 11, clientMessageId: 'message-b' });
assert(popout.response('duplicate-a').ok === false, 'second task in the same conversation must be rejected');

popout.send({ action: 'start', requestId: 'start-b', clientId: 'popout', conversationId: 12, clientMessageId: 'message-c' });
assert(popout.response('start-b').ok === true, 'different conversations must run concurrently');

popout.send({ action: 'stop', requestId: 'wrong-stop', clientId: 'popout', conversationId: 11, clientMessageId: 'message-b' });
assert(popout.response('wrong-stop').data.phase === 'running', 'stale client id must not stop another task');

popout.send({ action: 'stop', requestId: 'right-stop', clientId: 'popout', conversationId: 11, clientMessageId: 'message-a' });
assert(popout.response('right-stop').data.lastTerminalStatus === 'cancelled', 'either window should stop the matching task');
assert(popout.response('right-stop').data.unreadTerminal === true, 'terminal state should become unread');

main.send({ action: 'finish', requestId: 'late-finish', clientId: 'main', conversationId: 11, clientMessageId: 'message-a', status: 'completed' });
assert(main.response('late-finish').data.lastTerminalStatus === 'cancelled', 'late finish must not overwrite cancellation');

main.send({ action: 'markViewed', requestId: 'view-a', clientId: 'main', conversationId: 11 });
assert(main.response('view-a').data.unreadTerminal === false, 'markViewed should clear the shared terminal indicator');

popout.send({
    action: 'patchComposer', requestId: 'composer-b', clientId: 'popout', conversationId: 12,
    patch: { draft: 'second window draft', composer: { reasoningEffort: 'xhigh', projectName: 'Demo' } }
});
main.send({ action: 'activate', requestId: 'activate-b', clientId: 'main', conversationId: 12 });
const activated = main.response('activate-b').data;
assert(activated.composer.draft === 'second window draft', 'draft should synchronize through the worker');
assert(activated.composer.composer.projectName === 'Demo', 'composer context should synchronize through the worker');

main.send({
    action: 'recover', requestId: 'recover-b', clientId: 'main', conversationId: 12,
    clientMessageId: 'message-c', attempt: 3, maxAttempts: 5, error: 'unexpected EOF'
});
const recovering = main.response('recover-b').data;
assert(recovering.phase === 'recovering', 'unexpected EOF must keep the shared task active in recovering');
assert(recovering.reconnectAttempt === 3 && recovering.reconnectMax === 5, 'reconnect progress must be shared');

main.send({
    action: 'reconnected', requestId: 'reconnected-b', clientId: 'main', conversationId: 12,
    clientMessageId: 'message-c'
});
assert(main.response('reconnected-b').data.phase === 'running', 'successful reconnect must resume running');

main.send({
    action: 'finish', requestId: 'failed-b', clientId: 'main', conversationId: 12,
    clientMessageId: 'message-c', status: 'failed'
});
assert(main.response('failed-b').data.lastTerminalStatus === 'failed', 'explicit reconnect failure must become failed');

// Approval waits stay active, survive recovery and are visible to another window.
main.send({ action: 'start', requestId: 'start-approval', conversationId: 13, clientMessageId: 'approval-message', runId: 'session-13' });
const required = { event: 'approval.required', run_id: 'session-13', conversation_id: 13,
    payload: { id: 'approval-1', status: 'pending', expires_at: '2030-01-01T00:10:00Z' } };
main.send({ action: 'streamEvent', requestId: 'approval-required', conversationId: 13,
    clientMessageId: 'approval-message', runId: 'session-13', event: required });
popout.send({ action: 'activate', requestId: 'approval-snapshot', conversationId: 13 });
assert(popout.response('approval-snapshot').data.phase === 'waiting_approval', 'approval must enter waiting phase');
assert(popout.response('approval-snapshot').data.pendingApprovals[0].payload.expires_at === required.payload.expires_at, 'another window must retain the server deadline');
main.send({ action: 'streamEvent', requestId: 'approval-replay', conversationId: 13, clientMessageId: 'approval-message', event: required });
main.send({ action: 'recover', requestId: 'approval-recover', conversationId: 13, clientMessageId: 'approval-message' });
main.send({ action: 'reconnected', requestId: 'approval-reconnected', conversationId: 13, clientMessageId: 'approval-message' });
assert(main.response('approval-reconnected').data.phase === 'waiting_approval', 'reconnection must restore waiting phase');
assert(main.response('approval-reconnected').data.pendingApprovals.length === 1, 'replayed requests must not duplicate approvals');
main.send({ action: 'streamEvent', requestId: 'approval-decided', conversationId: 13, event: {
    event: 'approval.decided', payload: { approval_id: 'approval-1', status: 'allowed' }
} });
popout.send({ action: 'activate', requestId: 'approval-cleared', conversationId: 13 });
assert(popout.response('approval-cleared').data.phase === 'running', 'decision must resume running');
assert(popout.response('approval-cleared').data.pendingApprovals.length === 0, 'settled approvals must be removed');
main.send({ action: 'streamEvent', requestId: 'stale-approval', conversationId: 13, clientMessageId: 'old-message', event: required });
popout.send({ action: 'activate', requestId: 'stale-checked', conversationId: 13 });
assert(popout.response('stale-checked').data.pendingApprovals.length === 0, 'stale turns must not restore an approval');
main.send({ action: 'streamEvent', requestId: 'decided-replayed', conversationId: 13, event: required });
popout.send({ action: 'activate', requestId: 'decided-replay-checked', conversationId: 13 });
assert(popout.response('decided-replay-checked').data.pendingApprovals.length === 0, 'replaying a settled request must not reopen it');
const secondRequired = { ...required, payload: { ...required.payload, id: 'approval-2' } };
main.send({ action: 'streamEvent', requestId: 'approval-required-again', conversationId: 13, event: secondRequired });
main.send({ action: 'stop', requestId: 'approval-stop', conversationId: 13 });
assert(main.response('approval-stop').data.pendingApprovals.length === 0, 'stop must clear approval state');
main.send({ action: 'approvalSnapshot', requestId: 'fresh-approval-snapshot', conversationId: 14,
    runId: 'session-14', running: true, pendingApprovals: [required] });
assert(main.response('fresh-approval-snapshot').data.phase === 'waiting_approval', 'server snapshot must recover a fresh window');
main.send({ action: 'approvalSnapshot', requestId: 'different-session-snapshot', conversationId: 14,
    runId: 'old-session', running: false, pendingApprovals: [] });
assert(main.response('different-session-snapshot').data.pendingApprovals.length === 1, 'snapshot from another session must not overwrite the current task');

main.send({ action: 'approvalSnapshot', requestId: 'restored-task-finished', conversationId: 14,
    runId: 'session-14', running: false, status: 'completed', pendingApprovals: [] });
assert(main.response('restored-task-finished').data.phase === 'idle', 'a recovered task must leave waiting/running when Runtime finishes');
assert(main.response('restored-task-finished').data.lastTerminalStatus === 'completed', 'server completion must be preserved');

console.log('conversation runtime worker: PASS');
