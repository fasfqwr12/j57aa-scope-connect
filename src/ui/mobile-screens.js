// Mobile-only page composition. Move existing nodes; never clone controls or state.
const $ = selector => document.querySelector(selector);
const all = selector => [...document.querySelectorAll(selector)];
const card = (...nodes) => ({ className: 'field-band mobile-group-card', nodes });
const grid = nodes => ({ className: 'form-grid', nodes });
const group = (id, label, ...blocks) => ({ id, label, blocks });

function definitions() {
  const profileFields = all('[data-panel="profile"] .form-grid > label');
  const targetFields = all('[data-panel="target"] .form-grid > label');
  const syncBands = all('[data-panel="sync"] > .field-band');
  return {
    device: [
      group('connection', '连接', $('.device-overview'), card($('.connection-panel > .form-grid'), $('.connection-panel > .action-row'))),
      group('settings', '参数', card($('#connection-advanced'))),
      group('status', '状态', $('#adapter-label').closest('.field-band'))
    ],
    profile: [
      group('profile', '配置', card($('.profile-strip'), $('[data-panel="profile"] .preset-row'), grid(profileFields.slice(0, 2)))),
      group('fields', '参数', card(grid(profileFields.slice(2)))),
      group('information', '说明', card($('#profile-info')))
    ],
    environment: [group('fields', '参数', $('[data-panel="environment"] > .field-band'))],
    target: [
      group('basic', '基本', card(grid(targetFields.slice(0, 4)))),
      group('values', '数值', card(grid(targetFields.slice(4)))),
      group('controls', '调节', card($('[data-panel="target"] .range-stack')))
    ],
    hud: [
      group('zones', '分区', card($('#hud-zone-toggles'))),
      group('display', '显示', card($('[data-panel="hud"] .form-grid')))
    ],
    sync: [
      group('sync', '同步', syncBands[1]),
      group('logs', '日志', syncBands[2]),
      group('information', '说明', syncBands[0])
    ],
    upgrade: [
      group('detect', '检测', $('.ota-intro'), $('.ota-preflight')),
      group('file', '文件', $('.ota-selection')),
      group('execute', '执行', $('#ota-main-only-row'), $('.ota-selection > .ota-notice:last-child'), $('#ota-progress-band'), $('.ota-dock'), $('#ota-log-details'))
    ]
  };
}

