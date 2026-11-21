'use strict';

const { createInterface } = require('node:readline');

const [agent, mode] = process.argv.slice(2);
const cliSessionId = 'c6cecb23-d965-4b2a-a68c-f975304021a2';
const write = record => process.stdout.write(JSON.stringify(record) + '\n');
const done = () => write({ type: 'result', total_cost_usd: 0.01 });
const message = text => ({
  type: 'assistant', message: { id: 'message-1', content: [{ type: 'text', text }] },
});

if (agent === 'codex') {
  const chunks = [];
  process.stdin.on('data', chunk => chunks.push(chunk));
  process.stdin.on('end', () => {
    write({ type: 'thread.started', thread_id: 'private-codex-thread' });
    write({
      type: 'item.completed',
      item: { type: 'agent_message', id: 'message-1', text: Buffer.concat(chunks).toString('utf8') },
    });
    process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3 } }));
  });
} else {
  if (mode === 'hold') process.on('SIGTERM', () => process.stderr.write('TERM received\n'));
  write({ type: 'system', subtype: 'init', session_id: cliSessionId });
  createInterface({ input: process.stdin }).on('line', line => {
    const record = JSON.parse(line);
    if (mode === 'hold') return;
    if (record.type === 'control_response') {
      const { request_id: requestId, response } = record.response;
      write(message(requestId === 'private-request' ? response.behavior : 'invalid request ID'));
      done();
    } else if (mode === 'approval') {
      write({
        type: 'control_request', request_id: 'private-request',
        request: { subtype: 'can_use_tool', tool_use_id: 'tool-1', tool_name: 'Write', input: { file: 'example.txt' } },
      });
    } else if (mode === 'partial') {
      const frame = Buffer.from(JSON.stringify(message('hello 🌍')) + '\r\n');
      const split = frame.indexOf(Buffer.from('🌍')) + 1;
      process.stdout.write(frame.subarray(0, split));
      setTimeout(() => {
        process.stdout.write(frame.subarray(split, frame.length - 1));
        setTimeout(() => {
          process.stdout.write(frame.subarray(frame.length - 1));
          done();
        }, 10);
      }, 10);
    } else if (mode === 'stderr') {
      process.stderr.write('fake-token-do-not-expose'.repeat(2_000), () => { process.exitCode = 1; });
      process.stdin.destroy();
    } else if (mode === 'oversized') {
      process.stdout.write(Buffer.alloc(1024 * 1024 + 1, 97));
    } else {
      write(message(record.message.content));
      done();
    }
  });
}
