const base = '/api/workspace';

const messages = new Map(Object.entries({
  forbidden: 'Your workspace access could not be verified. Reload and sign in again.',
  network_error: 'Could not reach the workspace server.',
  invalid_response: 'The workspace server returned an unexpected response.',
  invalid_json: 'The workspace request could not be read.',
  invalid_body: 'The workspace request was invalid.',
  body_too_large: 'The request is too large. Try a shorter message.',
  invalid_agent: 'Choose a supported coding agent.',
  invalid_session: 'The session reference is invalid.',
  invalid_text: 'Enter a message between 1 and 20,000 characters.',
  invalid_decision: 'Choose Allow or Deny.',
  invalid_path: 'The project location is invalid.',
  outside_root: 'The project is outside the configured root.',
  not_directory: 'The project folder is unavailable.',
  unknown_root: 'This project is no longer configured.',
  not_found: 'The requested workspace resource was not found.',
  unknown_session: 'This session is no longer available. Start a new session.',
  unknown_approval: 'This approval is no longer pending.',
  invalid_repo: 'The repository reference is invalid.',
  repository_forbidden: 'You do not have access to this repository.',
  outside_workspaces: 'The managed workspace could not be opened.',
  workspace_exists: 'This managed workspace already exists.',
  clone_failed: 'The repository could not be cloned.',
  spawn_failed: 'The coding agent could not start.',
  resume_unavailable: 'This session cannot be resumed.',
  resume_not_verified: 'The coding agent could not verify this session for resume.',
  turn_active: 'Wait for the current turn to finish or stop it first.',
  max_sessions: 'The workspace session limit has been reached.',
  approvals_unsupported: 'This agent cannot handle approvals for this session.',
  project_path_changed: 'The project location changed. Start a new session.',
  invalid_cursor: 'The session history changed. Start a new session.',
  replay_incomplete: 'Part of the session history expired during the disconnect. Start a new session.',
}));

export function workspaceError(code, status) {
  return Object.assign(new Error(messages.get(code) ?? 'The workspace request failed.'), { code, status });
}

function identifier(value, code = 'invalid_session') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw workspaceError(code);
  return value;
}

function sessionUrl(sessionId) {
  return `${base}/sessions/${identifier(sessionId)}`;
}

export function eventUrl(sessionId) {
  return `${sessionUrl(sessionId)}/events`;
}

export async function responseError(response) {
  const data = await response.json().catch(() => null);
  const fallback = {
    401: 'forbidden', 403: 'forbidden', 404: 'not_found', 413: 'body_too_large',
  }[response.status] ?? 'internal_error';
  return workspaceError(messages.has(data?.error) ? data.error : fallback, response.status);
}

export function createWorkspaceClient(fetchImpl = globalThis.fetch.bind(globalThis)) {
  let requestToken;

  async function request(url, options) {
    let response;
    try {
      response = await fetchImpl(url, { cache: 'no-store', redirect: 'manual', ...options });
    } catch {
      throw workspaceError('network_error');
    }
    if (response.type === 'opaqueredirect' || response.redirected) throw workspaceError('forbidden');
    if (!response.ok) throw await responseError(response);
    return response.json().catch(() => { throw workspaceError('invalid_response'); });
  }

  async function post(url, body) {
    const data = await request('/api/sessions');
    if (typeof data?.token !== 'string' || !data.token) throw workspaceError('invalid_response');
    requestToken = data.token;
    return request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Terminal-Request': data.token },
      body: JSON.stringify(body),
    });
  }

  return {
    listProjects: () => request(`${base}/projects`),
    async startSession({ rootId, agent, resumeSessionId }) {
      // The root selection uses a fixed relative directory, never a server path.
      const data = await post(`${base}/sessions`, { rootId, relPath: '.', agent, resumeSessionId });
      return identifier(data?.sessionId, 'invalid_response');
    },
    sendMessage: (sessionId, text) => post(`${sessionUrl(sessionId)}/messages`, { text }),
    stop: (sessionId) => post(`${sessionUrl(sessionId)}/stop`, {}),
    decideApproval: (sessionId, approvalId, decision) =>
      post(`${sessionUrl(sessionId)}/approvals/${identifier(approvalId, 'unknown_approval')}`, { decision }),
    displayText(value) {
      const text = typeof value === 'string' ? value : '';
      const safeText = requestToken ? text.replaceAll(requestToken, '[redacted]') : text;
      return safeText.replace(/(?:file:\/\/\/|[A-Za-z]:[\\/]|(?<![\w/])(?:\.{1,2}\/|~\/|\/))[^\s<>"'`|/\\][^\s<>"'`|]*/g, '[path]');
    },
  };
}
