import { useState } from 'preact/hooks';
import { agents, user } from '../data/mock.js';
import { Icon } from './icon.jsx';

export function WorkspaceSelect({ kind, value, onChange, label = kind, choices = agents, disabled, describedBy }) {
  return (
    <span class="select-wrap">
      <select aria-label={label} aria-describedby={describedBy} value={value} disabled={disabled || !choices.length}
        onChange={(event) => onChange(event.currentTarget.value)}>
        {!choices.length && <option value="">No projects</option>}
        {choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.name}</option>)}
      </select>
      <Icon name="chevron" size={14} />
    </span>
  );
}

export function Sidebar({
  projects, projectId, sessionId, sessions, open, mock, disabled, closeButtonRef, onClose, onFocusLeave, onProject, onSession, onNew, onClear,
}) {
  const [search, setSearch] = useState('');
  const visibleProjects = projects.filter((project) => project.name.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <aside id="workspace-sidebar" class={open ? 'sidebar is-open' : 'sidebar'} aria-label="Workspace navigation"
      onFocusOut={(event) => {
        if (open && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) onFocusLeave();
      }}>
      <div class="branding">
        <span class="brand-icon"><Icon name="brand" size={21} /></span>
        <span>AI Coding<br />Workspace</span>
        <button class="icon-button sidebar-close" type="button" aria-label="Close projects"
          ref={closeButtonRef} onClick={onClose}><Icon name="close" /></button>
      </div>
      <button class="new-session" disabled={disabled} onClick={onNew}><Icon name="plus" /> New Session</button>
      <nav class="nav-lists" aria-label="Projects and sessions">
        <section>
          <h2>Projects</h2>
          <label class="project-search">
            <Icon name="search" size={16} />
            <input type="search" placeholder="Search projects" aria-label="Search projects" value={search}
              onInput={(event) => setSearch(event.currentTarget.value)} />
          </label>
          {visibleProjects.map((project) => (
            <button class="nav-item" key={project.id} disabled={disabled} aria-pressed={project.id === projectId} onClick={() => onProject(project.id)}>
              <Icon name="folder" size={16} />
              <span>{project.name}<small>{project.source}</small></span>
            </button>
          ))}
          {visibleProjects.length === 0 && <p class="empty-list">No matching projects.</p>}
        </section>
        <section>
          <div class="section-heading">
            <h2>Recent Sessions</h2>
            <button class="quiet-button" onClick={onClear} disabled={!sessions.length}>Clear</button>
          </div>
          {sessions.map((session) => (
            <button class="nav-item" key={session.id} disabled={disabled}
              aria-pressed={mock ? session.id === sessionId : undefined} onClick={() => onSession(session)}>
              <Icon name="history" size={16} />
              <span>{session.label}{session.detail && <small>{session.detail}</small>}
                {session.modelDetail && <small>{session.modelDetail}</small>}</span>
            </button>
          ))}
          {sessions.length === 0 && <p class="empty-list">No recent sessions.</p>}
        </section>
      </nav>
      <div class="sidebar-footer">
        <details class="sidebar-detail">
          <summary><Icon name="settings" size={16} /> Settings</summary>
          <p>Theme follows your device preference.</p>
        </details>
        <details class="sidebar-detail">
          <summary><Icon name="help" size={16} /> Help</summary>
          <p>Select a project and agent to start a coding session.</p>
        </details>
        <div class="profile"><span class="avatar" aria-hidden="true">{mock ? user.initials : 'Y'}</span>{mock ? user.name : 'You'}</div>
      </div>
    </aside>
  );
}
