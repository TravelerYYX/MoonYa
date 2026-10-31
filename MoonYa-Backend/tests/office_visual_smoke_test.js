'use strict';

const fs = require('fs');
const path = require('path');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const root = path.join(__dirname, '..');
const layout = fs.readFileSync(path.join(root, '../MoonYa-Frontend/src', 'layouts', 'office-panel.html'), 'utf8');
const runtime = fs.readFileSync(path.join(root, '../MoonYa-Frontend/src', 'modules', 'script-5-office.js'), 'utf8');
const store = fs.readFileSync(path.join(root, '../MoonYa-Frontend/src', 'subagent-store.js'), 'utf8');
const stations = [...layout.matchAll(/class="workstation/g)].length;

assert(stations >= 1, 'static office has no workstations');
assert(layout.includes('id="officeStage"'), 'static office stage is missing');
assert(runtime.includes("querySelectorAll('.workstation')"), 'static workstation layout is missing');
assert(runtime.includes('store.watch(sessionId, projectPath') && store.includes('office_events') && store.includes('moonya:runtime-event'), 'office must consume authenticated Harness events through the shared store');
assert(!runtime.includes('moonya:team-event'), 'old PHP team runtime must stay removed');
assert(layout.includes('officeConcurrency') && layout.includes('officeEmployeeCard'), 'office controls are missing');
assert(!layout.includes("'key' => 'search'"), 'office must not render a fixed employee roster');
assert(!layout.includes('officeAgentCard'), 'interactive Agent profile card still exists');

console.log('office dynamic visual contract: PASS');
