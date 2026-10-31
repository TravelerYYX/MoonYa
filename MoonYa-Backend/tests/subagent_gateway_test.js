'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('PHP employee stream authorizes all children, preserves identities and never emits parent content/done', { timeout: 10000 }, async () => {
    const backend = path.join(__dirname, '..'), source = fs.readFileSync(path.join(backend, 'harness_api.php'), 'utf8');
    const functions = source.slice(source.indexOf('function employeeStreamCursors('), source.indexOf('function emitRuntimeEvent('));
    const events = [
        { session_id: 'a', seq: 1, event: 'tool.started', payload: { name: 'read_file', arguments: { path: 'fixture' } } },
        { session_id: 'b', seq: 1, event: 'assistant.message', payload: { content: '**child result**' } },
        { session_id: 'a', seq: 2, event: 'context.compacted', payload: { history: ['private checkpoint'] } },
        { session_id: 'a', seq: 2, event: 'tool.images', payload: { images: ['private image bytes'] } },
        { session_id: 'foreign', seq: 99, event: 'assistant.message', payload: { content: 'wrong branch' } },
        { session_id: 'a', seq: 3, event: 'turn.completed', payload: { content: 'child-only-final' } },
        { session_id: 'b', seq: 2, event: 'session.error', payload: { message: 'child failure' } },
    ];
    const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': heartbeat\n\n'); res.end(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('')); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const literal = value => "'" + value.replace(/\\/g, '/').replace(/'/g, "\\'") + "'";
    const program = `require ${literal(path.join(backend, 'Services/AgentRuntimeClient.php'))};
        class RuntimeBridgeException extends RuntimeException { public function __construct(string $message, string $code) { parent::__construct($message); } }
        function streamFlush(): void { flush(); }
        ${functions}
        $catalog = ['employees' => [['child_id'=>'a'], ['child_id'=>'b']]];
        if (employeeStreamCursors(['child_id'=>'a','after_seq'=>2], $catalog) !== ['a'=>2]) throw new Exception('single child resume failed');
        foreach (['{"foreign":0}', '{"a":-1}', '{"a":"1"}', '[]'] as $invalid) {
            $rejected = false; try { employeeStreamCursors(['children'=>$invalid], $catalog); } catch (Exception $e) { $rejected=true; }
            if (!$rejected) throw new Exception('invalid subscription accepted');
        }
        streamEmployeeEvents(new AgentRuntimeClient('http://127.0.0.1:${server.address().port}'), 'root', employeeStreamCursors(['children'=>'{"a":0,"b":0}'], $catalog));`;
    try {
        const child = spawn('php', ['-r', program], { windowsHide: true }); let output = '', errors = '';
        child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => errors += chunk);
        const timer = setTimeout(() => child.kill(), 5000); const exit = await new Promise(resolve => child.on('exit', resolve)); clearTimeout(timer);
        assert.equal(exit, 0, errors); assert.ok(output.includes(': heartbeat\n\n'));
        const records = output.split('\n\n').filter(frame => frame.startsWith('data: ')).map(frame => JSON.parse(frame.slice(6)));
        assert.equal(records.length, 4); assert.ok(records.every(event => event.type === 'subagent_event' && event.root_run_id === 'root'));
        assert.deepEqual(records.map(event => [event.run_id, event.seq]), [['a', 1], ['b', 1], ['a', 3], ['b', 2]]);
        assert.ok(!output.includes('wrong branch') && !output.includes('private checkpoint'));
        assert.ok(!records.some(event => ['content', 'done', 'error'].includes(event.type)));
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
