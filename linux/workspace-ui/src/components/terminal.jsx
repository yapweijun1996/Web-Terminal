import { useLayoutEffect, useReducer } from 'preact/hooks';
import { terminalReducer } from '../state/terminal.js';
import { terminalText } from '../data/mock.js';
import { Icon } from './icon.jsx';

function SessionTerminal({ open, session, client }) {
  const [state, dispatch] = useReducer(terminalReducer, { status: 'idle' });
  const { status } = state;

  useLayoutEffect(() => {
    if (open) dispatch({ type: 'open' });
  }, [open]);

  useLayoutEffect(() => {
    if (status !== 'loading') return;
    let active = true;
    client.createTerminal(session.id, { rootId: session.projectId, relPath: session.relPath }).then(
      (terminalId) => { if (active) dispatch({ type: 'created', terminalId }); },
      (error) => { if (active) dispatch({ type: 'failed', error }); },
    );
    // Collapse leaves the request and frame alive. A different chat unmounts this component.
    return () => { active = false; };
  }, [status, session, client]);

  if (status === 'ready') {
    return <iframe class="terminal-frame" src={state.url} title="Coding session terminal"
      sandbox="allow-scripts allow-same-origin" />;
  }
  if (status === 'disabled') {
    return <p class="terminal-caption" role="status">The terminal panel is not enabled on this server</p>;
  }
  if (status === 'error') {
    return <>
      <p class="terminal-caption error" role="alert">{state.message}</p>
      <button class="secondary terminal-retry" type="button" onClick={() => dispatch({ type: 'retry' })}>Retry</button>
    </>;
  }
  return <p class="terminal-caption" role="status">Opening terminal…</p>;
}

export function Terminal({ open, onToggle, mock, session, client }) {
  return (
    <aside class={open ? 'terminal is-open' : 'terminal'} aria-label="Terminal pane">
      <button class="terminal-toggle" type="button" aria-controls="terminal-output" aria-expanded={open} onClick={onToggle}>
        <Icon name="terminal" size={18} /><span>Terminal</span><Icon name="chevron" size={15} />
      </button>
      <div class="terminal-output" id="terminal-output" hidden={!open}>
        {mock ? <>
          <div class="terminal-caption">Sample output</div>
          <pre tabIndex={0} aria-label="Terminal output">{terminalText}</pre>
        </> : session ? <SessionTerminal key={session.id} open={open} session={session} client={client} />
          : <p class="terminal-caption">Start a coding session to open the terminal.</p>}
      </div>
    </aside>
  );
}
