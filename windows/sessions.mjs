import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import headless from '@xterm/headless';
import serialization from '@xterm/addon-serialize';

const { Terminal } = headless;
const { SerializeAddon } = serialization;

export function createSessions({ shell, cwd = os.homedir(), maxSessions = 20 } = {}) {
  const sessions = new Map();
  const shellPath = shell || path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  async function create() {
    if (sessions.size >= maxSessions) throw new Error('Session limit reached');
    const id = crypto.randomUUID();
    const terminal = new Terminal({ cols: 100, rows: 30, scrollback: 5000, allowProposedApi: true });
    const serializer = new SerializeAddon();
    terminal.loadAddon(serializer);
    const worker = fork(new URL('./pty-worker.mjs', import.meta.url), [], {
      windowsHide: true, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const send = message => { if (worker.connected) worker.send(message, () => {}); };
    const child = {
      write: data => send({ type: 'input', data }),
      resize: (cols, rows) => send({ type: 'resize', cols, rows }),
      pause: () => send({ type: 'pause' }), resume: () => send({ type: 'resume' }),
      kill: () => send({ type: 'end' }),
    };
    const session = { id, pid: null, terminal, serializer, child, worker, clients: new Set(), alive: true, pending: 0 };
    sessions.set(id, session);
    worker.on('message', message => {
      if (message.type !== 'output') return;
      const data = message.data;
      // Bound parser backlog as well as retained screen history. Never log output.
      session.pending += Buffer.byteLength(data);
      if (session.pending > 4 * 1024 * 1024) {
        child.pause();
      }
      terminal.write(data, () => {
        session.pending -= Buffer.byteLength(data);
        if (session.alive && session.pending < 1024 * 1024) child.resume();
        for (const client of session.clients) {
          if (client.readyState !== 1) continue;
          if (client.bufferedAmount > 2 * 1024 * 1024) client.close(1013, 'Reconnect to restore screen');
          else client.send(JSON.stringify({ type: 'output', data }));
        }
      });
    });
    worker.once('exit', () => {
      session.alive = false;
      sessions.delete(id);
      for (const client of session.clients) client.close(4004, 'Shell exited');
      terminal.dispose();
    });
    worker.on('error', () => {});
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { worker.kill(); reject(new Error('PowerShell startup timed out')); }, 10000);
        worker.once('exit', () => { clearTimeout(timeout); reject(new Error('PowerShell startup failed')); });
        worker.on('message', message => {
          if (message.type === 'ready') { session.pid = message.pid; clearTimeout(timeout); resolve(); }
        });
        send({ type: 'start', shell: shellPath, cwd });
      });
      return session;
    } catch (error) { sessions.delete(id); terminal.dispose(); throw error; }
  }
  return {
    create,
    get: id => sessions.get(id),
    list: () => [...sessions.values()].filter(session => session.pid && session.alive).map(({ id, pid }) => ({ id, pid })),
    end(id) {
      const session = sessions.get(id);
      if (!session) return false;
      if (!session.alive) return false;
      session.alive = false;
      for (const client of session.clients) client.close(4004, 'Shell ended');
      session.child.kill();
      return true;
    },
    async close() {
      const workers = [...sessions.values()].map(session => session.worker);
      for (const id of [...sessions.keys()]) this.end(id);
      await Promise.all(workers.map(worker => new Promise(resolve => {
        if (worker.exitCode !== null) return resolve();
        worker.once('exit', resolve);
      })));
    },
  };
}