export function initMobileScreens() {
  const media = window.matchMedia('(max-width: 900px)');
  const compositions = new Map(), selections = new Map();
  const moved = [], detailsState = [];
  const workspace = $('.workspace');
  let mounted = false, viewportFrame = 0;

  function move(node, parent) {
    if (!(node instanceof Element)) throw new Error('Missing mobile layout node');
    const marker = document.createComment('mobile-layout-anchor');
    node.before(marker); moved.push({ node, marker }); parent.append(node);
  }
  function build(block, parent) {
    if (block instanceof Element) { move(block, parent); return; }
    const wrapper = document.createElement('div'); wrapper.className = block.className;
    parent.append(wrapper); block.nodes.forEach(node => build(node, wrapper));
  }
  function select(page, id, focus = false) {
    const view = compositions.get(page); if (!view) return;
    const selected = view.groups.find(g => g.id === id) || view.groups[0];
    selections.set(page, selected.id); view.root.dataset.group = selected.id;
    for (const entry of view.groups) {
      const active = entry === selected;
      entry.panel.hidden = !active;
      entry.button.setAttribute('aria-selected', String(active));
      entry.button.tabIndex = active ? 0 : -1;
      if (active) entry.panel.scrollTop = 0;
    }
    if (focus) selected.button.focus({ preventScroll: true });
  }
  function mount() {
    if (mounted) return;
    const config = definitions(); mounted = true;
    for (const [page, groups] of Object.entries(config)) {
      const section = $(`[data-panel="${page}"]`);
      const root = document.createElement('div'); root.className = 'mobile-screen-root';
      const nav = document.createElement('div'); nav.className = 'mobile-page-nav';
      nav.setAttribute('role', 'tablist'); nav.setAttribute('aria-label', `${$('#step-list [data-step="' + page + '"]')?.title || page}分组`);
      nav.hidden = groups.length === 1;
      const viewport = document.createElement('div'); viewport.className = 'mobile-page-viewport';
      root.append(nav, viewport); section.append(root); section.classList.add('mobile-paged');
      const view = { root, section, groups: [] }; compositions.set(page, view);
      for (const item of groups) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = item.label;
        button.id = `mobile-${page}-${item.id}-tab`; button.dataset.mobileGroup = item.id;
        button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', `mobile-${page}-${item.id}`);
        const panel = document.createElement('section'); panel.className = 'mobile-page'; panel.id = `mobile-${page}-${item.id}`;
        panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id); panel.tabIndex = 0;
        nav.append(button); viewport.append(panel); item.blocks.forEach(block => build(block, panel));
        view.groups.push({ ...item, button, panel });
        button.addEventListener('click', () => select(page, item.id));
        button.addEventListener('keydown', event => {
          const index = view.groups.findIndex(g => g.id === item.id), last = view.groups.length - 1;
          const next = event.key === 'ArrowRight' ? (index + 1) % (last + 1) : event.key === 'ArrowLeft' ? (index + last) % (last + 1) : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
          if (next === null) return; event.preventDefault(); select(page, view.groups[next].id, true);
        });
      }
      if (page === 'upgrade') {
        const footer = document.createElement('div'); footer.className = 'mobile-ota-footer';
        move($('#ota-feedback'), root);
        move($('#ota-gate-reason'), footer); move($('#ota-abort'), footer); root.append(footer);
      }
      select(page, selections.get(page));
    }
    const advanced = $('#connection-advanced');
    detailsState.push({ node: advanced, open: advanced.open }); advanced.open = true;
    const previewButton = document.createElement('button');
    previewButton.id = 'btn-mobile-preview'; previewButton.type = 'button'; previewButton.className = 'btn compact';
    previewButton.textContent = '预览'; previewButton.setAttribute('aria-haspopup', 'dialog'); previewButton.setAttribute('aria-controls', 'mobile-preview-dialog');
    $('.workspace-head').append(previewButton);
    const dialog = document.createElement('dialog'); dialog.id = 'mobile-preview-dialog'; dialog.className = 'mobile-preview-dialog';
    dialog.setAttribute('aria-labelledby', 'mobile-preview-title');
    const heading = document.createElement('div'); heading.className = 'mobile-preview-header';
    const title = document.createElement('h2'); title.id = 'mobile-preview-title'; title.textContent = '界面预览';
    const close = document.createElement('button'); close.type = 'button'; close.className = 'btn compact'; close.textContent = '关闭';
    heading.append(title, close); dialog.append(heading); document.body.append(dialog);
    move($('.preview-rail'), dialog); $('#preview-content').hidden = false;
    previewButton.addEventListener('click', () => { if (!dialog.open) dialog.showModal(); });
    close.addEventListener('click', () => dialog.close());
    document.body.classList.add('mobile-screen-mode');
    window.scrollTo(0, 0); viewportSize();
  }
  function unmount() {
    if (!mounted) return;
    const focus = document.activeElement;
    const focusWasInGroupNav = !!focus?.closest('.mobile-page-nav');
    const dialog = $('#mobile-preview-dialog');
    if (dialog?.open) dialog.close();
    // Reverse order also restores children moved out of an already moved parent.
    for (const { node, marker } of moved.splice(0).reverse()) { marker.replaceWith(node); }
    for (const { node, open } of detailsState.splice(0)) node.open = open;
    for (const view of compositions.values()) { view.section.classList.remove('mobile-paged'); view.root.remove(); }
    compositions.clear(); mounted = false;
    dialog?.remove(); $('#btn-mobile-preview')?.remove();
    document.body.classList.remove('mobile-screen-mode');
    document.documentElement.style.removeProperty('--mobile-viewport-height');
    if (focusWasInGroupNav) $(`#step-list [data-step="${document.body.dataset.page}"]`)?.focus({ preventScroll: true });
  }
  function viewportSize() {
    cancelAnimationFrame(viewportFrame);
    viewportFrame = requestAnimationFrame(() => {
      if (!media.matches) return;
      const height = Math.round(window.visualViewport?.height || window.innerHeight);
      document.documentElement.style.setProperty('--mobile-viewport-height', `${height}px`);
      const focused = document.activeElement;
      if (focused?.matches('input, select, textarea') && focused.closest('.mobile-page')) focused.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }
  function syncMode() { if (media.matches) mount(); else unmount(); }
  media.addEventListener('change', syncMode);
  window.addEventListener('resize', viewportSize);
  window.visualViewport?.addEventListener('resize', viewportSize);
  // A real progress update only changes the visible group; it never starts work.
  const progress = $('#ota-progress-band');
  new MutationObserver(() => {
    if (mounted && progress.style.display !== 'none') select('upgrade', 'execute');
  }).observe(progress, { attributes: true, attributeFilter: ['style'] });
  syncMode();
  return {
    show(page) {
      if (!mounted) return;
      select(page, selections.get(page)); workspace.scrollTop = 0;
    }
  };
}
