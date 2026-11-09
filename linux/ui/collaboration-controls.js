'use strict';
// Status comes from the authoritative coordinator. Failed actions remain
// visible separately so the 2-second status poll cannot erase their cause.
window.createCollaborationControls = function ({ getSession, getToken }) {
  const element = document.createElement('div'); element.className = 'action-group'; element.hidden = true;
  element.title = 'Human typing or image insertion pauses AI in all managed terminals. Resume sharing applies only to this terminal.';
  const status = document.createElement('span'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const error = document.createElement('span'); error.className = 'collaboration-error'; error.setAttribute('role', 'alert'); error.hidden = true;
  const pause = document.createElement('button'); pause.type = 'button'; pause.textContent = 'Pause AI';
  const takeover = document.createElement('button'); takeover.type = 'button'; takeover.textContent = 'Take control';
  const resume = document.createElement('button'); resume.type = 'button'; resume.textContent = 'Resume sharing'; resume.title = 'Resume AI in this terminal only, using a fresh input generation';
  element.append(status, pause, takeover, resume);
  let busy = false, known = null, displayedSession = null, actionVersion = 0;
  function clearError() { error.textContent = ''; error.hidden = true; }
  function showError(message) { error.textContent = message; error.hidden = false; }
  function syncSession(session) {
    if (session === displayedSession) return;
    displayedSession = session; known = null; clearError(); render(null);
  }
  function render(state) {
    known = state;
    status.textContent = state?.state === 'sharing' ? 'AI sharing enabled' : state?.state === 'manual-paused' ? 'AI paused manually' : state?.state === 'paused' && state?.idleRemainingMs != null ? `Human control · AI resumes in ${Math.ceil(state.idleRemainingMs / 1000)}s` : ['paused', 'owner-active'].includes(state?.state) ? 'Owner control' : state?.state === 'pause-pending' ? 'Pausing AI…' : 'AI input unavailable';
    pause.disabled = takeover.disabled = busy || !state || state.state !== 'sharing';
    resume.disabled = busy || !state || !['paused', 'manual-paused'].includes(state.state);
  }
  // Only trust a server-defined error code. Never display response bodies,
  // authorization headers, tokens, or arbitrary exception text.
  function describeFailure(action, responseStatus, code, redirected = false) {
    const label = action === 'resume' ? 'Resume sharing' : action === 'takeover' ? 'Take control' : 'Pause AI';
    const http = Number.isInteger(responseStatus) && responseStatus >= 100 ? `HTTP ${responseStatus}` : 'HTTP status unavailable';
    if (redirected) return `${label} failed — ${http}: sign-in redirect; verify Owner authentication.`;
    if (responseStatus === 401) return `${label} failed — ${http}: Owner authentication failed or expired. Sign in again.`;
    if (responseStatus === 403) return `${label} failed — ${http}: Origin/CSRF request verification failed. Refresh the page.`;
    if (responseStatus === 409 && code === 'STALE_TARGET') return `${label} failed — ${http}: Session Binding Failure (terminal identity changed). Refresh terminal status.`;
    if (responseStatus === 409) return `${label} failed — ${http}: input control changed or is busy. Verify the terminal state.`;
    if (responseStatus === 503) return `${label} failed — ${http}: operation outcome uncertain; verify state before retrying.`;
    return `${label} failed — ${http}: request unsuccessful. Check the connection and terminal state.`;
  }
  async function refresh() {
    const session = getSession(); syncSession(session);
    if (busy || document.hidden || !session) return;
    const version = actionVersion;
    try {
      const response = await fetch('/api/collaboration/state', { cache: 'no-store', redirect: 'manual' });
      if (session !== getSession() || version !== actionVersion || busy) return;
      if (response.status === 404) { element.hidden = true; return; }
      element.hidden = false;
      if (!response.ok || response.redirected || response.type === 'opaqueredirect') throw Error('Unavailable');
      const value = await response.json();
      if (session === getSession() && version === actionVersion && !busy) render(value.sessions?.[session] || null);
    } catch {
      if (session === getSession() && version === actionVersion && !busy) { element.hidden = false; render(null); }
    }
  }
  async function control(action) {
    const session = getSession(); syncSession(session);
    if (!session || busy || !known) return;
    busy = true; actionVersion++; clearError(); render(known);
    let failure = null;
    try {
      const response = await fetch('/api/collaboration/control', { method: 'POST', redirect: 'manual', headers: {
        'Content-Type': 'application/json', 'X-Terminal-Request': getToken(),
      }, body: JSON.stringify({ session, action, serverPid: known.serverPid, sessionId: known.sessionId }) });
      if (!response.ok || response.redirected || response.type === 'opaqueredirect') {
        let code = null;
        try {
          const body = await response.json();
          if (body?.code === 'STALE_TARGET') code = 'STALE_TARGET';
        } catch { /* HTML / redirect bodies are never shown to users. */ }
        failure = describeFailure(action, response.status, code, response.redirected || response.type === 'opaqueredirect');
        return;
      }
      const result = await response.json();
      if (session === getSession()) render(result);
    } catch {
      failure = `${action === 'resume' ? 'Resume sharing' : action === 'takeover' ? 'Take control' : 'Pause AI'} failed — network or invalid response. Verify state before retrying.`;
    } finally {
      busy = false;
      if (session === getSession()) { render(known); if (failure) showError(failure); }
    }
  }
  pause.addEventListener('click', () => control('pause'));
  takeover.addEventListener('click', () => control('takeover'));
  resume.addEventListener('click', () => control('resume'));
  const timer = setInterval(refresh, 2000);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  void refresh();
  return { element, notice: error, refresh };
};
