'use strict';
// Existing fixture asks to set its already-private mkdtemp directory to 0700.
// Verify this is a no-op, without issuing a permission-changing syscall.
const fs = require('node:fs');
fs.chmodSync = (file, mode) => {
  if (typeof file !== 'string' || !/^\/tmp\/mba-auth-gateway-[^/]+$/.test(file) || mode !== 0o700) throw Error('chmod forbidden');
  const st = fs.lstatSync(file);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.geteuid() || (st.mode & 0o7777) !== 0o700) throw Error('fixture directory not already private');
};
