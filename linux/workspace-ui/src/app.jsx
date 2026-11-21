import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { createWorkspaceClient, workspaceError } from './api/client.js';
import { subscribeToEvents } from './api/events.js';
import { formatHistoryEntry, newestResumableEntry } from './state/history.js';
import { conversationReducer, emptyConversation, hasRunningTurn } from './state/reducer.js';
import { agents, mockReply, projects as mockProjects, recentSessions, sampleEvents, sampleSession } from './data/mock.js';
import { ChatStream, Composer, Welcome } from './components/chat.jsx';
import { Sidebar, WorkspaceSelect } from './components/navigation.jsx';
import { Icon } from './components/icon.jsx';
import { Terminal } from './components/terminal.jsx';

const api = createWorkspaceClient();
const mobileQuery = '(width < 768px)';
const connectionLabels = { connected: 'Connected', reconnecting: 'Reconnecting', error: 'Error' };
const preview = sampleEvents.reduce(
  (state, event) => conversationReducer(state, { type: 'event', event }),
  conversationReducer(emptyConversation, { type: 'prompt', prompt: { prompt: sampleSession.prompt } }),
);

export function App() {
  const [mode, setMode] = useState('loading');
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState('');
  const [relPath, setRelPath] = useState('.');
  const [agentId, setAgentId] = useState(agents[0].id);
  const [mockSessions, setMockSessions] = useState([]);
  const [history, setHistory] = useState([]);
  const [historyHidden, setHistoryHidden] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [session, setSession] = useState(null);
  const [conversations, setConversations] = useState(() => new Map());
  const [showWelcome, setShowWelcome] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(() => !window.matchMedia(mobileQuery).matches);
  const [streamStatuses, setStreamStatuses] = useState(() => new Map());
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [working, setWorking] = useState(false);
  const mutationPending = useRef(false);
  const historyRequest = useRef(0);
  const projectsMenu = useRef(null);
  const sidebarClose = useRef(null);
  const nextId = useRef(0);
  const cursors = useRef(new Map());
  const subscriptions = useRef(new Map());
  const chatBody = useRef(null);
  const followChat = useRef(true);

  const mock = mode === 'mock';
  const sessionId = session?.id ?? null;
  const conversation = conversations.get(sessionId) ?? emptyConversation;
  const running = hasRunningTurn(conversation, mock ? sampleEvents[0].turnId : undefined);
  const activeStream = streamStatuses.get(sessionId);
  const connection = mode === 'loading' ? 'reconnecting' : mode === 'error' ? 'error'
    : mode === 'live' && sessionId ? activeStream?.status ?? 'reconnecting' : 'connected';
  const folders = [{ id: '.', name: 'Project root' }, ...(projects.find((project) => project.id === projectId)?.folders ?? [])
    .map((folder) => ({ id: folder, name: folder }))];
  const resumableSession = mock
    ? mockSessions.find((session) => session.projectId === projectId && session.agentId === agentId)
    : newestResumableEntry(history, { rootId: projectId, relPath, agent: agentId });
  const sessions = mock ? mockSessions : historyHidden ? [] : history.map((entry) => ({
    ...formatHistoryEntry(entry), entry,
  }));
  const agentName = agents.find((agent) => agent.id === agentId).name;
  const message = actionError?.message ?? activeStream?.message ?? loadError ?? historyError;
  const disabled = working || mode === 'loading' || mode === 'error';
  const displayText = mock ? (value) => value : api.displayText;

  useEffect(() => {
    let active = true;

    function showMock() {
      setProjects(mockProjects);
      setProjectId(mockProjects[0].id);
      setMockSessions(recentSessions);
      setSession(sampleSession);
      setConversations(new Map([[sampleSession.id, preview]]));
      setMode('mock');
    }

    if (new URLSearchParams(window.location.search).get('mock') === '1') {
      showMock();
    } else {
      api.listProjects().then((data) => {
        if (!active) return;
        if (!Array.isArray(data?.projects)) throw workspaceError('invalid_response');
        if (data.projects.some((project) => typeof project?.id !== 'string' || !project.id)) {
          throw workspaceError('invalid_response');
        }
        const available = data.projects.map(({ id, label, folders }) => ({
          id, name: api.displayText(label) || 'Project', source: 'Project Root',
          folders: Array.isArray(folders) ? folders.filter((folder) => typeof folder === 'string' && folder !== '.') : [],
        }));
        setProjects(available);
        setProjectId(available[0]?.id ?? '');
        setMode('live');
        if (available.length === 0) setLoadError('No project roots are configured.');
      }).catch((error) => {
        if (!active) return;
        if (error.status === 404) {
          showMock();
        } else {
          setMode('error');
          setLoadError(error.code ? error.message : workspaceError('invalid_response').message);
        }
      });
    }

    return () => { active = false; };
  }, []);

  const refreshHistory = useCallback(async () => {
    const request = ++historyRequest.current;
    try {
      const data = await api.listHistory();
      if (request !== historyRequest.current) return;
      if (!Array.isArray(data?.entries)) throw workspaceError('invalid_response');
      setHistory(data.entries);
      setHistoryHidden(false);
      setHistoryError(null);
    } catch {
      if (request === historyRequest.current) setHistoryError('Could not load recent sessions.');
    }
  }, []);

  useEffect(() => {
    if (mode !== 'live') return;
    refreshHistory();
    return () => { historyRequest.current++; };
  }, [mode, refreshHistory]);

  function dispatch(id, action) {
    setConversations((current) => {
      const previous = current.get(id) ?? emptyConversation;
      const next = conversationReducer(previous, action);
      return next === previous ? current : new Map(current).set(id, next);
    });
  }

  useEffect(() => {
    if (mode !== 'live') return;
    const wanted = new Set(sessionId ? [sessionId] : []);
    // A turn can finish after the user has selected another session.
    for (const [id, state] of conversations) {
      if (hasRunningTurn(state)) wanted.add(id);
    }
    for (const [id, close] of subscriptions.current) {
      if (wanted.has(id)) continue;
      close();
      subscriptions.current.delete(id);
      setStreamStatuses((current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
    }
    for (const id of wanted) {
      if (subscriptions.current.has(id)) continue;
      const close = subscribeToEvents(id, {
        lastSeq: cursors.current.get(id),
        onEvent(event) {
          dispatch(id, { type: 'event', event });
          cursors.current.set(id, event.seq);
          if (event.type === 'turn_finished') refreshHistory();
        },
        onStatus(status, message) {
          setStreamStatuses((current) => new Map(current).set(id, { status, message }));
        },
      });
      subscriptions.current.set(id, close);
    }
  }, [mode, sessionId, conversations, refreshHistory]);

  useEffect(() => () => {
    for (const close of subscriptions.current.values()) close();
    subscriptions.current.clear();
  }, []);

  useEffect(() => {
    const media = window.matchMedia(mobileQuery);
    const onChange = (event) => {
      setSidebarOpen(false);
      setTerminalOpen(!event.matches);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
    projectsMenu.current.focus();
  }, []);

  useLayoutEffect(() => {
    if (!sidebarOpen) return;

    sidebarClose.current.focus();
    function onKeyDown(event) {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        closeSidebar();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sidebarOpen, closeSidebar]);

  useLayoutEffect(() => {
    followChat.current = true;
  }, [sessionId]);

  useLayoutEffect(() => {
    if (showWelcome) chatBody.current.scrollTop = 0;
    else if (followChat.current) chatBody.current.scrollTop = chatBody.current.scrollHeight;
  }, [conversation, sessionId, showWelcome]);

  function selectProject(id) {
    if (id === projectId) return;
    setProjectId(id);
    setRelPath('.');
    resetSession();
  }

  function selectFolder(path) {
    if (path === relPath || !folders.some((folder) => folder.id === path)) return;
    setRelPath(path);
    resetSession();
  }

  function selectAgent(id) {
    if (id === agentId) return;
    setAgentId(id);
    resetSession();
  }

  function resetSession() {
    setActionError(null);
    setSession(null);
    setShowWelcome(true);
  }

  function openSession(session) {
    setActionError(null);
    setProjectId(session.projectId);
    const project = projects.find((item) => item.id === session.projectId);
    setRelPath(project?.folders?.includes(session.relPath) ? session.relPath : '.');
    setAgentId(session.agentId);
    setSession(session);
    setShowWelcome(false);
  }

  async function createSession({ rootId = projectId, folder = relPath, agent = agentId, resumeSessionId } = {}) {
    const id = mock ? `local-session-${++nextId.current}`
      : await api.startSession({ rootId, relPath: folder, agent, resumeSessionId });
    const session = { id, projectId: rootId, relPath: folder, agentId: agent };
    if (mock) {
      const project = projects.find((item) => item.id === rootId);
      setMockSessions((current) => [{ ...session, label: `${project.name} session` }, ...current]);
    }
    openSession(session);
    return id;
  }

  async function mutate(action) {
    if (mutationPending.current) return false;
    mutationPending.current = true;
    setWorking(true);
    setActionError(null);
    try {
      await action();
      return true;
    } catch (error) {
      setActionError({
        message: error.code ? error.message : workspaceError('internal_error').message,
        retry: error.status === 409 && error.code === 'turn_active' ? action : null,
      });
      return false;
    } finally {
      mutationPending.current = false;
      setWorking(false);
    }
  }

  function startSession(resume) {
    if (disabled || !projectId) return;
    return mutate(async () => {
      if (resume && mock) {
        openSession(resumableSession);
      } else {
        await createSession({ resumeSessionId: resume ? resumableSession?.cliSessionId : undefined });
      }
    });
  }

  function openRecentSession(session) {
    if (mock) {
      openSession(session);
      return;
    }
    const { rootId, relPath: folder, agent, cliSessionId } = session.entry;
    return mutate(() => createSession({ rootId, folder, agent, resumeSessionId: cliSessionId }));
  }

  function sendMessage(prompt, attachments, onAccepted) {
    if (disabled || running || !prompt.trim()) return;
    let id = sessionId;
    return mutate(async () => {
      id ??= await createSession();
      followChat.current = true;
      setShowWelcome(false);
      dispatch(id, { type: 'prompt', prompt: { prompt, attachments } });

      if (mock) {
        const turnId = `local-turn-${++nextId.current}`;
        const lastSeq = conversations.get(id)?.lastSeq ?? 0;
        [
          { type: 'message_done', messageId: `${turnId}-assistant`, text: mockReply },
          { type: 'turn_finished', status: 'success' },
        ].forEach((event, index) => dispatch(id, {
          type: 'event', event: { ...event, sessionId: id, turnId, seq: lastSeq + index + 1 },
        }));
      } else {
        try {
          await api.sendMessage(id, prompt);
        } catch (error) {
          dispatch(id, { type: 'discard_prompt' });
          throw error;
        }
      }
      onAccepted();
    });
  }

  function decideApproval(request, decision) {
    return mutate(async () => {
      if (mock) {
        dispatch(sessionId, {
          type: 'event', event: { ...request, type: 'approval_decision', decision, seq: conversation.lastSeq + 1 },
        });
      } else {
        await api.decideApproval(request.sessionId, request.approvalId, decision);
      }
    });
  }

  function toggleTerminal() {
    setTerminalOpen((open) => !open);
  }

  return (
    <div class={terminalOpen ? 'workspace terminal-open' : 'workspace'}>
      {sidebarOpen && <div class="sidebar-overlay" aria-hidden="true" onClick={closeSidebar} />}
      <Sidebar projects={projects} projectId={projectId} sessionId={sessionId} sessions={sessions} open={sidebarOpen} mock={mock}
        disabled={disabled} closeButtonRef={sidebarClose} onClose={closeSidebar}
        onFocusLeave={() => setSidebarOpen(false)}
        onProject={(id) => {
          selectProject(id);
          if (sidebarOpen) closeSidebar();
        }}
        onSession={(session) => {
          openRecentSession(session);
          if (sidebarOpen) closeSidebar();
        }}
        onNew={() => {
          resetSession();
          if (sidebarOpen) closeSidebar();
        }}
        onClear={() => mock ? setMockSessions([]) : setHistoryHidden(true)} />
      <main class="chat-panel" aria-label="AI Coding Workspace">
        <header class="workspace-header">
          <button class="icon-button projects-menu" type="button" aria-label="Open projects"
            aria-controls="workspace-sidebar" aria-expanded={sidebarOpen} ref={projectsMenu}
            onClick={() => setSidebarOpen(true)}><Icon name="menu" /></button>
          <WorkspaceSelect kind="Project" choices={projects} value={projectId} onChange={selectProject} disabled={disabled} />
          <WorkspaceSelect kind="Agent" value={agentId} onChange={selectAgent} disabled={disabled} />
          <span class={`connection ${connection}`} role="status"><span aria-hidden="true" />{connectionLabels[connection]}</span>
        </header>
        {message ? <div class="prototype-banner error" role="alert">{message}
          {actionError?.retry && <button class="secondary" type="button" disabled={disabled || running}
            onClick={() => mutate(actionError.retry)}>Retry</button>}
        </div>
          : mock && <div class="prototype-banner">Mock mode</div>}
        <div class="chat-body" ref={chatBody} onScroll={({ currentTarget }) => {
          followChat.current = currentTarget.scrollHeight - currentTarget.scrollTop - currentTarget.clientHeight < 32;
        }}>
          <div class="chat-content">
            {showWelcome && <Welcome projects={projects} projectId={projectId} folders={folders} relPath={relPath} agentId={agentId}
              onProject={selectProject} onFolder={selectFolder} onAgent={selectAgent} canResume={Boolean(resumableSession)}
              onStart={startSession} disabled={disabled} />}
            <ChatStream conversation={conversation} agentName={agentName} mock={mock} displayText={displayText}
              onDecision={decideApproval} approvalDisabled={working || connection !== 'connected'} />
          </div>
        </div>
        <div class="composer-area">
          <Composer agentId={agentId} terminalOpen={terminalOpen} onAgent={selectAgent} onTerminal={toggleTerminal}
            onSend={sendMessage} onStop={() => mutate(() => api.stop(sessionId))} mock={mock} working={working}
            running={running} disabled={disabled || !projectId || running || (!mock && connection !== 'connected')} />
        </div>
      </main>
      <Terminal open={terminalOpen} onToggle={toggleTerminal} mock={mock}
        session={mode === 'live' ? session : null} client={api} />
    </div>
  );
}
