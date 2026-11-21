import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const WORKSPACE = '/workspace/project';
const HOME = '/home/user';
const UUID = /[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}/gi;
const PATH_BOUNDARY = String.raw`(?=/|$|[\s"'\x60<>|:;,()[\]{}])`;
const HOME_ROOT = String.raw`(?:/(?:Users|home|var/home|export/home)/([^/\s"'\x60<>|:;,()[\]{}]+)|/root${PATH_BOUNDARY})`;
const TEMP_ROOT = String.raw`/(?:private/)?(?:tmp|var/tmp|var/folders|run/user|dev/shm)${PATH_BOUNDARY}`;
const DEVICE_ROOT = String.raw`/dev/(?=pts/|tty(?:s?\d|${PATH_BOUNDARY})|cu\.)`;
const PATH_CHARACTERS = String.raw`[^\s"'\x60<>|:;,()[\]{}\\]*`;
const PRIVATE_PATH = new RegExp(`(?:${HOME_ROOT}|${TEMP_ROOT}|${DEVICE_ROOT})${PATH_CHARACTERS}`, 'g');
const HOME_PREFIX = new RegExp(`^${HOME_ROOT}`);
const TEMP_OR_DEVICE_PREFIX = new RegExp(`^(?:${TEMP_ROOT}|${DEVICE_ROOT})`);
const CWD_FIELDS = new Set(['cwd', 'originalcwd', 'workingdirectory']);
const SESSION_FIELDS = new Set(['sessionid', 'threadid']);
const USER_FIELDS = new Set(['user', 'username', 'loginname', 'owner', 'ownername']);
const HOST_FIELDS = new Set(['host', 'hostname', 'devicename', 'computername']);
const INIT_LISTS = {
  skills: 'example-skill',
  plugins: 'example-plugin',
  slash_commands: 'example-command',
  terminal_slash_commands: 'example-command',
  agents: 'example-agent',
  mcp_servers: 'example-server',
  memory_paths: '/home/user/memory',
};

const normalizeKey = key => key.replaceAll('_', '').toLowerCase();
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const digest = value => createHash('sha256').update(`web-terminal-fixture:${value}`).digest('hex');

function fakeUuid(value) {
  if (/^f17e0000-[\da-f]{4}-8[\da-f]{3}-8[\da-f]{3}-[\da-f]{12}$/.test(value)) return value;
  const hash = digest(value);
  return `f17e0000-${hash.slice(0, 4)}-8${hash.slice(4, 7)}-8${hash.slice(7, 10)}-${hash.slice(10, 22)}`;
}

function visitStrings(value, visit, key = '') {
  if (typeof value === 'string') visit(value, normalizeKey(key));
  else if (Array.isArray(value)) value.forEach(item => visitStrings(item, visit, key));
  else if (value && typeof value === 'object') {
    for (const [field, item] of Object.entries(value)) visitStrings(item, visit, field);
  }
}

