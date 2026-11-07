'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../ui/sidebar.js'), 'utf8');

// Only browser event/focus/layout primitives are simulated; the real controller runs in a fresh VM.
function controllerFixture({ narrow = true } = {}) {
  let document;
  class Element {
    constructor(tagName, id = '') {
      this.tagName = tagName.toUpperCase(); this.id = id;
      this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {};
      this.hidden = false; this.disabled = false; this.inert = false; this.open = false;
      this.visible = true; this.visibility = 'visible'; this.className = '';
      this.tabIndex = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'A'].includes(this.tagName) ? 0 : -1;
      this.style = { setProperty() {} };
      this.classList = {
        contains: name => this.className.split(' ').includes(name),
        add: name => { if (!this.classList.contains(name)) this.className = `${this.className} ${name}`.trim(); },
        remove: name => { this.className = this.className.split(' ').filter(value => value !== name).join(' '); },
      };
    }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
      this.parentElement = null;
    }
    append(...children) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); } }
    prepend(...children) {
      for (const child of children) child.remove();
      for (const child of children) child.parentElement = this;
      this.children.unshift(...children);
    }
    before(child) {
      child.remove();
      child.parentElement = this.parentElement;
      this.parentElement.children.splice(this.parentElement.children.indexOf(this), 0, child);
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    matches(selector) {
      return selector.split(',').some(part => {
        const value = part.trim();
        if (value === ':disabled') return this.disabled || Boolean(this.parentElement?.closest('fieldset[disabled]'));
        const tag = value.match(/^[a-z]+/i)?.[0];
        if (tag && this.tagName !== tag.toUpperCase()) return false;
        const className = value.match(/\.([\w-]+)/)?.[1];
        if (className && !this.classList.contains(className)) return false;
        for (const match of value.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
          const actual = ['hidden', 'inert', 'open', 'disabled'].includes(match[1])
            ? (this[match[1]] ? '' : undefined) : match[1] === 'tabindex' ? (this.tabIndex >= 0 ? String(this.tabIndex) : undefined) : this.attributes[match[1]];
          if (actual === undefined || (match[2] !== undefined && actual !== match[2])) return false;
        }
        return Boolean(tag || className || value.startsWith('['));
      });
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    contains(node) { return Boolean(node && (node === this || this.children.some(child => child.contains(node)))); }
    querySelectorAll(selector) {
      const found = [];
      for (const child of this.children) {
        if (child.matches(selector)) found.push(child);
        found.push(...child.querySelectorAll(selector));
      }
      return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getClientRects() {
      if (this.closest('[hidden], [inert]')) return [];
      for (let node = this; node; node = node.parentElement) {
        if (!node.visible) return [];
        if (node.parentElement?.tagName === 'DETAILS' && !node.parentElement.open && node.tagName !== 'SUMMARY') return [];
      }
      return [{}];
    }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    dispatch(type, values = {}) {
      const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...values };
      for (let node = this; node; node = node.parentElement) {
        for (const listener of node.listeners[type] || []) listener(event);
      }
      return event;
    }
    focus() {
      if (this.disabled || !this.getClientRects().length || this.visibility === 'hidden') return;
      const previous = document.activeElement;
      document.activeElement = this;
      if (previous && previous !== this) previous.dispatch('focusout', { relatedTarget: this });
    }
    click() { return this.dispatch('click'); }
  }
  document = new Element('document');
  document.documentElement = new Element('html');
  document.body = new Element('body');
  document.append(document.documentElement); document.documentElement.append(document.body);
  document.activeElement = document.body;
  const nodes = {};
  const add = (tag, id, parent = document.body) => {
    const node = new Element(tag, id); if (id) nodes[id] = node; parent.append(node); return node;
  };
  document.getElementById = id => nodes[id] || null;
  const sidebar = add('aside', 'sidebar');
  add('button', 'sidebar-close', sidebar);
  add('input', 'session-search', sidebar);
  add('button', 'new-tab', sidebar);
  const active = add('button', 'active-row', sidebar); active.className = 'session-open'; active.setAttribute('aria-pressed', 'true');
  add('button', 'disabled-control', sidebar).disabled = true;
  add('button', 'hidden-control', sidebar).hidden = true;
  add('button', 'invisible-control', sidebar).visibility = 'hidden';
  const inert = add('div', 'inert-region', sidebar); inert.inert = true; add('button', 'inert-control', inert);
  const fieldset = add('fieldset', 'disabled-fieldset', sidebar); fieldset.disabled = true; add('button', 'fieldset-control', fieldset);
  const untabbable = add('button', 'untabbable-control', sidebar); untabbable.tabIndex = -1;
  add('div', 'sidebar-resizer'); add('button', 'sidebar-backdrop');
  const main = add('main', 'main');
  add('button', 'sidebar-toggle', main);
  const actions = add('div', 'session-actions', main);
  for (const id of ['new-session', 'reconnect', 'fullscreen']) add('button', id, actions);
  const menu = add('details', 'toolbar-menu', main);
  add('summary', 'menu-summary', menu);
  const panel = add('div', 'toolbar-menu-panel', menu);
  add('button', 'rename-tab', panel);
  add('select', 'theme', panel); add('input', 'menu-input', panel); add('textarea', 'menu-textarea', panel);
  const viewActions = add('div', 'view-actions', main);
  add('button', 'keys-toggle', viewActions);
  add('button', 'latest', main);
  const connection = add('div', 'connection', main); connection.className = 'connection';
  add('button', 'retry', connection);
  add('button', 'outside', main);
  const dialog = add('dialog', 'close-dialog'); add('button', 'dialog-cancel', dialog);
  const media = matches => ({
    matches, listeners: [], addEventListener(_type, listener) { this.listeners.push(listener); },
    change(value) { this.matches = value; for (const listener of this.listeners) listener({ matches: value }); },
  });
  const narrowMedia = media(narrow), themeMedia = media(true);
  const window = {
    localStorage: { getItem: () => null, setItem() {} }, location: { origin: 'http://fixture.invalid' },
    matchMedia: query => query.includes('max-width') ? narrowMedia : themeMedia,
    getComputedStyle: node => ({ visibility: node.visibility }),
    requestAnimationFrame: callback => callback(), addEventListener() {},
  };
  vm.runInNewContext(source, { document, window });
  const controller = window.TerminalSidebar.create();
  return { controller, document, nodes, narrowMedia };
}

