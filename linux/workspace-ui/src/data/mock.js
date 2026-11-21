export const projects = [
  { id: 'web-terminal', name: 'Web Terminal', source: 'Project Root' },
  { id: 'design-system', name: 'Design System', source: 'GitHub workspace' },
  { id: 'api-service', name: 'API Service', source: 'GitHub workspace' },
];

export const agents = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex CLI' },
];

export const recentSessions = [
  { id: 'session-workspace', projectId: 'web-terminal', agentId: 'claude', label: 'Workspace layout' },
  { id: 'session-components', projectId: 'design-system', agentId: 'codex', label: 'Component review' },
  { id: 'session-docs', projectId: 'api-service', agentId: 'claude', label: 'API documentation' },
];

export const user = { name: 'Alex Morgan', initials: 'AM' };

export const sampleSession = {
  id: recentSessions[0].id,
  prompt: 'Review the workspace layout and check how it behaves on smaller screens.',
};

export const sampleEvents = [
  { type: 'session_started' },
  {
    type: 'message_done',
    messageId: 'assistant-1',
    text: 'I found the main workspace layout. I’ll review the responsive styles, then check that the terminal can collapse on smaller screens.',
  },
  { type: 'tool_call_start', toolCallId: 'layout', name: 'Inspect workspace layout', input: { target: 'Workspace shell' } },
  { type: 'tool_call_output', toolCallId: 'layout', output: 'Found the project sidebar, chat column, and terminal pane.', isError: false },
  { type: 'tool_call_start', toolCallId: 'styles', name: 'Review responsive styles', input: { breakpoint: '768px' } },
  { type: 'tool_call_start', toolCallId: 'verify', name: 'Run layout checks', input: { checks: ['responsive layout'] } },
  { type: 'approval_request', approvalId: 'layout-checks', toolCallId: 'verify', toolName: 'Run layout checks', input: { checks: ['responsive layout'] }, options: ['allow', 'deny'] },
].map((event, index) => ({
  ...event,
  sessionId: sampleSession.id,
  turnId: 'turn-preview',
  seq: index + 1,
}));

export const terminalText = [
  'Workspace  Web Terminal',
  'Agent      Claude Code',
  '',
  '✓ Workspace layout located',
  '↳ Reviewing responsive styles…',
  '  Layout checks awaiting approval',
].join('\n');

export const mockReply = 'Your message was added to this preview. You can switch agents or open the terminal to explore the workspace.';
