import pty from 'node-pty';

// Keep each native pseudoconsole in its own process. The pinned node-pty inbox
// backend leaks host resources on natural shell exit (upstream issue #965).
// Process exit reclaims those handles without touching another terminal.
let terminal;
let ending = false;
let paused = false;
function stop() {
  if (ending) return;
  ending = true;
  terminal?.kill();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('message', value => {
  if (value.type === 'start' && !terminal) {
    try {
      terminal = pty.spawn(value.shell, ['-NoLogo'], {
        name: 'xterm-256color', cols: 100, rows: 30, cwd: value.cwd,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        useConpty: true, useConptyDll: true,
      });
      terminal.onData(data => {
        if (!process.connected) return stop();
        if (!process.send({ type: 'output', data }, () => { if (!ending && !paused) terminal.resume(); })) terminal.pause();
      });
      terminal.onExit(() => process.exit(0));
      process.send({ type: 'ready', pid: terminal.pid });
    } catch { process.exit(1); }
  } else if (terminal && !ending) {
    try {
      if (value.type === 'input') terminal.write(value.data);
      else if (value.type === 'resize') terminal.resize(value.cols, value.rows);
      else if (value.type === 'pause') { paused = true; terminal.pause(); }
      else if (value.type === 'resume') { paused = false; terminal.resume(); }
      else if (value.type === 'end') stop();
    } catch { stop(); }
  }
});
process.on('disconnect', stop);
process.on('SIGTERM', stop);
