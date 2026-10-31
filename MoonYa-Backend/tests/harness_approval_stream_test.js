const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const bridge = fs.readFileSync(path.join(root, 'harness_api.php'), 'utf8');
// Exercise the production bootstrap and forwarding callback with a short PHP
// execution limit. No model, desktop service, auth account or live task is used.
const bootstrap = bridge.slice(bridge.indexOf('SseStreamOutput::prepare();'), bridge.indexOf("require_once __DIR__ . '/Services/AgentRuntimeClient.php';"));
const forwarding = bridge.slice(bridge.indexOf('function streamRuntimeEvents('), bridge.indexOf('function resolveRuntimeModel('));

(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ event: 'approval.required', payload: { id: 'wait' } })}\n\n`);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 100);
    const finish = setTimeout(() => {
      clearInterval(heartbeat);
      res.end(`data: ${JSON.stringify({ event: 'turn.completed' })}\n\n`);
    }, 2200);
    req.on('close', () => { clearInterval(heartbeat); clearTimeout(finish); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const phpPath = value => "'" + value.replace(/\\/g, '/').replace(/'/g, "\\'") + "'";
  const program = `require ${phpPath(path.join(root, 'Services/SseStreamOutput.php'))};\n${bootstrap}
    require ${phpPath(path.join(root, 'Services/AgentRuntimeClient.php'))};
    const RUNTIME_TURN_TERMINAL_EVENTS = ['turn.completed'];
    function streamFlush(): void { SseStreamOutput::flush(); }
    function emitRuntimeEvent(array $event, string $sessionId): void {
      echo 'data: ' . json_encode($event) . "\\n\\n"; streamFlush();
    }
    ${forwarding}
    streamRuntimeEvents(new AgentRuntimeClient('http://127.0.0.1:${server.address().port}'), 'fixture', 0);`;
  try {
    const started = Date.now();
    let output = '', errors = '', heartbeatAt = null;
    const child = spawn(process.env.PHP_BINARY || 'php', ['-d', 'max_execution_time=1', '-r', program]);
    child.stdout.on('data', data => {
      output += data.toString();
      if (heartbeatAt === null && output.includes(': heartbeat\n\n')) heartbeatAt = Date.now() - started;
    });
    child.stderr.on('data', data => errors += data.toString());
    const timer = setTimeout(() => child.kill(), 10000);
    const exit = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
    clearTimeout(timer);
    assert.equal(exit, 0, errors);
    assert.match(output, /approval.required/);
    assert.match(output, /turn.completed/);
    assert.ok(heartbeatAt < 1500, 'heartbeat must reach the client during approval silence');
    assert.ok(Date.now() - started >= 2200, 'stream must survive beyond the configured PHP execution limit');
    const frames = output.split('\n\n').filter(Boolean);
    assert.ok(frames.filter(frame => frame === ': heartbeat').length >= 10, 'heartbeats must be complete SSE frames');
    assert.equal(frames.some(frame => frame.includes(': heartbeat\n: heartbeat')), false, 'heartbeats must not accumulate into an incomplete frame');
    console.log('harness approval SSE tests: PASS (PHP execution limit, heartbeat frames, immediate forwarding, terminal event)');
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
