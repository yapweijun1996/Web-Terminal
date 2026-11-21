import { useEffect, useRef, useState } from 'preact/hooks';
import { workspaceError } from '../api/client.js';
import { isSubmitKey, sendDisabledReason } from '../state/composer.js';
import { Icon } from './icon.jsx';
import { WorkspaceSelect } from './navigation.jsx';

function ModelSelectors({ picker, location, disabled }) {
  const { options, choice, running, needsNewSession, onChange } = picker;
  const model = options.models.find(({ id }) => id === choice.model);
  const reason = running ? 'Model is fixed for this session' : needsNewSession ? 'New session needed' : null;
  const reasonId = reason ? `${location}-model-reason` : undefined;

  return (
    <>
      <div class="model-field"><span>Model</span>
        <WorkspaceSelect kind="Model" label={`${location} model`} value={choice.model}
          choices={options.models.map(({ id, label }) => ({ id, name: label }))}
          disabled={disabled || running} describedBy={reasonId}
          onChange={(model) => onChange({ ...choice, model })} />
      </div>
      <div class="model-field"><span>Effort</span>
        <WorkspaceSelect kind="Effort" label={`${location} effort`} value={choice.effort ?? ''}
          choices={model.efforts.length ? model.efforts.map((id) => ({ id, name: id })) : [{ id: '', name: 'Default' }]}
          disabled={disabled || running || !model.efforts.length} describedBy={reasonId}
          onChange={(effort) => onChange({ ...choice, effort })} />
      </div>
      {reason && <small class="model-reason" id={reasonId} role="status">{reason}</small>}
    </>
  );
}

export function Welcome({
  projects, projectId, folders, relPath, agentId, onProject, onFolder, onAgent, onStart, canResume, disabled, modelPicker,
}) {
  const [resume, setResume] = useState(true);

  return (
    <form class="welcome" onSubmit={(event) => {
      event.preventDefault();
      onStart(resume && canResume);
    }}>
      <span class="welcome-icon"><Icon name="brand" size={24} /></span>
      <h1>What are we building?</h1>
      <p>Choose a project and an agent to start coding.</p>
      <div class="welcome-fields">
        <div class="welcome-location">
          <div><span>Project</span><WorkspaceSelect kind="Project" label="Welcome project" choices={projects} disabled={disabled} value={projectId} onChange={onProject} /></div>
          <div><span>Folder</span><WorkspaceSelect kind="Folder" choices={folders} disabled={disabled || !projectId} value={relPath} onChange={onFolder} /></div>
        </div>
        <div><span>Agent</span><WorkspaceSelect kind="Agent" label="Welcome agent" disabled={disabled} value={agentId} onChange={onAgent} /></div>
        {modelPicker && <ModelSelectors picker={modelPicker} location="Welcome" disabled={disabled} />}
      </div>
      <div class="welcome-actions">
        <label class="resume"><input type="checkbox" checked={resume && canResume} disabled={disabled || !canResume}
          onChange={(event) => setResume(event.currentTarget.checked)} /> Resume session</label>
        <button class="primary" type="submit" disabled={disabled || !projectId}>Start Coding <Icon name="arrow" size={16} /></button>
      </div>
    </form>
  );
}

function Thinking({ thinking, active, displayText }) {
  return (
    <details class="thinking">
      <summary>
        <strong>{active ? 'Thinking…' : 'Thinking'}</strong>
        {Number.isFinite(thinking.tokens) && <span>~{thinking.tokens} tokens</span>}
        <Icon name="chevron" size={14} />
      </summary>
      <p>{thinking.text.trim() ? displayText(thinking.text) : 'Thinking (details are not provided by this agent)'}</p>
    </details>
  );
}