test('narrow drawer focuses its close button without opening the search keyboard and clears main inert on every close path', () => {
  const { controller, document, nodes } = controllerFixture();
  assert.equal(nodes.main.inert, false);
  assert.equal(controller.isDrawerOpen(), false);
  for (const dismiss of [() => nodes['sidebar-close'].click(), () => nodes['sidebar-backdrop'].click(), () => nodes['sidebar-toggle'].click(), () => controller.closeDrawer()]) {
    nodes['sidebar-toggle'].click();
    assert.equal(controller.isDrawerOpen(), true);
    assert.equal(nodes.main.inert, true);
    assert.equal(document.activeElement, nodes['sidebar-close']);
    assert.notEqual(document.activeElement, nodes['session-search']);
    assert.equal(nodes['sidebar-toggle'].attributes['aria-expanded'], 'true');
    dismiss();
    assert.equal(controller.isDrawerOpen(), false);
    assert.equal(nodes.main.inert, false);
    assert.equal(document.activeElement, nodes['sidebar-toggle']);
    assert.equal(nodes['sidebar-toggle'].attributes['aria-expanded'], 'false');
  }
});

test('drawer uses the visible active row if its close button is unavailable', () => {
  const { document, nodes } = controllerFixture();
  nodes['sidebar-close'].hidden = true;
  nodes['sidebar-toggle'].click();
  assert.equal(document.activeElement, nodes['active-row']);
  assert.notEqual(document.activeElement, nodes['session-search']);
});

