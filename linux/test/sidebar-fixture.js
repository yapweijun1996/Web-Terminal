'use strict';

// App behavior fixtures isolate browser layout; the browser smoke covers the real controller.
function installSidebarFixture(window, document, nodes, Element) {
  for (const id of ['new-session', 'reconnect', 'current-name', 'current-secondary', 'search-results', 'session-search', 'toolbar-menu', 'view-actions']) nodes[id] = new Element();
  document.addEventListener = () => {};
  window.setInterval = () => 1;
  window.clearInterval = () => {};
  window.TerminalSidebar = {
    ...require('../ui/sidebar'),
    create: () => ({
      prefs: { pins: [], collapsed: {} }, save() {}, closeDrawer() {}, closeMenu() {},
      isDrawerOpen: () => false, isNarrow: () => false, applyTheme() {}, refit() {},
    }),
  };
}
const rows = nodes => nodes.tabs.children.filter(child => child.className?.split(' ').includes('tab'));
module.exports = { installSidebarFixture, rows };
