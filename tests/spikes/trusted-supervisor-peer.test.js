'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {spawn, spawnSync} = require('node:child_process');
const {once} = require('node:events');
const source=path.resolve(__dirname,'../../runtime/candidates/trusted-supervisor-spike/peer.c');
test('native AF_UNIX peer credentials and strict frames', async t => {
 const dir=fs.mkdtempSync(path.join('/tmp','mba-peer-')); const bin=path.join(dir,'peer');
 try {
  const build=spawnSync('cc',['-std=c11','-Wall','-Wextra','-Werror',source,'-o',bin],{encoding:'utf8'}); assert.equal(build.status,0,build.stderr);
  if (process.platform !== 'darwin') { const result=spawnSync(bin,['x','1'],{encoding:'utf8'}); assert.equal(result.status,77); assert.match(result.stderr,/ERR_UNSUPPORTED/); return; }
  async function run(expected,frame,reply,code) {
   const sock=path.join(dir,'s'); const server=spawn(bin,[sock,String(expected)]); let stderr=''; server.stderr.on('data',x=>stderr+=x); const done=once(server,'exit');
   try {
    const [chunk]=await Promise.race([once(server.stdout,'data'),done.then(([c])=>{throw Error(`server exited ${c}: ${stderr}`);})]); assert.match(String(chunk),/READY/);
    assert.equal(fs.statSync(dir).mode & 0o777,0o700); const st=fs.lstatSync(sock); assert.ok(st.isSocket()); assert.equal(st.mode & 0o777,0o600); assert.equal(st.uid,process.getuid());
    const client=net.createConnection(sock); client.on('error',()=>{}); await once(client,'connect'); let data=''; client.on('data',x=>data+=x); client.end(frame); await new Promise(resolve => client.on('close', resolve)); const [exit]=await done;
    assert.equal(exit,code,stderr); if (code === 0) console.log(stderr.trim()); if (code === 72) { assert.ok(data === '' || data === reply); assert.match(stderr,/ERR_DENIED/); } else assert.equal(data,reply); assert.match(stderr,new RegExp(`PEER uid=${process.getuid()} gid=${process.getgid()}`));
   } finally { server.kill('SIGKILL'); try {fs.unlinkSync(sock);} catch {} }
  }
  await t.test('actual UID allowed',()=>run(process.getuid(),'echo\n','OK echo\n',0));
  await t.test('mismatched UID denied despite forged claim',()=>run(process.getuid()+1,'{"uid":0}\n','ERR_DENIED\n',72));
  await t.test('claimed UID never accepted as a command',()=>run(process.getuid(),'{"uid":0}\n','ERR_FRAME\n',73));
  await t.test('invalid frame denied',()=>run(process.getuid(),'bad\n','ERR_FRAME\n',73));
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
