'use strict';
const ledger = require('./ledger');
try {
  const [dir, action, supplied] = process.argv.slice(2);
  const l = ledger.open(dir);
  if (l.status === 'ACTIVE' && action === 'acquire') {
    l.write(l.lease, 'authorized scratch write\n');
    process.send({ status: l.status, lease: l.lease });
    setInterval(() => {}, 10000);
  } else if (l.status === 'ACTIVE') {
    // A lease from a previous process never authorizes a new process.
    try { l.renew(supplied); process.send({ status: 'UNEXPECTED' }); }
    catch { process.send({ status: 'QUARANTINED' }); }
  } else process.send({ status: l.status });
} catch { if (process.send) process.send({ status: 'QUARANTINED' }); else process.exitCode = 1; }
