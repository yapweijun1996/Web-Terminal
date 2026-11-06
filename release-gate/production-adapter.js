'use strict';
const { spawnSync } = require('node:child_process');
const ROLES = Object.freeze(['ingress-dir', 'socket', 'backend']);
// Diagnostics only: the executable is selected by the local operator, so neither
// its JSON nor an inode pin is an independent attestation or a write capability.
function inspectResources({ binary, supervisorUid, clientUid, paths, pins = {} } = {}) {
  const observations = {};
  for (const role of ROLES) {
    observations[role] = { classification: 'DENIED', reason: 'PROBE_UNAVAILABLE', productionAuthorization: false };
    if (typeof binary !== 'string' || !Number.isInteger(supervisorUid) || !Number.isInteger(clientUid) || typeof paths?.[role] !== 'string') continue;
    const args = [String(supervisorUid), String(clientUid), role, paths[role]];
    if (pins[role] !== undefined) { if (typeof pins[role] !== 'string') continue; args.push(pins[role]); }
    const r = spawnSync(binary, args, { encoding: 'utf8', timeout: 3000, maxBuffer: 16384, env: { PATH: '/usr/bin:/bin' } });
    try {
      if (r.error || ![0, 1].includes(r.status) || r.stderr) continue;
      const value = JSON.parse(r.stdout);
      if (!value || !['DENIED', 'METADATA_ONLY'].includes(value.classification) || typeof value.reason !== 'string' || value.productionAuthorization !== false) continue;
      observations[role] = value;
    } catch { /* Untrusted probe output cannot open the production gate. */ }
  }
  return { observations, productionAuthorization: false, G0: 'BLOCKED', G1: 'NOT_RUN' };
}
async function startProductionGateway(options = {}) {
  // Deliberately no imports of Gateway fixtures, HTTP, net, tmux, MCP or ttyd.
  // There is no trusted independent attestation verifier or descriptor-bound
  // two-UID supervisor transport yet. Refuse BEFORE interpreting caller getters,
  // invoking callbacks, spawning probes, binding, connecting or exposing writes.
  void options;
  const error = Error('P0 RELEASE BLOCKED: G0 independent authorization, native ACL and two-UID peer proof unavailable');
  error.code = 'RELEASE_BLOCKED';
  throw error;
}
if (require.main === module) {
  startProductionGateway().catch(e => { console.error(e.message); process.exitCode = 1; });
}
module.exports = { inspectResources, startProductionGateway };
