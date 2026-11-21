export function relativeTime(lastUsedAt, now = Date.now()) {
  const minutes = Math.floor((now - lastUsedAt) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1_440)}d ago`;
}

export function formatHistoryEntry(entry, now) {
  const codex = entry.agent === 'codex';
  const folder = entry.relPath === '.' ? 'Project root' : entry.relPath;
  return {
    id: entry.cliSessionId,
    label: codex ? 'Codex CLI' : 'Claude Code',
    detail: `${folder} · ${relativeTime(entry.lastUsedAt, now)}`,
  };
}

export function newestResumableEntry(entries, { rootId, relPath, agent }) {
  let newest;
  for (const entry of entries) {
    if (entry.rootId === rootId && entry.relPath === relPath && entry.agent === agent &&
        (!newest || entry.lastUsedAt > newest.lastUsedAt)) {
      newest = entry;
    }
  }
  return newest;
}
