import { terminalText } from '../data/mock.js';
import { Icon } from './icon.jsx';

export function Terminal({ open, onToggle, mock }) {
  return (
    <aside class={open ? 'terminal is-open' : 'terminal'} aria-label="Terminal pane">
      <button class="terminal-toggle" aria-controls="terminal-output" aria-expanded={open} onClick={onToggle}>
        <Icon name="terminal" size={18} /><span>Terminal</span><Icon name="chevron" size={15} />
      </button>
      <div class="terminal-output" id="terminal-output" hidden={!open}>
        {mock ? <>
          <div class="terminal-caption">Sample output</div>
          <pre tabIndex={0} aria-label="Terminal output">{terminalText}</pre>
        </> : <p class="terminal-caption">Terminal panel is not connected in this build</p>}
      </div>
    </aside>
  );
}
