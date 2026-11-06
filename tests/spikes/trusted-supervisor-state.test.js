'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {envelope, inspect} = require('../../runtime/candidates/trusted-supervisor-spike/supervisor');
const record = {version:1, journalVersion:1, server:'fixture-server', session:'session', window:'window', pane:'pane', pid:123, processStart:'start-1', generation:'gen-1'};
test('crash and live watcher remain quarantined without stale lock removal', async () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mba-state-')); const journal=path.join(dir,'journal'); const lock=path.join(dir,'lock');
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']); const watcher=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);
 try { const binding={...record,pid:child.pid,processStart:'fixture-start-identity'}; fs.writeFileSync(journal,JSON.stringify(envelope(binding))); fs.writeFileSync(lock,'stale'); const exited=once(child,'exit'); child.kill('SIGKILL'); const [,signal]=await exited; assert.equal(signal,'SIGKILL'); assert.equal(watcher.exitCode,null); assert.equal(inspect(journal,binding).reason,'INDEPENDENT_RECONCILIATION_REQUIRED'); assert.equal(inspect(journal,binding).authorized,false); assert.equal(fs.readFileSync(lock,'utf8'),'stale'); } finally { child.kill('SIGKILL'); watcher.kill('SIGKILL'); fs.rmSync(dir,{recursive:true,force:true}); }
});
test('invalid, symlink, tampered, old and ABA journals fail closed', () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mba-state-')); const file=path.join(dir,'journal');
 try {
  for(const contents of ['garbage',JSON.stringify({...envelope(record),integrity:'0'}),JSON.stringify(envelope({...record,version:0}))]) { fs.writeFileSync(file,contents); assert.equal(inspect(file,record).reason,'INVALID_JOURNAL'); }
  fs.writeFileSync(file,JSON.stringify(envelope(record))); assert.equal(inspect(file,{...record,generation:'gen-2'}).reason,'STALE_OR_ABA'); assert.equal(inspect(file,{...record,processStart:'reused-pid'}).reason,'STALE_OR_ABA'); assert.equal(inspect(file,{...record,journalVersion:2}).authorized,false);
  const link=path.join(dir,'link'); fs.symlinkSync(file,link); assert.equal(inspect(link,record).reason,'INVALID_JOURNAL'); assert.equal(inspect(file,null).authorized,false);
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