function ToolSteps({ steps, approvals, turnStatus, mock, displayText }) {
  const statuses = {
    done: 'Done', running: 'Running', pending: 'Awaiting approval', error: 'Failed', cancelled: 'Cancelled',
    denied: 'Denied', interrupted: 'Interrupted',
  };

  if (!steps.length) return null;

  function stepStatus(step) {
    if (step.output !== undefined) return step.isError ? 'error' : 'done';
    const approval = approvals.find(({ request }) => request?.toolCallId === step.id);
    if (approval?.decision === 'deny') return 'denied';
    if (approval && !approval.decision) return 'pending';
    return turnStatus === 'success' ? 'done' : turnStatus;
  }

  return (
    <details class="tool-group" open>
      <summary><Icon name="tool" size={17} /><strong>Tool steps</strong><span class="step-count">{steps.length}</span>
        <Icon name="chevron" size={15} /></summary>
      {steps.map((step) => {
        const status = stepStatus(step);
        return (
          <details class="tool-step" key={step.id}>
            <summary>
              <span class={`step-indicator ${status}`} aria-hidden="true">{status === 'done' && <Icon name="check" size={12} />}</span>
              <span class="step-name">{displayText(step.name) || 'Tool call'}</span>
              <span class={`step-status ${status}`}>{statuses[status]}</span>
              <Icon name="chevron" size={14} />
            </summary>
            <div class="step-detail">
              {mock ? <>
                {step.input !== undefined && <pre>{JSON.stringify(step.input, null, 2)}</pre>}
                {step.output !== undefined && <p>{step.output}</p>}
              </> : <p>{step.output === undefined ? statuses[status] : step.isError ? 'Tool reported an error.' : 'Tool returned a result.'}</p>}
            </div>
          </details>
        );
      })}
    </details>
  );
}

