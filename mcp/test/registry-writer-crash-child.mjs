import { openOfflineJournal, createSyntheticLifecycleSource } from '../registry-writer-journal.js';

const [dir, point] = process.argv.slice(2);
const event = createSyntheticLifecycleSource().terminal('12345678-1234-4123-8123-123456789abc', '22345678-1234-4123-8123-123456789abc', 1, 'a'.repeat(64), 'synthetic result');
openOfflineJournal(dir).record(event, { fault(current) {
  if (current === point) {
    process.stdout.write('READY\n');
    // The parent kills this child only while it is paused at the requested point.
    for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
} });
