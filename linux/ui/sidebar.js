'use strict';

const TerminalSidebar = (() => {
  const storageKey = 'linux-web-terminal-sidebar-v1';
  const shells = new Set(['bash', 'zsh', 'sh', 'fish', 'dash']);
  const themes = {
    dark: { background: '#111318', foreground: '#e5e7eb', cursor: '#e5e7eb', selectionBackground: '#374151', selectionForeground: '#ffffff' },
    light: { background: '#ffffff', foreground: '#1f2937', cursor: '#1f2937', selectionBackground: '#bfdbfe', selectionForeground: '#111827' },
  };

  function clampWidth(value) {
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(320, Math.max(200, value)) : 240;
  }

  function normalizePrefs(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
      width: clampWidth(source.width),
      theme: ['dark', 'light', 'system'].includes(source.theme) ? source.theme : 'dark',
      pins: Array.isArray(source.pins) ? [...new Set(source.pins.filter(pin => typeof pin === 'string'))] : [],
      collapsed: { Pinned: source.collapsed?.Pinned === true, Sessions: source.collapsed?.Sessions === true },
    };
  }

  function readPrefs(storage) {
    try { return normalizePrefs(JSON.parse(storage.getItem(storageKey))); }
    catch { return normalizePrefs(null); }
  }

  function writePrefs(storage, prefs) {
    try { storage.setItem(storageKey, JSON.stringify(normalizePrefs(prefs))); return true; }
    catch { return false; }
  }

  function orderSessions(sessions, pins, label, query = '') {
    const pinned = new Set(pins);
    const needle = typeof query === 'string' ? query.trim().toLocaleLowerCase() : '';
    const first = [], rest = [];
    for (const session of sessions) {
      if (needle && !String(label(session)).toLocaleLowerCase().includes(needle)) continue;
      (pinned.has(session) ? first : rest).push(session);
    }
    return first.concat(rest);
  }

  function sessionStatus(present, connection, command) {
    const basename = typeof command === 'string' ? command.split('/').pop().replace(/[^a-zA-Z0-9_.+-]/g, '').slice(0, 24) : '';
    return {
      state: !present || connection !== 'Connected' ? 'Disconnected' : shells.has(basename) ? 'Idle' : 'Running',
      command: basename,
    };
  }

  function create({ refit: fit = () => {}, getFrames = () => [], onSearch = () => {}, onPrefsChange = () => {} } = {}) {
    const sidebar = document.getElementById('sidebar');
    const resizer = document.getElementById('sidebar-resizer');
    const opener = document.getElementById('sidebar-toggle');
    const backdrop = document.getElementById('sidebar-backdrop');
    const close = document.getElementById('sidebar-close');
    const search = document.getElementById('session-search');
    const theme = document.getElementById('theme');
    const menu = document.getElementById('toolbar-menu');
    const main = document.querySelector('main');
    const fullscreen = document.getElementById('fullscreen');
    let storage;
    try { storage = window.localStorage; } catch {}
    const prefs = readPrefs(storage);
    const systemTheme = window.matchMedia?.('(prefers-color-scheme: dark)');
    const narrow = window.matchMedia?.('(max-width: 1000px)');
    let scheduled = false;

    // Reparent the original controls, so menu navigation and event handlers stay shared.
    function placeToolbarActions() {
      const panel = document.getElementById('toolbar-menu-panel');
      const sessionActions = document.getElementById('session-actions');
      const viewActions = document.getElementById('view-actions');
      const latest = document.getElementById('latest');
      if (!panel || !sessionActions || !viewActions || !latest) return;
      const focused = document.activeElement;
      const movingFocus = sessionActions.contains(focused) || viewActions.contains(focused);
      if (narrow?.matches) {
        panel.prepend(sessionActions, viewActions);
        // Retry stays beside the status text after a dropped connection.
        if (movingFocus) menu.open = true;
      } else {
        panel.prepend(viewActions);
        menu.before(sessionActions);
      }
      if (movingFocus) focused.focus();
    }
    let drag = null;

    function refit() {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(() => { scheduled = false; fit(); });
    }

    function save() {
      const saved = writePrefs(storage, prefs);
      onPrefsChange(prefs);
      refit();
      return saved;
    }

    function showWidth() {
      document.body.style.setProperty('--sidebar-width', `${prefs.width}px`);
      resizer?.setAttribute('aria-valuemin', '200');
      resizer?.setAttribute('aria-valuemax', '320');
      resizer?.setAttribute('aria-valuenow', String(prefs.width));
      resizer?.setAttribute('aria-valuetext', `${prefs.width} pixels`);
    }

    function setWidth(value) {
      const width = clampWidth(value);
      if (width === prefs.width) return;
      prefs.width = width;
      showWidth();
      save();
      refit();
    }

    function focusableItems(container) {
      return [...(container?.querySelectorAll('summary, button, a[href], input, select, textarea, [tabindex]') || [])]
        .filter(item => !item.matches(':disabled') && item.tabIndex >= 0
          && !item.closest('[hidden], [inert]') && item.getClientRects().length
          && window.getComputedStyle(item).visibility !== 'hidden');
    }

    function dialogOwnsFocus(event) {
      return document.querySelector('dialog[open]') || event.target?.closest?.('dialog');
    }

    function closeDrawer(restoreFocus = true) {
      const wasOpen = document.body.classList.contains('sidebar-open');
      document.body.classList.remove('sidebar-open');
      opener?.setAttribute('aria-expanded', 'false');
      if (main) main.inert = false;
      if (wasOpen) {
        if (restoreFocus) opener?.focus();
        refit();
      }
    }

    function toggleDrawer() {
      if (document.body.classList.contains('sidebar-open')) { closeDrawer(); return; }
      if (!narrow?.matches) return;
      document.body.classList.add('sidebar-open');
      opener?.setAttribute('aria-expanded', 'true');
      if (main) main.inert = true;
      const items = focusableItems(sidebar);
      const active = sidebar?.querySelector('.session-open[aria-pressed="true"]');
      (items.includes(close) ? close : items.includes(active) ? active : items.find(item => item !== search))?.focus();
      refit();
    }

    function applyTheme() {
      const resolved = prefs.theme === 'system' ? (systemTheme?.matches === false ? 'light' : 'dark') : prefs.theme;
      document.documentElement.dataset.theme = resolved;
      if (theme) theme.value = prefs.theme;
      const frames = getFrames();
      const values = frames instanceof Map ? frames.values() : frames;
      for (const frame of values) {
        try {
          const win = frame.contentWindow;
          if (!win || win.location.origin !== window.location.origin || !win.term?.options) continue;
          win.term.options.theme = { ...win.term.options.theme, ...themes[resolved] };
          if (typeof win.term.options.minimumContrastRatio === 'number') {
            win.term.options.minimumContrastRatio = Math.max(4.5, win.term.options.minimumContrastRatio);
          }
        } catch { /* A cross-origin or navigating terminal must not block the remaining frames. */ }
      }
      refit();
    }

    resizer?.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0 || narrow?.matches) return;
      event.preventDefault();
      resizer.setPointerCapture(event.pointerId);
      drag = { id: event.pointerId, x: event.clientX, width: prefs.width };
    });
    resizer?.addEventListener('pointermove', event => {
      if (drag?.id === event.pointerId) setWidth(drag.width + event.clientX - drag.x);
    });
    function endResize(event) {
      if (drag?.id !== event.pointerId) return;
      drag = null;
      if (resizer.hasPointerCapture(event.pointerId)) resizer.releasePointerCapture(event.pointerId);
    }
    resizer?.addEventListener('pointerup', endResize);
    resizer?.addEventListener('pointercancel', endResize);
    resizer?.addEventListener('lostpointercapture', () => { drag = null; });
    resizer?.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      setWidth(prefs.width + (event.key === 'ArrowLeft' ? -16 : 16));
    });
    if (main) main.inert = false;
    opener?.setAttribute('aria-expanded', 'false');
    opener?.addEventListener('click', toggleDrawer);
    backdrop?.addEventListener('click', () => closeDrawer());
    close?.addEventListener('click', () => closeDrawer());
    search?.addEventListener('input', () => onSearch(search.value));
    theme?.addEventListener('change', () => {
      if (!['dark', 'light', 'system'].includes(theme.value)) return;
      prefs.theme = theme.value;
      save();
      applyTheme();
    });

    function closeMenu(restoreFocus = false) {
      if (!menu?.open) return;
      menu.open = false;
      if (restoreFocus) menu.querySelector('summary')?.focus();
      refit();
    }

    if (menu) {
      const summary = menu.querySelector('summary');
      const menuItems = () => focusableItems(menu).filter(item => item !== summary);
      menu.addEventListener('keydown', event => {
        if (event.defaultPrevented || dialogOwnsFocus(event)) return;
        if (event.key === 'Escape' && menu.open) {
          event.preventDefault();
          closeMenu(true);
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        if (event.target?.closest?.('select, input, textarea')) return;
        event.preventDefault();
        menu.open = true;
        const items = menuItems();
        if (!items.length) return;
        const index = items.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : event.key === 'ArrowDown' ? (index + 1) % items.length : (index <= 0 ? items.length : index) - 1;
        items[next].focus();
      });
      menu.addEventListener('toggle', refit);
      document.addEventListener('pointerdown', event => {
        if (!menu.contains(event.target)) closeMenu();
      });
      menu.addEventListener('focusout', event => {
        if (!menu.contains(event.relatedTarget)) closeMenu();
      });
    }
    document.addEventListener('keydown', event => {
      if (event.defaultPrevented || dialogOwnsFocus(event) || !narrow?.matches
        || !document.body.classList.contains('sidebar-open')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDrawer();
      } else if (event.key === 'Tab') {
        const items = focusableItems(sidebar);
        if (!items.length) { event.preventDefault(); return; }
        const index = items.indexOf(document.activeElement);
        if (index < 0 || (event.shiftKey ? index === 0 : index === items.length - 1)) {
          event.preventDefault();
          items[event.shiftKey ? items.length - 1 : 0].focus();
        }
      }
    });

    function fullscreenState() {
      fullscreen?.setAttribute('aria-pressed', String(document.fullscreenElement === main));
      refit();
    }
    if (fullscreen) {
      const supported = !!(main?.requestFullscreen && document.exitFullscreen && document.fullscreenEnabled !== false);
      fullscreen.hidden = !supported;
      fullscreen.setAttribute('aria-pressed', String(document.fullscreenElement === main));
      if (supported) fullscreen.addEventListener('click', async () => {
        try {
          if (document.fullscreenElement === main) await document.exitFullscreen();
          else await main.requestFullscreen();
        } catch { /* Fullscreen may be denied by browser policy. Keep its actual state. */ }
        fullscreenState();
      });
    }
    document.addEventListener('fullscreenchange', fullscreenState);
    window.addEventListener('resize', refit);
    function mediaListener(media, listener) {
      if (media?.addEventListener) media.addEventListener('change', listener);
      else media?.addListener?.(listener);
    }
    mediaListener(systemTheme, () => { if (prefs.theme === 'system') applyTheme(); });
    mediaListener(narrow, () => {
      if (!narrow.matches) closeDrawer(false);
      placeToolbarActions();
      refit();
    });
    placeToolbarActions();
    showWidth();
    applyTheme();
    return {
      prefs, save, closeDrawer, applyTheme, refit,
      isDrawerOpen: () => document.body.classList.contains('sidebar-open'),
      isNarrow: () => narrow?.matches === true,
      closeMenu: () => closeMenu(true),
    };
  }

  return { clampWidth, readPrefs, writePrefs, orderSessions, sessionStatus, create };
})();

if (typeof window !== 'undefined') window.TerminalSidebar = TerminalSidebar;
if (typeof module !== 'undefined' && module.exports) module.exports = TerminalSidebar;