function Approval({ request, decision, onDecision, disabled, displayText }) {
  const [submitting, setSubmitting] = useState(false);
  const result = useRef(null);
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (decision && restoreFocus.current) {
      result.current.focus();
      restoreFocus.current = false;
    }
  }, [decision]);

  return (
    <section class="approval" aria-label="Tool approval">
      <Icon name="shield" />
      <div class="approval-content">
        <h3>{decision ? 'Approval recorded' : 'Approval required'}</h3>
        <p>{displayText(request.toolName)}</p>
        {decision ? (
          <p role="status" tabIndex={-1} ref={result}>{decision === 'allow' ? 'Allowed.' : 'Denied.'}</p>
        ) : (
          <div class="approval-actions">
            {request.options.map((option) => (
              <button key={option} type="button" disabled={disabled || submitting} class={option === 'allow' ? 'primary' : 'secondary'}
                onClick={async () => {
                  restoreFocus.current = true;
                  setSubmitting(true);
                  if (!await onDecision(request, option)) {
                    restoreFocus.current = false;
                    setSubmitting(false);
                  }
                }}>
                {option === 'allow' ? 'Allow' : 'Deny'}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export function ChatStream({ conversation, agentName, mock, displayText, onDecision, approvalDisabled }) {
  const { turns, pendingPrompt, error } = conversation;
  const statuses = {
    running: 'Working…', success: 'Completed', error: 'Turn failed', cancelled: 'Stopped', interrupted: 'Interrupted',
  };

  function userMessage(prompt, attachments = []) {
    if (prompt === undefined) return null;
    return (
      <article class="user-message" aria-label="Your message">
        <div>{displayText(prompt)}</div>
        {attachments.length > 0 && <small>{attachments.join(', ')}</small>}
      </article>
    );
  }

  return (
    <section class="chat-stream" aria-label="Conversation" role="log" aria-live="polite">
      {error && <p class="error">{workspaceError(error.code).message}</p>}
      {turns.map(({ id, prompt, attachments, messages, tools, approvals, status, errors }) => (
        <div class="chat-turn" key={id}>
          {userMessage(prompt, attachments)}
          <article class="assistant-message" aria-label={agentName}>
            <div class="assistant-heading">
              <span class="assistant-icon"><Icon name="brand" size={16} /></span><strong>{agentName}</strong>
            </div>
            {messages.map(({ id, text, thinking }) => (
              <div key={id}>
                {thinking && <Thinking thinking={thinking} active={status === 'running' && text === undefined} displayText={displayText} />}
                {text !== undefined && <p class="message-text">{displayText(text)}</p>}
              </div>
            ))}
            <ToolSteps steps={tools} approvals={approvals} turnStatus={status} mock={mock} displayText={displayText} />
            {approvals.filter((approval) => approval.request).map(({ id, request, decision }) => (
              <Approval key={id} request={request} decision={decision} onDecision={onDecision}
                disabled={approvalDisabled} displayText={displayText} />
            ))}
            {errors.map(({ seq, code }) => (
              <p class="error" key={seq}>{workspaceError(code).message}</p>
            ))}
            <p class={`turn-status ${status === 'error' ? 'error' : ''}`} role="status">{statuses[status]}</p>
          </article>
        </div>
      ))}
      {pendingPrompt && <div class="chat-turn">{userMessage(pendingPrompt.prompt, pendingPrompt.attachments)}</div>}
    </section>
  );
}

export function Composer({
  agentId, terminalOpen, onAgent, onTerminal, onSend, onStop, mock, running, blockedReason, working, streamStalled,
  modelPicker, selectorsDisabled,
}) {
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState([]);
  const fileInput = useRef(null);
  const imageInput = useRef(null);
  const disabledReason = sendDisabledReason(draft, blockedReason);
  const agentSelector = <WorkspaceSelect kind="Agent" label="Composer agent" disabled={selectorsDisabled}
    value={agentId} onChange={onAgent} />;

  function addFiles(event) {
    const input = event.currentTarget;
    setAttachments((current) => [...current, ...Array.from(input.files, (file) => file.name)]);
    input.value = '';
  }

  function send(event) {
    event.preventDefault();
    if (disabledReason) return;
    onSend(draft.trim(), attachments, () => {
      setDraft((current) => current === draft ? '' : current);
      setAttachments((current) => current === attachments ? [] : current);
    });
  }

  return (
    <form class="composer" aria-label="Message composer" onSubmit={send}>
      <textarea aria-label="Message" rows="2" placeholder="Ask your agent to build something…" value={draft}
        onInput={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (!isSubmitKey(event)) return;
          event.preventDefault();
          event.currentTarget.form.requestSubmit();
        }} />
      {attachments.length > 0 && (
        <div class="attachments">
          <span>{attachments.join(', ')}</span>
          <button class="quiet-button" type="button" onClick={() => setAttachments([])}>Remove attachments</button>
        </div>
      )}
      {streamStalled && <p class="composer-stream-status" role="status">
        No response yet. The event stream may be blocked; retrying…
      </p>}
      {modelPicker && <div class="composer-models">
        <div class="model-field"><span>Agent</span>{agentSelector}</div>
        <ModelSelectors picker={modelPicker} location="Composer" disabled={selectorsDisabled} />
      </div>}
      <div class="composer-actions">
        <input type="file" multiple hidden ref={fileInput} onChange={addFiles} />
        <input type="file" multiple hidden accept="image/*" ref={imageInput} onChange={addFiles} />
        <button class="icon-button" type="button" disabled={!mock || working} aria-label="Attach files" title={mock ? "Attach files" : "File attachments are unavailable"} onClick={() => fileInput.current.click()}><Icon name="clip" /></button>
        <button class="icon-button" type="button" disabled={!mock || working} aria-label="Attach images" title={mock ? "Attach images" : "Image attachments are unavailable"} onClick={() => imageInput.current.click()}><Icon name="image" /></button>
        <button class="icon-button" type="button" aria-label="Toggle terminal" title="Toggle terminal" aria-controls="terminal-output"
          aria-expanded={terminalOpen} onClick={onTerminal}><Icon name="terminal" /></button>
        {!modelPicker && <div class="composer-agent">{agentSelector}</div>}
        {running && !mock && <button class="secondary" type="button" onClick={onStop} disabled={working}>Stop</button>}
        <div class={disabledReason ? 'composer-submit is-disabled' : 'composer-submit'}>
          {disabledReason && <span id="send-disabled-reason" role="status">{disabledReason}</span>}
          <button class="icon-button send" type="submit" aria-label="Send message" title="Send message"
            aria-describedby={disabledReason ? 'send-disabled-reason' : undefined}
            disabled={Boolean(disabledReason)}><Icon name="send" /></button>
        </div>
      </div>
    </form>
  );
}
