'use strict';
// Status always comes from the authoritative coordinator, never a local pause flag.
window.createCollaborationControls = function ({ getSession, getToken }) {
  const element = document.createElement('div'); element.className = 'action-group'; element.hidden = true;
  element.title = 'Human typing or image insertion pauses AI in all managed terminals. Resume sharing applies only to this terminal.';
  const status = document.createElement('span'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const pause = document.createElement('button'); pause.type = 'button'; pause.textContent = 'Pause AI';
  const takeover = document.createElement('button'); takeover.type = 'button'; takeover.textContent = 'Take control';
  const resume = document.createElement('button'); resume.type = 'button'; resume.textContent = 'Resume sharing'; resume.title = 'Resume AI in this terminal only, using a fresh input generation';
  element.append(status, pause, takeover, resume);
  let busy = false, known = null;
  function render(state) {
    known = state;
    status.textContent = state?.state === 'sharing' ? 'AI sharing enabled' : state?.state === 'manual-paused' ? 'AI paused manually' : state?.state === 'paused' && state?.idleRemainingMs != null ? `Human control · AI resumes in ${Math.ceil(state.idleRemainingMs / 1000)}s` : ['paused', 'owner-active'].includes(state?.state) ? 'Owner control' : state?.state === 'pause-pending' ? 'Pausing AI…' : 'AI input unavailable';
    pause.disabled = takeover.disabled = busy || !state || state.state !== 'sharing';
    resume.disabled = busy || !state || !['paused', 'manual-paused'].includes(state.state);
  }
  async function refresh() {
    if (busy || document.hidden) return;
    const session = getSession(); if (!session) return;
    try {
      const response = await fetch('/api/collaboration/state', { cache: 'no-store', redirect: 'manual' });
      if (response.status === 404) { element.hidden = true; return; }
      element.hidden = false;
      if (!response.ok) throw Error('Unavailable');
      const value = await response.json();
      if (session === getSession()) render(value.sessions?.[session] || null);
    } catch { element.hidden = false; render(null); }
  }
  async function control(action) {
    const session = getSession(); if (!session || busy) return;
    busy = true; render(known);
    try {
      const response = await fetch('/api/collaboration/control', { method: 'POST', redirect: 'manual', headers: {
        'Content-Type': 'application/json', 'X-Terminal-Request': getToken(),
      }, body: JSON.stringify({ session, action, serverPid: known?.serverPid, sessionId: known?.sessionId }) });
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      const result = await response.json();
      if (session === getSession()) { busy = false; render(result); }
    } catch (error) { busy = false; status.textContent = `Sharing action failed: ${error.message}`; }
    finally { busy = false; }
  }
  pause.addEventListener('click', () => control('pause'));
  takeover.addEventListener('click', () => control('takeover'));
  resume.addEventListener('click', () => control('resume'));
  const timer = setInterval(refresh, 2000);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  void refresh();
  return { element, refresh };
};
