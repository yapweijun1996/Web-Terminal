// Mac browser workspace tabs v3. Browser preferences never rename or end tmux jobs.
(() => {
    const bar = document.getElementById('remote-toolbar'), terminal = document.querySelector('#terminal-container');
    const storageKey = 'web-terminal-tabs-v1';
    let windows = [], scope = '', preferences = {}, available = false, busy = false, polling = false;
    let endSnapshot = null, renameId = null, draggedId = null, storageWarning = '', actionError = '', lastSignature = '', switcherGeneration = 0;
    let targetGeneration = 0, lastTarget = targetKey(window.webTerminalTarget), lastActiveSignature, pendingTabFocus = null;
    function targetKey(target) {
        return target && [target.session, target.sessionId, target.serverPid, target.windowIndex, target.pane].join('|');
    }
    const identity = target => target && [target.session, target.sessionId, target.serverPid].join('|');
    const ready = () => Boolean(window.mbaTerminalReady?.() && window.webTerminalTarget && !document.hidden);
    const currentId = () => windows.find(item => item.active)?.id;
    const el = (tag, attrs = {}, text) => {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const button = (name, action, id) => {
        const node = el('button', {type:'button', 'data-action':action}, name);
        if (id) node.dataset.window = id;
        if (busy && ['select','restore','hide','end'].includes(action)) node.disabled = true;
        return node;
    };
    terminal?.addEventListener('contextmenu', event => {
        const mode = window.term?.modes?.mouseTrackingMode;
        if (!event.shiftKey && event.pointerType !== 'touch' && window.mbaTerminalReady?.() && typeof mode === 'string' && mode !== 'none') event.preventDefault();
    }, true);
    // Move existing controls intact so their handlers and upload integration stay owned there.
    const tools = el('details', {id:'workspace-tools'}), panel = el('section', {class:'workspace-tools-panel', 'aria-label':'Workspace tools'});
    tools.append(el('summary', {}, 'Workspace tools'), panel);
    const keep = node => node === tools || node.id === 'connection-status' || node.matches('button[data-key="c"]') || node === bar.firstElementChild;
    const compact = () => { for (const node of [...bar.children]) if (!keep(node)) panel.append(node); };
    bar.append(tools); compact(); new MutationObserver(compact).observe(bar, {childList:true});
    const newButton = bar.querySelector('[data-key="c"]');
    newButton.textContent = '+'; newButton.setAttribute('aria-label', 'New window'); newButton.title = 'New terminal window';
    const tabs = el('nav', {id:'window-tabs', 'aria-label':'Terminal window tabs'});
    const list = el('div', {id:'window-tab-list', role:'tablist', 'aria-label':'Visible terminal windows'});
    const all = button('All windows', 'all'); all.id = 'all-windows'; all.setAttribute('aria-keyshortcuts', 'Control+Alt+P');
    const status = el('span', {id:'window-tabs-status', role:'status', 'aria-live':'polite'});
    tabs.append(list, all); bar.after(tabs); document.body.append(status); tabs.hidden = true;
    const empty = el('section', {id:'window-empty-state', hidden:''});
    empty.append(el('h2', {}, 'All tabs hidden'), el('p', {}, 'Your windows and tasks are still attached. Restore a tab to view it.'), button('All windows', 'all'));
    const workspaceStatus = document.getElementById('workspace-status');
    tabs.after(workspaceStatus);
    workspaceStatus.after(empty);
    const switcher = el('dialog', {id:'window-switcher', 'aria-labelledby':'window-switcher-title'});
    switcher.innerHTML = '<header><h2 id="window-switcher-title">All windows</h2><button type="button" data-dismiss aria-label="Close window switcher">×</button></header><p class="window-help">Switch or restore a hidden tab. Hiding keeps its tasks running.</p><input id="window-search" type="search" aria-label="Search windows" placeholder="Search name, process or number"><div id="window-results"></div><p data-switcher-status role="status"></p>';
    const search = switcher.querySelector('#window-search'), results = switcher.querySelector('#window-results');
    const menu = el('div', {id:'window-tab-menu', role:'menu', hidden:''});
    const endDialog = el('dialog', {id:'close-window-dialog', 'aria-labelledby':'close-window-title', 'aria-describedby':'close-window-description'});
    endDialog.innerHTML = '<h2 id="close-window-title">End terminal window?</h2><p data-window></p><p id="close-window-description">This ends every pane in this window and may stop running tasks. Other windows stay open. Detached processes may continue.</p><p data-error role="status"></p><footer><button type="button" data-cancel>Cancel</button><button type="button" data-confirm>End window</button></footer>';
    const renameDialog = el('dialog', {id:'rename-window-dialog', 'aria-labelledby':'rename-window-title'});
    renameDialog.innerHTML = '<form><h2 id="rename-window-title">Rename tab</h2><label>Display name<input name="displayName" maxlength="80" autocomplete="off"></label><p>This name is saved only in this browser.</p><footer><button type="button" data-cancel>Cancel</button><button type="submit">Save</button></footer></form>';
    document.body.append(switcher, menu, endDialog, renameDialog);
    function load(server) {
        preferences = {}; scope = server; storageWarning = '';
        try {
            const stored = JSON.parse(localStorage.getItem(storageKey) || '{}');
            const values = stored && typeof stored.servers === 'object' && stored.servers?.[server];
            if (values && typeof values === 'object' && !Array.isArray(values)) for (const [id, value] of Object.entries(values).slice(0,100)) {
                if (!/^@\d+$/.test(id) || !value || typeof value !== 'object') continue;
                preferences[id] = {name:typeof value.name === 'string' ? value.name.replace(/[\x00-\x1f\x7f]/g,'').slice(0,80) : '', hidden:value.hidden === true, pinned:value.pinned === true, order:Number.isFinite(value.order) && value.order >= 0 && value.order <= 10000 ? value.order : 10000};
            }
        } catch { storageWarning = 'Browser storage unavailable; preferences last for this page.'; }
    }
    function pref(id) { return preferences[id] || (preferences[id] = {name:'', hidden:false, pinned:false, order:10000}); }
    function persist() {
        try {
            const data = JSON.parse(localStorage.getItem(storageKey) || '{}');
            const servers = data && typeof data.servers === 'object' && !Array.isArray(data.servers) ? data.servers : {};
            servers[scope] = Object.fromEntries(windows.map(item => [item.id, pref(item.id)]));
            localStorage.setItem(storageKey, JSON.stringify({version:1, servers}));
        } catch { storageWarning = 'Browser storage unavailable; preferences last for this page.'; }
    }
    const ordered = () => [...windows].sort((a,b) => Number(pref(b.id).pinned)-Number(pref(a.id).pinned) || pref(a.id).order-pref(b.id).order || Number(a.index)-Number(b.index));
    const name = item => pref(item.id).name || item.name;
    const processName = item => item.process || 'process unknown';
    async function request(action, target, id) {
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(),5000);
        try {
            const response = await fetch('/__terminal_upload', {method:'POST', cache:'no-store', redirect:'manual', signal:controller.signal,
                headers:{'X-Terminal-Action':action, 'X-Terminal-View':window.webTerminalViewId, 'X-Terminal-Session':target.session, 'X-Terminal-Session-Id':target.sessionId, 'X-Terminal-Pane':target.pane, 'X-Terminal-Server-Pid':target.serverPid,
                    ...(action === 'windows' ? {'X-Terminal-Tabs':'browser'} : {}), ...(id ? {'X-Terminal-Window':id} : {})}});
            if (!response.ok) throw Error('Window unavailable. Refresh and confirm again. Keep at least one window open.');
            const result = await response.json(); if (action === 'native-tabs') return result;
            if (!Array.isArray(result.windows) || !result.windows.length || result.windows.some(item => !/^@\d+$/.test(item.id) || !/^\d+$/.test(item.index) || typeof item.name !== 'string' || typeof item.active !== 'boolean')) throw Error('Window list unavailable');
            return result.windows;
        } finally { clearTimeout(timeout); }
    }
    function layout() { document.documentElement.style.setProperty('--window-tabs-height', `${tabs.getBoundingClientRect().height}px`); window.term?.fit(); }
    function emitActiveWindow() {
        const target = window.webTerminalTarget;
        const item = available && ready() && !busy && windows.find(entry => entry.active && entry.index === target.windowIndex);
        const rawProcess = typeof item?.process === 'string' ? item.process.trim() : '';
        const process = rawProcess && !/\s/.test(rawProcess) ? rawProcess.split(/[\\/]/).pop() : '';
        const detail = item ? {name:name(item), process} : null;
        const signature = JSON.stringify(detail);
        if (signature === lastActiveSignature) return;
        lastActiveSignature = signature;
        window.dispatchEvent(new CustomEvent('web-terminal-active-window', {detail}));
    }
    function restoreTabFocus() {
        if (!pendingTabFocus || !available || !ready() || busy) return;
        if (document.activeElement !== document.body && !list.contains(document.activeElement)) { pendingTabFocus = null; return; }
        const node = list.querySelector(`[data-action=select][data-window="${pendingTabFocus}"][aria-selected=true]`);
        if (node && !node.disabled) { pendingTabFocus = null; node.focus({preventScroll:true}); }
    }
    const closeMenu = () => { menu.hidden = true; for (const node of list.querySelectorAll('[data-action=menu]')) node.setAttribute('aria-expanded','false'); };
    function state() {
        emitActiveWindow();
        tabs.dataset.connection = available && ready() ? 'connected' : 'disconnected';
        status.textContent = actionError || storageWarning || (busy ? 'Switching window…' : '') || (available && ready() ? '' : 'Windows unavailable');
        const statusDetail = status.textContent === 'Windows unavailable' ? 'Windows unavailable — tasks may still be running.' : status.textContent;
        status.title = statusDetail;
        status.setAttribute('aria-label', statusDetail);
        for (const node of list.querySelectorAll('[data-action=select]')) {
            node.disabled = !available || !ready() || busy;
            const item = windows.find(entry => entry.id === node.dataset.window);
            if (item) node.querySelector('.tab-meta').textContent = `${processName(item)} · ${available && ready() ? 'Available' : 'Unavailable'}`;
        }
        for (const root of [list,switcher,menu]) for (const node of root.querySelectorAll('button[data-action]')) {
            if (['select','restore','end'].includes(node.dataset.action)) node.disabled = busy || !available || !ready();
            else if (node.dataset.action === 'hide') node.disabled = busy;
        }
        switcher.querySelector('[data-switcher-status]').textContent = status.textContent;
        restoreTabFocus();
    }
    function render(force = false) {
        const signature = JSON.stringify([windows,preferences]); if (!force && signature === lastSignature) { state(); return; } lastSignature = signature;
        const focusId = document.activeElement?.dataset.window, focusAction = document.activeElement?.dataset.action;
        tabs.hidden = !available;
        list.replaceChildren();
        for (const item of ordered().filter(item => !pref(item.id).hidden)) {
            const group = el('div', {class:'window-tab', 'data-window':item.id, draggable:'true', 'data-pinned':String(pref(item.id).pinned)});
            if (item.active) group.dataset.active = 'true';
            const select = button('', 'select', item.id);
            select.append(el('span', {class:'tab-name'}, `${pref(item.id).pinned ? '◆ ' : ''}${pref(item.id).name || `${item.index}: ${item.name}`}`), el('span', {class:'tab-meta'}, `${processName(item)} · ${available ? 'Available' : 'Unavailable'}`));
            select.setAttribute('role','tab'); select.setAttribute('aria-selected',String(item.active)); select.tabIndex = item.active ? 0 : -1;
            select.title = `Window ${item.index} · ${processName(item)} · ${available ? 'Available' : 'Unavailable'}; task health unknown`;
            const hide = button('×','hide',item.id); hide.setAttribute('aria-label',`Hide tab ${name(item)}`); hide.title = 'Hide tab; tasks keep running';
            const more = button('⋯','menu',item.id); more.setAttribute('aria-label',`Tab actions for ${name(item)}`); more.setAttribute('aria-haspopup','menu'); more.setAttribute('aria-controls','window-tab-menu'); more.setAttribute('aria-expanded',String(!menu.hidden && menu.dataset.window === item.id));
            group.append(select,hide,more); list.append(group);
        }
        const noVisible = windows.length > 0 && !list.children.length;
        empty.hidden = !noVisible; terminal?.classList.toggle('terminal-tabs-hidden',noVisible);
        state(); layout(); list.querySelector('[data-active=true]')?.scrollIntoView({block:'nearest',inline:'nearest'});
        if (focusId) list.querySelector(`button[data-window="${focusId}"][data-action="${focusAction}"]`)?.focus({preventScroll:true});
        if (switcher.open) renderResults();
    }
    function renderResults() {
        const query = search.value.toLocaleLowerCase().trim(); results.replaceChildren();
        for (const item of ordered().filter(item => `${name(item)} ${item.name} ${item.index} ${processName(item)}`.toLocaleLowerCase().includes(query))) {
            const row = el('article',{class:'window-result','data-window':item.id});
            const select = button(name(item),'select',item.id); select.className = 'window-result-select'; select.disabled = !available || !ready() || busy;
            const metadata = el('p',{},`Window ${item.index} · ${processName(item)} · ${pref(item.id).hidden ? 'Hidden' : 'Visible'}${pref(item.id).pinned ? ' · Pinned' : ''} · ${available && ready() ? 'Available' : 'Unavailable'}; task health unknown`);
            const actions = el('div',{class:'window-result-actions'});
            for (const [label,type] of [[pref(item.id).hidden ? 'Restore' : 'Hide',pref(item.id).hidden ? 'restore' : 'hide'],['Rename','rename'],[pref(item.id).pinned ? 'Unpin' : 'Pin','pin'],['Move left','move-left'],['Move right','move-right'],['End…','end']]) actions.append(button(label,type,item.id));
            row.append(select,metadata,actions); results.append(row);
        }
        if (!results.children.length) results.append(el('p',{class:'window-empty'},'No matching windows')); state();
    }
    function openSwitcher() { closeMenu(); search.value = ''; renderResults(); switcherGeneration++; switcher.showModal(); search.focus(); }
    async function selectWindow(id, focusTab = false, closeSwitcher = true) {
        if (busy || !available || !ready()) return;
        const target = {...window.webTerminalTarget}, generation = targetGeneration;
        // An async selection may finish after a new search was opened. Only
        // dismiss the exact switcher opening that initiated this selection.
        const initiatingSwitcher = switcher.open ? switcherGeneration : null;
        actionError = ''; busy = true; state();
        try {
            const response = await request('select-window',target,id);
            if (identity(target) !== identity(window.webTerminalTarget)) throw Error('Connection changed.');
            pref(id).hidden = false; persist();
            if (generation === targetGeneration) { windows = response; available = true; }
            if (switcher.open && closeSwitcher && initiatingSwitcher !== null && initiatingSwitcher === switcherGeneration) switcher.close(); busy = false; render(true);
            if (focusTab) { pendingTabFocus = id; restoreTabFocus(); } else window.term?.focus();
        } catch (error) { actionError = error.message; }
        finally { busy = false; state(); }
    }
    function hideWindow(id) {
        if (busy) return;
        const visible = ordered().filter(item => !pref(item.id).hidden), index = visible.findIndex(item => item.id === id), wasActive = id === currentId();
        pref(id).hidden = true; persist(); closeMenu(); render(true);
        const next = visible[index+1] || visible[index-1];
        if (wasActive && next) selectWindow(next.id, false, false); else if (!next) all.focus();
    }
    function moveWindow(id,destination) {
        const order = ordered(), from = order.findIndex(item => item.id === id), to = order.findIndex(item => item.id === destination);
        if (from < 0 || to < 0 || from === to) return;
        pref(id).pinned = pref(destination).pinned;
        const [item] = order.splice(from,1); order.splice(to,0,item);
        order.forEach((entry,index) => { pref(entry.id).order = index; }); persist(); render(true);
    }
    function openEnd(item) {
        closeMenu(); endSnapshot = {target:{...window.webTerminalTarget},item:{...item}};
        endDialog.querySelector('[data-window]').textContent = `Window ${item.index}: ${name(item)} (${processName(item)})`;
        endDialog.querySelector('[data-error]').textContent = windows.length <= 1 ? 'Keep at least one terminal window open. Create a new window first.' : '';
        endDialog.querySelector('[data-confirm]').disabled = !ready() || !available || windows.length <= 1;
        endDialog.showModal(); endDialog.querySelector('[data-cancel]').focus();
    }
    function action(type,id,anchor) {
        if (type === 'all') return openSwitcher();
        if (busy && ['select','restore','hide','end'].includes(type)) return;
        const item = windows.find(entry => entry.id === id); if (!item) return;
        if (type === 'select') return selectWindow(id);
        if (type === 'hide') return hideWindow(id);
        if (type === 'restore') { pref(id).hidden = false; persist(); render(true); if (available && ready()) selectWindow(id, false, false); return; }
        if (type === 'pin') { pref(id).pinned = !pref(id).pinned; persist(); closeMenu(); render(true); return; }
        if (type === 'move-left' || type === 'move-right') {
            const order = ordered(), at = order.findIndex(entry => entry.id === id), other = order[at+(type === 'move-left' ? -1 : 1)];
            if (other) moveWindow(id,other.id); closeMenu(); return;
        }
        if (type === 'rename') { closeMenu(); renameId = id; renameDialog.querySelector('input').value = pref(id).name || item.name; renameDialog.showModal(); renameDialog.querySelector('input').select(); return; }
        if (type === 'end') return openEnd(item);
        if (type === 'menu') {
            closeMenu(); menu.replaceChildren(); menu.dataset.window = id;
            for (const [label,value] of [['Rename tab','rename'],[pref(id).pinned ? 'Unpin tab' : 'Pin tab','pin'],['Move left','move-left'],['Move right','move-right'],['Hide tab','hide'],['End window…','end']]) { const entry = button(label,value,id); entry.setAttribute('role','menuitem'); menu.append(entry); }
            menu.hidden = false; anchor.closest('.window-tab')?.querySelector('[data-action=menu]')?.setAttribute('aria-expanded','true'); const rect = anchor.getBoundingClientRect(), bounds = menu.getBoundingClientRect();
            menu.style.left = `${Math.max(6,Math.min(rect.left,innerWidth-bounds.width-6))}px`;
            menu.style.top = `${Math.max(6,Math.min(rect.bottom+4,innerHeight-bounds.height-6))}px`; menu.querySelector('button').focus(); state();
        }
    }
    for (const root of [tabs,switcher,menu,empty]) root.addEventListener('click',event => { const node = event.target.closest('button[data-action]'); if (node) action(node.dataset.action,node.dataset.window,node); });
    tabs.addEventListener('contextmenu',event => { const node = event.target.closest('.window-tab'); if (!node || event.shiftKey) return; event.preventDefault(); action('menu',node.dataset.window,node); });
    list.addEventListener('dragstart',event => { const group = event.target.closest('.window-tab'); if (!group) return; draggedId = group.dataset.window; event.dataTransfer.setData('text/plain',draggedId); event.dataTransfer.effectAllowed = 'move'; });
    list.addEventListener('dragover',event => { if (draggedId && event.target.closest('.window-tab')) event.preventDefault(); });
    list.addEventListener('drop',event => { event.preventDefault(); const group = event.target.closest('.window-tab'); if (draggedId && group) moveWindow(draggedId,group.dataset.window); draggedId = null; });
    list.addEventListener('dragend',() => { draggedId = null; });
    document.addEventListener('pointerdown',event => { if (!menu.contains(event.target) && !event.target.closest('[data-action=menu]')) closeMenu(); });
    menu.addEventListener('keydown',event => {
        const items = [...menu.querySelectorAll('button')], at = items.indexOf(document.activeElement);
        if (event.key === 'Escape') { const id = menu.dataset.window; closeMenu(); list.querySelector(`[data-window="${id}"] button`)?.focus(); }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); items[(at+(event.key === 'ArrowDown' ? 1 : items.length-1))%items.length].focus(); }
    });
    search.addEventListener('input',renderResults); switcher.querySelector('[data-dismiss]').addEventListener('click',() => switcher.close()); switcher.addEventListener('close',() => all.focus());
    renameDialog.querySelector('[data-cancel]').addEventListener('click',() => renameDialog.close());
    renameDialog.querySelector('form').addEventListener('submit',event => { event.preventDefault(); if (windows.some(item => item.id === renameId)) { pref(renameId).name = renameDialog.querySelector('input').value.trim().slice(0,80); persist(); render(true); } renameDialog.close(); });
    endDialog.querySelector('[data-cancel]').addEventListener('click',() => { if (!busy) endDialog.close(); });
    endDialog.addEventListener('cancel',event => { if (busy) event.preventDefault(); }); endDialog.addEventListener('close',() => { endSnapshot = null; if (!switcher.open) all.focus(); });
    endDialog.querySelector('[data-confirm]').addEventListener('click',async () => {
        if (busy || !endSnapshot) return;
        const snapshot = endSnapshot, generation = targetGeneration, confirm = endDialog.querySelector('[data-confirm]'), cancel = endDialog.querySelector('[data-cancel]'); confirm.disabled = true;
        if (!available || !ready() || identity(snapshot.target) !== identity(window.webTerminalTarget)) { endDialog.querySelector('[data-error]').textContent = 'Connection changed. Cancel and confirm again.'; return; }
        busy = true; cancel.disabled = true;
        try {
            const response = await request('close-window',snapshot.target,snapshot.item.id);
            if (generation === targetGeneration) windows = response;
            delete preferences[snapshot.item.id]; persist(); endDialog.close(); render(true);
        }
        catch (error) { endDialog.querySelector('[data-error]').textContent = error.message; }
        finally { busy = false; cancel.disabled = false; state(); }
    });
    window.addEventListener('keydown',event => {
        if (event.metaKey || !event.ctrlKey || !event.altKey || event.shiftKey || !['ArrowLeft','ArrowRight','KeyW','KeyP'].includes(event.code) || document.querySelector('dialog[open]')) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.code === 'KeyP') return openSwitcher();
        if (event.code === 'KeyW') { if (currentId()) hideWindow(currentId()); return; }
        const visible = ordered().filter(item => !pref(item.id).hidden), at = visible.findIndex(item => item.id === currentId());
        if (visible.length) selectWindow(visible[(at+(event.code === 'ArrowRight' ? 1 : visible.length-1))%visible.length].id);
    },true);
    list.addEventListener('keydown',event => {
        const select = event.target.closest('[data-action=select]');
        if (!select || event.ctrlKey || event.metaKey || event.altKey || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation(); const visible = ordered().filter(item => !pref(item.id).hidden), at = visible.findIndex(item => item.id === select.dataset.window);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length-1 : (at+(event.key === 'ArrowRight' ? 1 : visible.length-1))%visible.length;
        if (visible[index]) selectWindow(visible[index].id,true);
    });
    async function refresh() {
        if (polling || !ready()) return;
        polling = true; const target = {...window.webTerminalTarget}, generation = targetGeneration;
        try {
            const response = await request('windows',target);
            if (generation === targetGeneration && ready() && targetKey(target) === targetKey(window.webTerminalTarget)) { if (scope !== target.serverPid) load(target.serverPid); windows = response; available = true; tabs.hidden = false; actionError = ''; render(); }
        } catch {
            if (generation === targetGeneration) {
                await request('native-tabs',target).catch(() => {});
                if (generation === targetGeneration) { available = false; tabs.hidden = true; layout(); state(); }
            }
        } finally {
            polling = false;
            if (generation !== targetGeneration && ready()) refresh();
        }
    }
    window.addEventListener('web-terminal-target',() => {
        const next = targetKey(window.webTerminalTarget);
        if (next !== lastTarget) { lastTarget = next; targetGeneration++; available = false; state(); }
        refresh();
    });
    window.addEventListener('web-terminal-connection',event => {
        if (event.detail !== 'connected' || !ready()) {
            targetGeneration++; available = false; tabs.hidden = windows.length === 0; layout(); closeMenu(); state();
            if (endDialog.open) { endDialog.querySelector('[data-confirm]').disabled = true; endDialog.querySelector('[data-error]').textContent = 'Connection changed. Cancel and confirm again.'; }
        } else refresh();
    });
    document.addEventListener('visibilitychange',() => {
        if (document.hidden) { targetGeneration++; available = false; state(); }
        else refresh();
    });
    addEventListener('resize',() => { closeMenu(); layout(); });
    setInterval(() => { if (!busy && !endDialog.open && !renameDialog.open) refresh(); },2000);
    layout(); state(); refresh();
})();