function aliasPattern(names, flags = 'giu') {
  const alternatives = [...names].filter(Boolean).sort((a, b) => b.length - a.length).map(escapeRegExp);
  if (alternatives.length === 0) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}])`, flags);
}

function createRedactor(records, users, hosts) {
  const cwdPaths = new Set();
  const sessionIds = new Set();
  const userNames = new Set(users);
  const hostNames = new Set(hosts);
  visitStrings(records, (value, key) => {
    if (CWD_FIELDS.has(key) && value.startsWith('/') && value !== '/') {
      cwdPaths.add(value.replace(/\/+$/, ''));
    }
    if (SESSION_FIELDS.has(key)) sessionIds.add(value);
    if (USER_FIELDS.has(key)) userNames.add(value);
    if (HOST_FIELDS.has(key)) hostNames.add(value);
    for (const match of value.matchAll(PRIVATE_PATH)) {
      if (match[1] && match[1] !== 'user') userNames.add(match[1]);
    }
  });
  // Codex exec can expose the working directory only in the completed pwd output.
  for (const record of records) {
    const item = record?.item;
    if (record?.type === 'item.completed' && item?.type === 'command_execution' &&
        item.exit_code === 0 && /(?:^|\s)['"]?pwd['"]?$/.test(item.command?.trim() ?? '')) {
      const output = item.aggregated_output?.trim();
      if (output?.startsWith('/') && !/[\r\n]/.test(output)) cwdPaths.add(output);
    }
  }
  const userPattern = aliasPattern(userNames);
  const hostPattern = aliasPattern(hostNames);
  const sessionPattern = aliasPattern(sessionIds, 'gu');
  const workingDirectories = [...cwdPaths].sort((a, b) => b.length - a.length);
  const paths = workingDirectories.length
    ? new RegExp(`(?:${workingDirectories.map(escapeRegExp).join('|')})(?=/|$|[^\\p{L}\\p{N}_.-])${PATH_CHARACTERS}|${PRIVATE_PATH.source}`, 'gu')
    : PRIVATE_PATH;

  function redactIdentifiers(value) {
    value = value.replace(UUID, match => fakeUuid(match.toLowerCase()));
    return sessionPattern ? value.replace(sessionPattern, fakeUuid) : value;
  }

  function redactPath(path) {
    const cwd = workingDirectories.find(root => path === root || path.startsWith(`${root}/`));
    if (cwd) return WORKSPACE + path.slice(cwd.length);
    const home = path.match(HOME_PREFIX);
    if (home) return HOME + path.slice(home[0].length);

    const root = path.match(TEMP_OR_DEVICE_PREFIX)[0];
    const parts = path.slice(root.length).split('/').filter(Boolean).map(part => {
      const id = redactIdentifiers(part);
      if (id !== part || /^f17e0000-/.test(part)) return id;
      const extension = part.endsWith('.sock') ? '.sock' : '';
      return `path-${digest(part).slice(0, 12)}${extension}`;
    });
    const directory = root.startsWith('/dev/') && root !== '/dev/shm' ? 'device' : 'tmp';
    return [HOME, directory, ...parts].join('/');
  }

  return (value, key = '') => {
    if (!value) return value;
    if (CWD_FIELDS.has(key) && value.startsWith('/')) return WORKSPACE;
    if (SESSION_FIELDS.has(key) || key.endsWith('uuid')) {
      const id = value.match(UUID)?.[0];
      return fakeUuid(id === value ? id.toLowerCase() : value);
    }
    if (USER_FIELDS.has(key)) return 'user';
    if (HOST_FIELDS.has(key)) return 'host';
    if (/^mcp__[^_].*__/.test(value)) {
      value = value.replace(/^mcp__(.+?)__(?=.)/, (_, server) =>
        `mcp__${/^server-[\da-f]{12}$/.test(server) ? server : `server-${digest(server).slice(0, 12)}`}__`);
    }
    const isPrivatePath = path => HOME_PREFIX.test(path) || TEMP_OR_DEVICE_PREFIX.test(path) ||
      workingDirectories.some(cwd => path === cwd || path.startsWith(`${cwd}/`));
    if (key.endsWith('path') && isPrivatePath(value)) {
      value = redactPath(value);
    } else {
      // Quoted paths in messages can contain spaces that unquoted paths cannot.
      value = value.replace(/(["'\x60])(\/[^\r\n]*?)\1/g, (match, quote, path) =>
        isPrivatePath(path) ? quote + redactPath(path) + quote : match);
      value = value.replace(paths, redactPath);
    }
    value = value.replace(/~\/(?=[^\s])/g, `${HOME}/`);
    if (userPattern) value = value.replace(userPattern, 'user');
    if (hostPattern) value = value.replace(hostPattern, 'host');
    return redactIdentifiers(value);
  };
}

function genericSample(value, label, key = '') {
  if (typeof value === 'string') {
    if (key === 'path') return `${HOME}/${label}`;
    if (key === 'status') return 'connected';
    if (key === 'source') return 'example';
    if (key === 'version') return '1.0.0';
    if (key === 'description') return 'Example command';
    if (key === 'argumentHint') return '';
    return label;
  }
  if (Array.isArray(value)) return value.map(item => genericSample(item, label, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([field, item]) =>
      [field, genericSample(item, label, field)]));
  }
  return value;
}

function redactStreamDeltas(records, redact) {
  const replacements = new Map();
  const blocks = new Map();
  const fields = { text_delta: 'text', thinking_delta: 'thinking', input_json_delta: 'partial_json' };

  function flush() {
    for (const parts of blocks.values()) {
      const original = parts.map(({ value }) => value).join('');
      const sanitized = redact(original);
      if (original === sanitized) continue;

      // A path can span multiple deltas. Keep their order and retain a nonempty
      // fragment for each original nonempty delta whenever the text permits it.
      const characters = Array.from(sanitized);
      let offset = 0;
      let consumed = 0;
      parts.forEach(({ delta, value }, index) => {
        consumed += value.length;
        const remaining = parts.length - index - 1;
        const target = Math.round(consumed * characters.length / original.length);
        const end = Math.min(Math.max(offset + 1, target), Math.max(offset, characters.length - remaining));
        replacements.set(delta, characters.slice(offset, end).join(''));
        offset = end;
      });
    }
    blocks.clear();
  }

  for (const record of records) {
    if (record?.type !== 'stream_event') continue;
    const { type, index, delta } = record.event ?? {};
    if (type === 'message_start' || type === 'message_stop') flush();
    const field = fields[delta?.type];
    if (!field || typeof delta[field] !== 'string' || !delta[field]) continue;
    const key = `${index}:${field}`;
    if (!blocks.has(key)) blocks.set(key, []);
    blocks.get(key).push({ delta, value: delta[field] });
  }
  flush();
  return replacements;
}

function sanitize(records, users, hosts) {
  const redact = createRedactor(records, users, hosts);
  const deltaReplacements = redactStreamDeltas(records, redact);

  function walk(value, init, key = '') {
    if (init && Object.hasOwn(INIT_LISTS, key)) {
      const sample = Array.isArray(value) ? value.slice(0, 3) : value;
      return genericSample(sample, INIT_LISTS[key]);
    }
    if (init && key === 'tools' && Array.isArray(value)) {
      return value.filter(name => typeof name !== 'string' || !name.startsWith('mcp__'));
    }
    const field = normalizeKey(key);
    if (init && /^(?:org(?:anization)?|product|workspace|team)(?:id|name)?$/.test(field)) {
      return genericSample(value, 'example');
    }
    if (init && field === 'entrypoint' && typeof value === 'string') return 'cli';
    if (typeof value === 'string') return redact(value, field);
    if (Array.isArray(value)) return value.map(item => walk(item, init, key));
    if (value && typeof value === 'object') {
      const streamText = deltaReplacements.get(value);
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [
        name,
        streamText !== undefined && ['text', 'thinking', 'partial_json'].includes(name)
          ? streamText
          : walk(item, init, name),
      ]));
    }
    return value;
  }

  return records.map(record => {
    if (record?.type === 'system' && record.subtype === 'commands_changed' && Array.isArray(record.commands)) {
      record = { ...record, commands: genericSample(record.commands, 'example-command') };
    }
    return walk(record, record?.type === 'system' && record.subtype === 'init');
  });
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { user: { type: 'string', multiple: true }, host: { type: 'string', multiple: true } },
});
if (positionals.length === 0) {
  console.error('Usage: node sanitize-fixtures.mjs [--user alias] [--host alias] <fixture.jsonl> [...]');
  process.exitCode = 1;
}
for (const filename of positionals) {
  const source = readFileSync(filename, 'utf8');
  const lines = source.split(/(?<=\n)/);
  const records = lines.filter(line => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`Invalid JSON in record ${index + 1} of ${filename}`);
    }
  });
  const sanitized = sanitize(records, values.user ?? [], values.host ?? []);
  let index = 0;
  const result = lines.map(line => line.trim()
    ? JSON.stringify(sanitized[index++]) + (line.match(/\r?\n$/)?.[0] ?? '')
    : line).join('');
  if (result !== source) writeFileSync(filename, result);
}