test('drawer Tab wraps only at visible enabled control boundaries and recovers focus outside the drawer', () => {
  const { document, nodes } = controllerFixture();
  nodes['sidebar-toggle'].click();
  const backwards = nodes['sidebar-close'].dispatch('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(backwards.defaultPrevented, true);
  assert.equal(document.activeElement, nodes['active-row'], 'disabled, hidden, inert, invisible and negative-tabindex controls are excluded');
  const forwards = nodes['active-row'].dispatch('keydown', { key: 'Tab' });
  assert.equal(forwards.defaultPrevented, true);
  assert.equal(document.activeElement, nodes['sidebar-close']);
  nodes['session-search'].focus();
  assert.equal(nodes['session-search'].dispatch('keydown', { key: 'Tab' }).defaultPrevented, false, 'native movement between interior controls stays intact');
  assert.equal(nodes['session-search'].dispatch('keydown', { key: 'Tab', shiftKey: true }).defaultPrevented, false);
  document.activeElement = document.body;
  assert.equal(document.body.dispatch('keydown', { key: 'Tab' }).defaultPrevented, true);
  assert.equal(document.activeElement, nodes['sidebar-close']);
});

test('open dialog or an event originating inside a dialog owns Escape and Tab before drawer handling', () => {
  const { controller, document, nodes } = controllerFixture();
  nodes['sidebar-toggle'].click();
  nodes['close-dialog'].open = true;
  nodes['dialog-cancel'].focus();
  for (const key of ['Escape', 'Tab']) {
    assert.equal(nodes['dialog-cancel'].dispatch('keydown', { key }).defaultPrevented, false);
    assert.equal(document.activeElement, nodes['dialog-cancel']);
    assert.equal(controller.isDrawerOpen(), true);
  }
  assert.equal(nodes['sidebar-close'].dispatch('keydown', { key: 'Escape' }).defaultPrevented, false, 'any open dialog protects even an outside target');
  nodes['close-dialog'].open = false;
  for (const key of ['Escape', 'Tab']) assert.equal(nodes['dialog-cancel'].dispatch('keydown', { key }).defaultPrevented, false, 'dialog ancestry is independently guarded');
  assert.equal(controller.isDrawerOpen(), true);
  nodes['sidebar-close'].focus();
  assert.equal(nodes['sidebar-close'].dispatch('keydown', { key: 'Escape' }).defaultPrevented, true);
  assert.equal(controller.isDrawerOpen(), false);
  assert.equal(nodes.main.inert, false);
  assert.equal(document.activeElement, nodes['sidebar-toggle']);
});

test('leaving narrow closes the drawer without stealing focus and wide layouts never become inert or trapped', () => {
  const { controller, document, nodes, narrowMedia } = controllerFixture();
  nodes['sidebar-toggle'].click();
  nodes['active-row'].focus();
  narrowMedia.change(false);
  assert.equal(controller.isNarrow(), false);
  assert.equal(controller.isDrawerOpen(), false);
  assert.equal(nodes.main.inert, false);
  assert.equal(document.activeElement, nodes['active-row']);
  assert.equal(nodes['active-row'].dispatch('keydown', { key: 'Tab' }).defaultPrevented, false);
  nodes['sidebar-toggle'].click();
  assert.equal(controller.isDrawerOpen(), false);
  assert.equal(nodes.main.inert, false);
  narrowMedia.change(true);
  assert.equal(controller.isDrawerOpen(), false);
  nodes['sidebar-toggle'].click();
  assert.equal(controller.isDrawerOpen(), true);
  assert.equal(nodes.main.inert, true);
  const wide = controllerFixture({ narrow: false });
  assert.equal(wide.nodes.main.inert, false);
  assert.equal(wide.controller.isDrawerOpen(), false);
});

test('toolbar menu leaves form-control arrow and boundary keys native while preserving button navigation and Escape', () => {
  const { controller, document, nodes } = controllerFixture({ narrow: false });
  const menu = nodes['toolbar-menu'];
  menu.open = true;
  for (const id of ['theme', 'menu-input', 'menu-textarea']) {
    nodes[id].focus();
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
      assert.equal(nodes[id].dispatch('keydown', { key }).defaultPrevented, false, `${id} ${key}`);
      assert.equal(document.activeElement, nodes[id]);
      assert.equal(menu.open, true);
    }
  }
  nodes['menu-summary'].focus();
  assert.equal(nodes['menu-summary'].dispatch('keydown', { key: 'ArrowDown' }).defaultPrevented, true);
  assert.equal(document.activeElement, nodes['rename-tab']);
  nodes['rename-tab'].dispatch('keydown', { key: 'End' });
  assert.equal(document.activeElement, nodes['menu-textarea']);
  nodes['rename-tab'].focus();
  nodes['rename-tab'].dispatch('keydown', { key: 'Home' });
  assert.equal(document.activeElement, nodes['rename-tab']);
  nodes.theme.focus();
  assert.equal(nodes.theme.dispatch('keydown', { key: 'Escape' }).defaultPrevented, true);
  assert.equal(menu.open, false);
  assert.equal(document.activeElement, nodes['menu-summary']);
  menu.open = true;
  controller.closeMenu();
  assert.equal(menu.open, false);
  assert.equal(document.activeElement, nodes['menu-summary'], 'public closeMenu keeps its existing focus contract');
});

