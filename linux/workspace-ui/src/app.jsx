import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { createWorkspaceClient, workspaceError } from './api/client.js';
import { subscribeToEvents } from './api/events.js';
import { conversationReducer, emptyConversation } from './state/reducer.js';
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
  const [agentId, setAgentId] = useState(agents[0].id);
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [conversations, setConversations] = useState(() => new Map());
  const [showWelcome, setShowWelcome] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(() => !window.matchMedia(mobileQuery).matches);
  const [stream, setStream] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [working, setWorking] = useState(false);
  const projectsMenu = useRef(null);
  const sidebarClose = useRef(null);
  const nextId = useRef(0);
  const cursors = useRef(new Map());
  const chatBody = useRef(null);
  const followChat = useRef(true);

  const mock = mode === 'mock';
  const conversation = conversations.get(sessionId) ?? emptyConversation;
  const running = Boolean(conversation.pendingPrompt) || conversation.turns.some((turn) => turn.status === 'running');
  const activeStream = stream?.sessionId === sessionId ? stream : null;
  const connection = mode === 'loading' ? 'reconnecting' : mode === 'error' ? 'error'
    : mode === 'live' && sessionId ? activeStream?.status ?? 'reconnecting' : 'connected';
  const resumableSession = sessions.find((session) => session.projectId === projectId && session.agentId === agentId);
  const agentName = agents.find((agent) => agent.id === agentId).name;
  const message = actionError ?? activeStream?.message ?? loadError;
  const disabled = working || mode === 'loading' || mode === 'error';
  const displayText = mock ? (value) => value : api.displayText;

  useEffect(() => {
    let active = true;

    function showMock() {
      setProjects(mockProjects);
      setProjectId(mockProjects[0].id);
      setSessions(recentSessions);
      setSessionId(sampleSession.id);
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
        const available = data.projects.map(({ id, label }) => ({
          id, name: api.displayText(label) || 'Project', source: 'Project Root',
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

  function dispatch(id, action) {
    setConversations((current) => {
      const previous = current.get(id) ?? emptyConversation;
      const next = conversationReducer(previous, action);
      return next === previous ? current : new Map(current).set(id, next);
    });
  }

  useEffect(() => {
    if (mode !== 'live' || !sessionId) return;
    return subscribeToEvents(sessionId, {
      lastSeq: cursors.current.get(sessionId),
      onEvent(event) {
        dispatch(sessionId, { type: 'event', event });
        cursors.current.set(sessionId, event.seq);
      },
      onStatus(status, message) {
        setStream({ sessionId, status, message });
      },
    });
  }, [mode, sessionId]);

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
    resetSession();
  }

  function selectAgent(id) {
    if (id === agentId) return;
    setAgentId(id);
    resetSession();
  }

  function resetSession() {
    setActionError(null);
    setStream(null);
    setSessionId(null);
    setShowWelcome(true);
  }

  function openSession(session) {
    setActionError(null);
    if (session.id !== sessionId) setStream(null);
    setProjectId(session.projectId);
    setAgentId(session.agentId);
    setSessionId(session.id);
    setShowWelcome(false);
  }

  async function createSession(resumeSessionId) {
    const id = mock ? `local-session-${++nextId.current}`
      : await api.startSession({ rootId: projectId, agent: agentId, resumeSessionId });
    const project = projects.find((item) => item.id === projectId);
    const session = { id, projectId, agentId, label: `${project.name} session` };
    setSessions((current) => [session, ...current.filter((item) => item.id !== id)]);
    openSession(session);
    return id;
  }

  async function mutate(action) {
    if (working) return false;
    setWorking(true);
    setActionError(null);
    try {
      await action();
      return true;
    } catch (error) {
      setActionError(error.code ? error.message : workspaceError('internal_error').message);
      return false;
    } finally {
      setWorking(false);
    }
  }

  function startSession(resume) {
    if (disabled || !projectId) return;
    return mutate(async () => {
      if (resume && mock) {
        openSession(resumableSession);
      } else {
        await createSession(resume ? resumableSession?.id : undefined);
      }
    });
  }

  function sendMessage(prompt, attachments) {
    return mutate(async () => {
      if (!mock && !prompt) throw workspaceError('invalid_text');
      const id = sessionId ?? await createSession();
      followChat.current = true;
      setShowWelcome(false);
      dispatch(id, { type: 'prompt', prompt: { prompt, attachments } });

      if (mock) {
        const turnId = `local-turn-${++nextId.current}`;
        const lastSeq = conversation.lastSeq;
        [
          { type: 'message_done', messageId: `${turnId}-assistant`, text: mockReply },
          { type: 'turn_finished', status: 'success' },
        ].forEach((event, index) => dispatch(id, {
          type: 'event', event: { ...event, sessionId: id, turnId, seq: lastSeq + index + 1 },
        }));
        return;
      }

      try {
        await api.sendMessage(id, prompt);
      } catch (error) {
        dispatch(id, { type: 'discard_prompt' });
        throw error;
      }
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
      <Sidebar projects={projects} projectId={projectId} sessionId={sessionId} sessions={sessions} open={sidebarOpen}
        disabled={disabled} closeButtonRef={sidebarClose} onClose={closeSidebar}
        onFocusLeave={() => setSidebarOpen(false)}
        onProject={(id) => {
          selectProject(id);
          if (sidebarOpen) closeSidebar();
        }}
        onSession={(session) => {
          openSession(session);
          if (sidebarOpen) closeSidebar();
        }}
        onNew={() => {
          resetSession();
          if (sidebarOpen) closeSidebar();
        }}
        onClear={() => setSessions([])} />
      <main class="chat-panel" aria-label="AI Coding Workspace">
        <header class="workspace-header">
          <button class="icon-button projects-menu" type="button" aria-label="Open projects"
            aria-controls="workspace-sidebar" aria-expanded={sidebarOpen} ref={projectsMenu}
            onClick={() => setSidebarOpen(true)}><Icon name="menu" /></button>
          <WorkspaceSelect kind="Project" choices={projects} value={projectId} onChange={selectProject} disabled={disabled} />
          <WorkspaceSelect kind="Agent" value={agentId} onChange={selectAgent} disabled={disabled} />
          <span class={`connection ${connection}`} role="status"><span aria-hidden="true" />{connectionLabels[connection]}</span>
        </header>
        {message ? <div class="prototype-banner error" role="alert">{message}</div>
          : mock && <div class="prototype-banner">Mock mode</div>}
        <div class="chat-body" ref={chatBody} onScroll={({ currentTarget }) => {
          followChat.current = currentTarget.scrollHeight - currentTarget.scrollTop - currentTarget.clientHeight < 32;
        }}>
          <div class="chat-content">
            {showWelcome && <Welcome projects={projects} projectId={projectId} agentId={agentId}
              onProject={selectProject} onAgent={selectAgent} canResume={Boolean(resumableSession)}
              onStart={startSession} disabled={disabled} />}
            <ChatStream conversation={conversation} agentName={agentName} mock={mock} displayText={displayText}
              onDecision={decideApproval} approvalDisabled={working || connection !== 'connected'} />
          </div>
        </div>
        <div class="composer-area">
          <Composer agentId={agentId} terminalOpen={terminalOpen} onAgent={selectAgent} onTerminal={toggleTerminal}
            onSend={sendMessage} onStop={() => mutate(() => api.stop(sessionId))} mock={mock} working={working}
            running={running} disabled={disabled || !projectId || (!mock && (running || connection !== 'connected'))} />
        </div>
      </main>
      <Terminal open={terminalOpen} onToggle={toggleTerminal} mock={mock} />
    </div>
  );
}
