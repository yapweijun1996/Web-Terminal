'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const app = fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8');
const source = app.slice(0, app.indexOf('// End mobile viewport adapter.')) + '\nwindow.viewportAdapter = terminalViewport;';
function fixture({embedded = false, mobile = true, fallback = false} = {}) {
  const events = () => ({listeners:{},addEventListener(name,fn) {this.listeners[name] = fn;},removeEventListener(name) {delete this.listeners[name];}});
  const touch = {...events(),matches:mobile};
  const viewport = {...events(),height:844,offsetTop:0,scale:1};
  const tasks = [], properties = {}, classes = {};
  const window = {...events(),innerHeight:700,visualViewport:fallback ? undefined : viewport,matchMedia:() => touch,requestAnimationFrame:fn => tasks.push(fn)};
  window.parent = embedded ? {} : window;
  const document = {body:{classList:{toggle:(key,value) => {classes[key]=value;}}},documentElement:{style:{setProperty:(key,value) => {properties[key]=value;},removeProperty:key => {delete properties[key];}}}};
  vm.runInNewContext(source,{window,document});
  return {window,touch,viewport,properties,classes,tasks,flush:() => {while(tasks.length) tasks.shift()();}};
}
test('outer viewport coalesces keyboard events, preserves zoom and handles fallback/desktop', () => {
  const f = fixture(); f.flush();
  Object.assign(f.viewport,{height:420,offsetTop:32});
  f.viewport.listeners.resize();f.viewport.listeners.scroll();f.window.listeners.pageshow();
  assert.equal(f.tasks.length,1);f.flush();
  assert.equal(f.properties['--terminal-viewport-height'],'420px');
  assert.equal(f.properties['--terminal-viewport-top'],'32px');
  Object.assign(f.viewport,{height:210,scale:2});f.viewport.listeners.resize();f.flush();
  assert.equal(f.properties['--terminal-viewport-height'],'420px');
  Object.assign(f.viewport,{height:0,scale:1});f.viewport.listeners.resize();f.flush();
  assert.equal(f.properties['--terminal-viewport-height'],'420px');
  f.touch.matches=false;f.touch.listeners.change();f.flush();
  assert.deepEqual(f.properties,{});assert.equal(f.classes['terminal-visual-viewport'],false);
  const fallback = fixture({fallback:true});fallback.flush();assert.equal(fallback.properties['--terminal-viewport-height'],'700px');
  const desktop = fixture({mobile:false});desktop.flush();assert.deepEqual(desktop.properties,{});
});
for (const mode of ['history','live','alternate','width','buffer-switch','desktop']) {
  test(`embedded ttyd resize preserves scroll ownership: ${mode}`, () => {
    const f = fixture({embedded:true,mobile:mode !== 'desktop'});
    const buffer = {type:mode === 'alternate' ? 'alternate' : 'normal',viewportY:mode === 'live' ? 200 : 30,baseY:200};
    const restored=[],focus=[];
    const term={cols:80,buffer:{active:buffer},textarea:{style:{},focus:options => focus.push(options)},scrollToLine:line => restored.push(line),resize(cols) {this.cols=cols;buffer.viewportY+=10;if(mode==='buffer-switch') this.buffer.active={...buffer};}};
    term.element = {};
    const iframe = {contentWindow:{...f.window,term}};
    f.window.viewportAdapter.install(iframe);
    const resize=term.resize;f.window.viewportAdapter.install(iframe);assert.equal(term.resize,resize,'installation is idempotent');
    term.resize(mode === 'width' ? 40 : 80,20);
    assert.deepEqual(restored,mode==='history' ? [30] : []);
    term.textarea.focus({focusVisible:true});
    assert.equal(focus[0].preventScroll,mode==='desktop' ? undefined : true);
    assert.equal(focus[0].focusVisible,true);
    assert.equal(term.textarea.style.fontSize,mode==='desktop' ? '' : '16px');
  });
}

test('frame removal restores methods and listeners, and installation can recover', () => {
  const f = fixture();
  const resize = () => {}, focus = () => {};
  const term = {cols:80,element:{},textarea:{style:{fontSize:'12px'},focus},resize};
  const iframe = {contentWindow:{...f.window,term}};
  f.window.viewportAdapter.install(iframe);
  assert.notEqual(term.resize, resize);
  f.window.viewportAdapter.forget(iframe);
  f.flush();
  assert.equal(term.resize,resize);
  assert.equal(term.textarea.focus,focus);
  assert.equal(term.textarea.style.fontSize,'12px');
  f.window.viewportAdapter.install(iframe);
  assert.notEqual(term.resize,resize);
  f.window.viewportAdapter.forget(iframe);
});

test('inaccessible or not-yet-opened iframe is left alone', () => {
  const f = fixture();
  f.window.viewportAdapter.install({get contentWindow() {throw Error('cross origin');}});
  f.window.viewportAdapter.install({contentWindow:{}});
  f.flush();
  assert.equal(f.properties['--terminal-viewport-height'],'844px');
});

for (const trimmedAway of [false,true]) {
  test(`full history follows public marker during row shrink: trimmed away=${trimmedAway}`, () => {
    const f = fixture();
    const buffer = {type:'normal',viewportY:30,baseY:1000,cursorY:23};
    const marker = {line:30,isDisposed:false,dispose() {this.disposed=true;}};
    const restored=[];
    const term = {cols:80,element:{},textarea:{style:{},focus() {}},buffer:{active:buffer},
      registerMarker(offset) {assert.equal(offset,30-1000-23);return marker;},
      resize() {marker.line-=20;marker.isDisposed=trimmedAway;},
      scrollToLine(line) {restored.push(line);}};
    const iframe={contentWindow:{...f.window,term}};
    f.window.viewportAdapter.install(iframe);
    term.resize(80,10);
    assert.deepEqual(restored,trimmedAway ? [] : [10]);
    assert.equal(marker.disposed,true);
    f.window.viewportAdapter.forget(iframe);
  });
}