test('toolbar menu dismisses on outside pointerdown and focus leaving, not on internal movement', () => {
  const { document, nodes } = controllerFixture({ narrow: false });
  const menu = nodes['toolbar-menu'];
  menu.open = true;
  nodes['rename-tab'].focus();
  nodes.theme.dispatch('pointerdown');
  assert.equal(menu.open, true);
  nodes.theme.focus();
  assert.equal(menu.open, true, 'focusout with another menu control as relatedTarget stays open');
  nodes.outside.dispatch('pointerdown');
  assert.equal(menu.open, false);
  assert.equal(document.activeElement, nodes.theme, 'pointer dismissal must not steal focus back to summary');
  menu.open = true;
  nodes.outside.focus();
  assert.equal(menu.open, false);
  assert.equal(document.activeElement, nodes.outside);
  menu.open = true;
  nodes['rename-tab'].focus();
  nodes['rename-tab'].dispatch('focusout', { relatedTarget: null });
  assert.equal(menu.open, false, 'focus leaving the document also dismisses');
});

test('narrow menu preserves action identity, keyboard activation and focus across breakpoint changes', () => {
  const { document, nodes, narrowMedia } = controllerFixture({ narrow: false });
  const create = nodes['new-session'];
  let creations = 0;
  create.addEventListener('click', () => creations++);
  create.focus();
  narrowMedia.change(true);
  assert.equal(document.activeElement, create, 'a focused action stays reachable when it moves into the menu');
  assert.equal(nodes['toolbar-menu'].open, true);
  create.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(document.activeElement, nodes.reconnect);
  nodes.reconnect.dispatch('keydown', { key: 'Home' });
  assert.equal(document.activeElement, create);
  create.click();
  assert.equal(creations, 1);
  create.dispatch('keydown', { key: 'Escape' });
  assert.equal(nodes['toolbar-menu'].open, false);
  assert.equal(document.activeElement, nodes['menu-summary']);
  assert.equal(create.getClientRects().length, 0, 'closed menu actions must leave the tab order');
  nodes['menu-summary'].dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(document.activeElement, create);
  narrowMedia.change(false);
  assert.equal(document.activeElement, create);
  assert.equal(create.getClientRects().length, 1);
  for (let index = 0; index < 3; index++) { narrowMedia.change(true); narrowMedia.change(false); }
  create.click();
  assert.equal(creations, 2, 'resizing never installs another action handler');
  assert.equal(nodes['toolbar-menu'].contains(create), false);
  assert.equal(nodes['toolbar-menu'].contains(nodes['keys-toggle']), false);
  assert.equal(nodes.retry.parentElement, nodes.connection);
});

test('initial narrow layout includes retry and view controls in menu keyboard navigation', () => {
  const { document, nodes } = controllerFixture();
  nodes['menu-summary'].dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(document.activeElement, nodes['new-session']);
  for (const id of ['reconnect', 'retry', 'keys-toggle']) {
    document.activeElement.dispatch('keydown', { key: 'ArrowDown' });
    assert.equal(document.activeElement, nodes[id]);
  }
  nodes['keys-toggle'].dispatch('keydown', { key: 'Escape' });
  assert.equal(document.activeElement, nodes['menu-summary']);
  assert.equal(nodes['toolbar-menu'].open, false);
});
