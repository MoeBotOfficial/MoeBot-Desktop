// MoeBot desktop shell.
//
// This file only ever ships inside the desktop dist/. The upstream webui stays
// untouched: everything here layers on top of its DOM and of the small
// `window.__moebot` handle that the desktop build exposes from app.js.
//
// It adds the "我的机器人" landing page (a bot list backed by
// %APPDATA%\com.moebot.desktop\bots\bots.yml through Rust commands) and turns the
// sidebar status line into an upward-opening switcher between those bots.

/* 1. reveal the window scrollbar only when the pointer nears the right edge. */
(function () {
  var EDGE = 90;
  var root = document.documentElement;
  var near = false;
  function setNear(value) {
    if (value === near) return;
    near = value;
    root.classList.toggle('mb-edge', value);
  }
  window.addEventListener('mousemove', function (event) {
    setNear(window.innerWidth - event.clientX <= EDGE);
  }, { passive: true });
  window.addEventListener('mouseout', function (event) {
    if (!event.relatedTarget) setNear(false);
  });
  window.addEventListener('blur', function () { setNear(false); });
  document.addEventListener('mouseleave', function () { setNear(false); });
})();

/* 2. bot hub + sidebar switcher. */
(async function () {
  const tauri = window.__TAURI__;
  const invoke = tauri && (tauri.core ? tauri.core.invoke : tauri.invoke);
  if (typeof invoke !== 'function') return;

  const $ = (id) => document.getElementById(id);

  const shell = await new Promise((resolve) => {
    if (window.__moebot) return resolve(window.__moebot);
    const started = Date.now();
    const timer = setInterval(() => {
      if (window.__moebot) {
        clearInterval(timer);
        resolve(window.__moebot);
      } else if (Date.now() - started > 20000) {
        clearInterval(timer);
        resolve(null);
      }
    }, 100);
  });
  if (!shell || !shell.state) return;

  const connectionSection = $('connection-section');
  const disconnectButton = $('disconnect');
  const bottom = document.querySelector('.sidebar-bottom');
  if (!connectionSection || !bottom) return;

  const store = { path: '', active: null, bots: [] };
  const cards = new Map();
  let loadError = '';
  let pendingRestore = null;
  let connectionSignature = '';
  let menuEpoch = 0;

  const hostOf = (backend) => {
    try { return new URL(backend).host; } catch { return String(backend || ''); }
  };
  const backendNow = () => (shell.state.connection ? shell.state.connection.backend : '');
  const findById = (id) => store.bots.find((bot) => bot.id === id) || null;
  const findByBackend = (backend) => store.bots.find((bot) => bot.backend === backend) || null;

  function stamp(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (number) => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function newId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return `bot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function button(label, className) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = className;
    element.textContent = label;
    return element;
  }

  /* ---------- storage ---------- */

  async function loadStore() {
    try {
      const loaded = await invoke('bots_load');
      store.path = loaded.path || '';
      store.active = loaded.active || null;
      store.bots = Array.isArray(loaded.bots) ? loaded.bots : [];
      loadError = '';
    } catch (error) {
      loadError = String(error && error.message ? error.message : error);
    }
  }

  async function persist() {
    try {
      store.path = await invoke('bots_save', {
        payload: { active: store.active, bots: store.bots },
      });
      loadError = '';
    } catch (error) {
      shell.notice(`机器人列表保存失败：${String(error && error.message ? error.message : error)}`, 'error');
    }
  }

  /* ---------- drafts ---------- */

  function captureDraft() {
    const state = shell.state;
    return {
      capturedAt: new Date().toISOString(),
      edits: [...state.edits.entries()],
      pluginChanges: state.pluginChanges || 0,
      mcpChanges: state.mcpChanges || 0,
    };
  }

  function hasLocalWork() {
    const state = shell.state;
    return Boolean(state.edits.size || state.pluginChanges || state.mcpChanges);
  }

  function stashCurrent() {
    const state = shell.state;
    if (!state.snapshot || !state.connection) return;
    const bot = findByBackend(state.connection.backend);
    if (!bot) return;
    if (!state.edits.size) {
      if (bot.draft) {
        bot.draft = null;
        void persist();
      }
      return;
    }
    bot.draft = JSON.stringify(captureDraft());
    void persist();
  }

  function restoreDraft(bot) {
    const state = shell.state;
    if (!bot || !bot.draft || !state.snapshot) return 0;
    let draft;
    try {
      draft = JSON.parse(bot.draft);
    } catch {
      bot.draft = null;
      void persist();
      return 0;
    }
    const known = new Set(state.snapshot.schema.map((field) => field.name));
    let restored = 0;
    state.edits.clear();
    for (const [name, edit] of draft.edits || []) {
      if (!known.has(name)) continue;
      state.edits.set(name, edit);
      restored += 1;
    }
    bot.draft = null;
    void persist();
    shell.renderFields();
    shell.updatePending();
    if (restored) {
      shell.notice(`已恢复 ${restored} 项上次未提交的修改；仍只保存在本机，未写入 Cloudflare。`);
    }
    return restored;
  }

  /* ---------- switching ---------- */

  function nonPortableChanges() {
    const state = shell.state;
    const parts = [];
    if (state.mcpChanges) parts.push(`${state.mcpChanges} 项 MCP 改动`);
    if (state.release || state.tag) parts.push('程序版本选择');
    if (state.redeploy) parts.push('重新部署计划');
    return parts;
  }

  async function leaveCurrent() {
    stashCurrent();
    if (!shell.state.snapshot) return true;
    const parts = nonPortableChanges();
    if (!parts.length) return true;
    return window.confirm(`当前机器人还有${parts.join('、')}，这些只存在于内存中，切换后需要重新设置（插件草稿和已保存的配置不受影响）。仍要切换？`);
  }

  function fillForm(bot) {
    $('backend-url').value = bot.backend;
    $('cf-token').value = bot.token || '';
    $('cf-account-id').value = bot.accountId || '';
    $('cf-project-name').value = bot.projectName || '';
    $('remember-token').checked = true;
  }

  async function enterBot(id) {
    const bot = findById(id);
    if (!bot) return;
    const state = shell.state;
    if (state.snapshot && state.connection && state.connection.backend === bot.backend) {
      closeMenu();
      return;
    }
    if (!bot.token) {
      openAddPanel(bot);
      shell.notice('这个机器人缺少可用凭据（可能换了 Windows 账户），请重新填写 Token。', 'warning');
      return;
    }
    if (!(await leaveCurrent())) return;
    pendingRestore = bot;
    store.active = bot.id;
    await persist();
    renderAll();
    fillForm(bot);
    $('connect-form').requestSubmit();
  }

  /* ---------- UI ---------- */

  const hub = document.createElement('section');
  hub.id = 'bot-hub';
  hub.hidden = true;
  hub.innerHTML = [
    '<div class="bot-hub-head">',
    '<div><span class="step-label">MY BOTS</span>',
    '<p>已添加的机器人直接进入管理，无需再次填写 Token；列表保存在本机 bots.yml。</p></div>',
    '<button type="button" class="button primary" id="bot-add-toggle">添加机器人</button>',
    '</div>',
    '<div class="bot-list" id="bot-list"></div>',
    '<p id="bot-hub-path"></p>',
  ].join('');

  const addPanel = document.createElement('div');
  addPanel.id = 'add-bot-panel';
  addPanel.hidden = true;
  const addHead = document.createElement('div');
  addHead.className = 'add-bot-head';
  addHead.innerHTML = [
    '<div><span class="step-label">ADD BOT</span>',
    '<p>填写后端地址与 Cloudflare API Token，添加后可一键进入，无需重复连接。</p></div>',
    '<button type="button" class="button secondary small" id="bot-add-cancel">收起</button>',
  ].join('');
  addPanel.append(addHead);

  connectionSection.parentNode.insertBefore(hub, connectionSection);
  connectionSection.parentNode.insertBefore(addPanel, connectionSection);
  addPanel.append(connectionSection);

  const switcher = document.createElement('div');
  switcher.className = 'bot-switcher';
  switcher.id = 'bot-switcher';
  switcher.innerHTML = [
    '<button type="button" class="bot-switcher-trigger" id="bot-switcher-trigger" aria-haspopup="true" aria-expanded="false">',
    '<span class="status-dot" data-slot="dot"></span>',
    '<span class="bot-switcher-text"><strong id="bot-switcher-name">选择机器人</strong><span data-slot="label"></span></span>',
    '<span class="bot-switcher-caret">▲</span>',
    '</button>',
    '<ul class="bot-switcher-menu" id="bot-switcher-menu" hidden></ul>',
  ].join('');

  const dot = $('connection-dot');
  const label = $('connection-label');
  switcher.querySelector('[data-slot="dot"]').replaceWith(dot);
  switcher.querySelector('[data-slot="label"]').replaceWith(label);
  bottom.insertBefore(switcher, bottom.firstChild);

  function renderPath() {
    const target = $('bot-hub-path');
    if (!target) return;
    target.replaceChildren();
    if (loadError) {
      target.textContent = `机器人列表读取失败：${loadError}`;
      return;
    }
    if (!store.path) return;
    target.append(document.createTextNode('列表文件：'));
    const code = document.createElement('code');
    code.textContent = store.path;
    code.title = store.path;
    target.append(code);
  }

  function startRename(bot, strong) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = bot.name || '';
    input.maxLength = 60;
    strong.replaceWith(input);
    input.focus();
    input.select();
    let settled = false;
    const finish = (apply) => {
      if (settled) return;
      settled = true;
      if (apply) {
        const name = input.value.trim();
        if (name && name !== bot.name) {
          bot.name = name;
          void persist();
        }
      }
      renderAll();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  function removeBot(bot) {
    const card = cards.get(bot.id);
    const target = card ? card.querySelector('.bot-remove') : null;
    if (target && target.dataset.armed !== '1') {
      target.dataset.armed = '1';
      target.textContent = '确认删除？';
      setTimeout(() => {
        if (target.dataset.armed === '1') {
          target.dataset.armed = '';
          target.textContent = '删除';
        }
      }, 4000);
      return;
    }
    store.bots = store.bots.filter((item) => item.id !== bot.id);
    if (store.active === bot.id) store.active = null;
    void persist();
    renderAll();
  }

  function renderList() {
    const list = $('bot-list');
    if (!list) return;
    list.replaceChildren();
    cards.clear();
    if (!store.bots.length) {
      const empty = document.createElement('div');
      empty.className = 'bot-empty';
      empty.textContent = loadError
        ? '机器人列表读取失败，可删除该文件后重建。'
        : '还没有添加机器人。点击右上角「添加机器人」，填入后端地址与 Token 即可。';
      list.append(empty);
      return;
    }
    const current = backendNow();
    for (const bot of store.bots) {
      const card = document.createElement('article');
      card.className = 'bot-card' + (bot.backend === current ? ' active' : '');
      card.dataset.botId = bot.id;

      const avatar = document.createElement('span');
      avatar.className = 'bot-avatar';
      avatar.textContent = (bot.name || hostOf(bot.backend) || '?').slice(0, 1);

      const meta = document.createElement('div');
      meta.className = 'bot-meta';
      const strong = document.createElement('strong');
      strong.textContent = bot.name || hostOf(bot.backend);
      const small = document.createElement('small');
      const notes = [hostOf(bot.backend)];
      if (bot.lastUsedAt) notes.push(`最近使用 ${stamp(bot.lastUsedAt)}`);
      if (bot.needsToken) notes.push('凭据不可用，需重新填写');
      if (bot.draft) notes.push('有未提交的草稿');
      small.textContent = notes.join(' · ');
      meta.append(strong, small);

      const actions = document.createElement('div');
      actions.className = 'bot-actions';
      const enter = button('进入管理', 'button primary small');
      enter.disabled = !bot.token;
      enter.onclick = () => { void enterBot(bot.id); };
      const rename = button('重命名', 'button secondary small');
      rename.onclick = () => startRename(bot, meta.querySelector('strong'));
      const remove = button('删除', 'button secondary small bot-remove');
      remove.onclick = () => removeBot(bot);

      actions.append(enter, rename, remove);
      card.append(avatar, meta, actions);
      list.append(card);
      cards.set(bot.id, card);
    }
  }

  function renderMenu() {
    const menu = $('bot-switcher-menu');
    if (!menu) return;
    menu.replaceChildren();
    if (!store.bots.length) {
      const item = document.createElement('li');
      item.className = 'sw-empty';
      item.textContent = '还没有添加机器人';
      menu.append(item);
      return;
    }
    const current = backendNow();
    for (const bot of store.bots) {
      const item = document.createElement('li');
      const action = button('', '');
      const name = document.createElement('span');
      name.className = 'sw-name';
      name.textContent = bot.name || hostOf(bot.backend);
      const host = document.createElement('span');
      host.className = 'sw-host';
      host.textContent = hostOf(bot.backend);
      action.append(name, host);
      if (bot.backend === current) {
        const tick = document.createElement('span');
        tick.className = 'sw-tick';
        tick.textContent = '●';
        action.append(tick);
      }
      action.onclick = () => {
        closeMenu();
        void enterBot(bot.id);
      };
      item.append(action);
      menu.append(item);
    }
    const separator = document.createElement('li');
    separator.className = 'sw-sep';
    menu.append(separator);
    const manageItem = document.createElement('li');
    const manage = button('管理机器人列表', '');
    manage.onclick = () => {
      closeMenu();
      openHub();
    };
    manageItem.append(manage);
    menu.append(manageItem);
  }

  function renderSwitcher() {
    const name = $('bot-switcher-name');
    if (!name) return;
    const active = store.active ? findById(store.active) : null;
    const connected = Boolean(shell.state.snapshot && shell.state.connection);
    const current = connected ? findByBackend(backendNow()) : null;
    const shown = current || active;
    name.textContent = shown ? shown.name || hostOf(shown.backend) : '选择机器人';
    renderMenu();
  }

  function renderAll() {
    const connected = Boolean(shell.state.snapshot && shell.state.connection);
    hub.hidden = connected;
    if (connected) {
      addPanel.hidden = true;
    }
    renderList();
    renderSwitcher();
    renderPath();
  }

  function openMenu() {
    const menu = $('bot-switcher-menu');
    const trigger = $('bot-switcher-trigger');
    if (!menu || !trigger) return;
    menuEpoch += 1;
    renderMenu();
    menu.classList.remove('mb-closing');
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
  }

  function closeMenu() {
    const menu = $('bot-switcher-menu');
    const trigger = $('bot-switcher-trigger');
    if (!menu || !trigger) return;
    trigger.setAttribute('aria-expanded', 'false');
    if (menu.hidden) return;
    const epoch = (menuEpoch += 1);
    menu.classList.add('mb-closing');
    setTimeout(() => {
      if (epoch !== menuEpoch) return;
      menu.classList.remove('mb-closing');
      menu.hidden = true;
    }, 130);
  }

  function openAddPanel(bot) {
    // selectGroup() hides #connection-section while a snapshot is loaded, so
    // re-show it here or an "add another bot" while connected shows an empty panel.
    connectionSection.hidden = false;
    addPanel.hidden = false;
    pulse(addPanel, 'mb-rise');
    if (bot) fillForm(bot);
    const focusTarget = bot && !bot.token ? $('cf-token') : $('backend-url');
    if (focusTarget) focusTarget.focus();
  }

  function closeAddPanel() {
    addPanel.hidden = true;
  }

  function openHub() {
    if (shell.state.snapshot && disconnectButton) {
      stashCurrent();
      disconnectButton.click();
    }
    closeAddPanel();
    renderAll();
    window.scrollTo(0, 0);
  }

  /* ---------- wiring ---------- */

  $('bot-add-toggle').onclick = () => { openAddPanel(null); closeMenu(); };
  $('bot-add-cancel').onclick = () => closeAddPanel();
  $('bot-switcher-trigger').onclick = () => {
    const expanded = $('bot-switcher-trigger').getAttribute('aria-expanded') === 'true';
    if (expanded) closeMenu();
    else openMenu();
  };

  document.addEventListener('click', (event) => {
    const panel = $('add-bot-panel');
    if (switcher.contains(event.target)) return;
    if (panel && panel.contains(event.target)) return;
    closeMenu();
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });

  // Sidebar nav: re-enter the content on a group switch, and treat the lone
  // "连接后端" item (the landing page's only nav entry) as "add a bot", since
  // the connect form now lives inside the collapsed #add-bot-panel.
  document.addEventListener('click', (event) => {
    const target = event.target;
    const item = target && target.closest ? target.closest('.nav-item') : null;
    if (!item) return;
    navPulseAt = Date.now();
    if (item.dataset.group === '连接后端') {
      openAddPanel(null);
      return;
    }
    setTimeout(() => pulse($('settings-fields'), 'mb-rise'), 0);
  });

  // The app clears its pending edits the moment 断开连接 runs, so snapshot the
  // draft during the capture phase, before app.js's own handler sees the click.
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (disconnectButton && target && target.closest && target.closest('#disconnect')) stashCurrent();
  }, true);

  const connectForm = $('connect-form');
  connectForm.addEventListener('submit', () => {
    const backendInput = $('backend-url').value.trim();
    const token = $('cf-token').value.trim();
    if (!backendInput || !token) return;
    pendingRestore = findByBackend(backendInput.replace(/\/+$/, '')) || null;
    renderAll();
  });

  async function onConnectionChange(connected, backend) {
    if (connected) {
      const state = shell.state;
      let bot = findByBackend(backend);
      const projectName = state.snapshot && state.snapshot.project ? state.snapshot.project.name : '';
      if (!bot) {
        bot = {
          id: newId(),
          name: projectName || hostOf(backend),
          backend,
          accountId: state.connection.accountId || '',
          projectName: state.connection.projectName || '',
          addedAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
          token: state.connection.token || '',
          draft: null,
          needsToken: false,
        };
        store.bots.push(bot);
        shell.notice(`已添加机器人「${bot.name}」，以后可一键进入。`);
      } else {
        bot.accountId = state.connection.accountId || bot.accountId || '';
        bot.projectName = state.connection.projectName || bot.projectName || '';
        bot.token = state.connection.token || bot.token;
        bot.needsToken = false;
        bot.lastUsedAt = new Date().toISOString();
      }
      store.active = bot.id;
      await persist();
      closeAddPanel();
      const target = pendingRestore && pendingRestore.backend === backend ? findByBackend(backend) : null;
      pendingRestore = null;
      if (target) restoreDraft(target);
    } else {
      closeMenu();
    }
    renderAll();
  }

  /* ---------- motion ---------- */

  const pulseTimers = new WeakMap();
  let viewKey = '';
  let navPulseAt = 0;

  function pulse(element, className) {
    if (!element) return;
    const timers = pulseTimers.get(element) || {};
    pulseTimers.set(element, timers);
    element.classList.remove(className);
    void element.offsetWidth; // let the browser see the class leave before it comes back
    element.classList.add(className);
    clearTimeout(timers[className]);
    timers[className] = setTimeout(() => element.classList.remove(className), 1100);
  }

  function whenSplashGone(run) {
    const splash = document.getElementById('moebot-splash');
    if (!splash) return run();
    const started = Date.now();
    const timer = setInterval(() => {
      if (!document.body.contains(splash) || Date.now() - started > 4000) {
        clearInterval(timer);
        setTimeout(run, 60);
      }
    }, 80);
  }

  function enterView(connected, previous) {
    if (!connected) {
      pulse(hub, 'mb-stagger');
      pulse($('bot-list'), 'mb-stagger');
      return;
    }
    if (previous.indexOf('true|') !== 0) {
      pulse(document.querySelector('.stats-grid'), 'mb-rise');
      pulse(document.querySelector('.workspace-grid'), 'mb-rise');
    }
    pulse($('settings-fields'), 'mb-rise');
  }

  function tickView(connected, group) {
    const key = `${connected}|${group}`;
    if (key === viewKey) return;
    const previous = viewKey;
    viewKey = key;
    // first paint: the startup splash is still up, hand the motion off to it
    if (!previous) {
      whenSplashGone(() => enterView(connected, ''));
      return;
    }
    // the nav click already animated this group, don't play it twice
    if (Date.now() - navPulseAt < 1000) return;
    enterView(connected, previous);
  }

  function tick() {
    const state = shell.state;
    const connected = Boolean(state.snapshot && state.connection);
    const backend = connected ? state.connection.backend : '';
    const next = `${connected}|${backend}`;
    if (next !== connectionSignature) {
      connectionSignature = next;
      void onConnectionChange(connected, backend);
    }
    tickView(connected, connected ? state.group : '');
  }

  await loadStore();
  renderAll();
  setInterval(tick, 400);
  tick();
})();
