'use strict';
// There is deliberately no implemented attestation verifier or UID switching.
// Neither JSON input nor environment flags can authorize this harness.
console.error('DENIED: owner/admin independent staging approval and kernel ACL verification are unavailable; G2 NOT_RUN');
process.exitCode = 1;
