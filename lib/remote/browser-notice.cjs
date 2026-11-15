/** 远程网页的只读租期提示、桌面壳的排版适配与主文档流式脚本注入。 */
'use strict';

const { Transform } = require('node:stream');

const SCRIPT_TAG = Buffer.from('<script src="/__dsh_remote_notice.js" defer></script>');
const TEXT = {
  'zh-Hans': ['访问即将到期，请保持此窗口在使用中以自动续期。', '本次访问已到期，请返回本机插件重新打开。', '无法确认访问状态，请返回本机插件检查。'],
  'zh-Hant': ['存取即將到期，請保持此視窗在使用中以自動續期。', '本次存取已到期，請返回本機外掛重新開啟。', '無法確認存取狀態，請返回本機外掛檢查。'],
  en: ['Access expires soon. Keep this window in use to renew it automatically.', 'This visit has expired. Return to the local plugin to open it again.', 'Access status could not be checked. Return to the local plugin to check it.'],
  ja: ['アクセスがまもなく終了します。このウィンドウを使い続けると自動で延長されます。', 'アクセス期限が切れました。このパソコンのプラグインから開き直してください。', 'アクセス状態を確認できません。このパソコンのプラグインで確認してください。'],
  ko: ['접속이 곧 만료됩니다. 이 창을 계속 사용하면 자동으로 연장됩니다.', '접속이 만료되었습니다. 이 컴퓨터의 플러그인에서 다시 열어 주세요.', '접속 상태를 확인할 수 없습니다. 이 컴퓨터의 플러그인에서 확인하세요.'],
  de: ['Der Zugriff läuft bald ab. Nutze dieses Fenster weiter, um automatisch zu verlängern.', 'Dieser Zugriff ist abgelaufen. Öffne ihn im lokalen Plugin erneut.', 'Der Zugriffsstatus konnte nicht geprüft werden. Prüfe ihn im lokalen Plugin.'],
  es: ['El acceso caduca pronto. Mantén esta ventana en uso para renovarlo automáticamente.', 'Este acceso ha caducado. Vuelve al complemento local para abrirlo de nuevo.', 'No se pudo comprobar el acceso. Revísalo en el complemento local.'],
  fr: ['L’accès expire bientôt. Continuez d’utiliser cette fenêtre pour le renouveler automatiquement.', 'Cet accès a expiré. Revenez au plugin local pour le rouvrir.', 'Impossible de vérifier l’accès. Vérifiez-le dans le plugin local.'],
  pt: ['O acesso expira em breve. Continue usando esta janela para renovar automaticamente.', 'Este acesso expirou. Volte ao plugin local para abrir novamente.', 'Não foi possível verificar o acesso. Confira no plugin local.'],
  ru: ['Доступ скоро истечёт. Продолжайте использовать это окно — доступ продлится автоматически.', 'Срок доступа истёк. Откройте его заново в локальном плагине.', 'Не удалось проверить доступ. Проверьте его в локальном плагине.'],
};

function browserNotice(text) {
  if (window.top !== window || document.getElementById('dsh-remote-lease-notice')) return;
  let lease = null;
  let failed = false;
  let pending = false;
  let box = null;
  let stopped = false;
  let timer;
  const monotonicNow = () => performance.now();

  function language() {
    const tag = String(document.documentElement.lang || navigator.language || 'en').replace(/_/g, '-').toLowerCase();
    const parts = tag.split('-');
    if (parts[0] === 'zh') return parts.some((part) => ['hant', 'tw', 'hk', 'mo'].includes(part)) ? 'zh-Hant' : 'zh-Hans';
    return text[parts[0]] ? parts[0] : 'en';
  }

  function render() {
    const remaining = lease ? lease.expiresAt - lease.serverNow - Math.max(0, monotonicNow() - lease.sampledAt) : null;
    const message = remaining !== null && remaining <= 0 ? 1 : failed ? 2 : remaining !== null && remaining <= 5 * 60 * 1000 ? 0 : -1;
    if (message < 0) { if (box) box.hidden = true; return; }
    if (!box) {
      box = document.createElement('div');
      box.id = 'dsh-remote-lease-notice';
      box.setAttribute('role', 'status');
      box.setAttribute('aria-live', 'polite');
      Object.assign(box.style, {
        position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483001',
        boxSizing: 'border-box', maxWidth: 'min(360px, calc(100vw - 32px))',
        padding: '8px 10px', border: '.5px solid var(--dsw-alias-settings-card-stroke, GrayText)',
        borderRadius: 'var(--dsw-radius-md, 8px)', background: 'var(--dsw-alias-settings-card-fill, Canvas)',
        color: 'var(--dsw-alias-label-primary, CanvasText)', font: 'inherit', fontSize: '12px', lineHeight: '18px',
      });
      document.body.appendChild(box);
    }
    box.hidden = false;
    box.textContent = text[language()][message];
  }

  async function poll() {
    if (stopped || pending || document.hidden) return;
    pending = true;
    try {
      const response = await fetch('/__dsh_remote_status', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('status');
      const status = await response.json();
      if (!Number.isFinite(status.expiresAt) || !Number.isFinite(status.serverNow)) throw new Error('status');
      lease = status.expiresAt > 0 ? { expiresAt: status.expiresAt, serverNow: status.serverNow, sampledAt: monotonicNow() } : null;
      failed = false;
    } catch {
      failed = true;
    } finally {
      pending = false;
      if (!stopped) render();
    }
  }

  function tick() { if (!document.hidden) { render(); void poll(); } }
  function stop() { stopped = true; clearInterval(timer); document.removeEventListener('visibilitychange', tick); }
  window.addEventListener('pagehide', stop, { once: true });
  document.addEventListener('visibilitychange', tick);
  timer = setInterval(tick, 30 * 1000);
  void poll();
}

/**
 * Mac 桌面壳的排版样式。官方把长相挂在 [data-platform='darwin'] 这个祖先记号上，
 * 把「这是桌面端、去找宿主键盘桥」挂在根元素上的同名记号上。壳的记号只打在页面
 * 主体，根元素保持网页版，服务照常按网页运行时启动。这里按官方原值补齐少数几条
 * 只认根元素的规则，并给侧栏首行留出红黄绿按钮的位置：网页版不渲染官方那条
 * 52px 让位带，折抵成 40px 上边距。全屏时按钮隐藏，让位跟着收掉。
 */
const SHELL_CSS = `
html[data-dshm-shell] {
  --dsh-frame-top-clearance: 48px;
  --dsh-frame-overlay-top: calc(var(--dsh-frame-top-clearance) + 20px);
}
html[data-dshm-shell][data-fullscreen] {
  --dsh-frame-overlay-top: 20px;
  --dsh-frame-chrome-top: 0px;
}
html[data-dshm-shell], html[data-dshm-shell] body { background: transparent; }
html[data-dshm-shell] body { isolation: isolate; }
/* 官方侧栏底色是半透明、靠系统毛玻璃透出桌面；Tauri 这层毛玻璃没生效，透明下会直接
   透出壁纸，空着的顶部让位就成了一道浅带。这里把侧栏底色改成实色，整块和顶栏一致。 */
html[data-dshm-shell] body[data-platform='darwin'] {
  --dsw-specific-menu: rgba(248, 249, 250, 0.94);
  --dsw-specific-sidebar-glass-collapsed-fill: transparent;
  --dsw-specific-sidebar-glass-collapsed-hover: var(--dsw-alias-interactive-bg-hover);
  --dsw-specific-sidebar-glass-fill: rgb(255 255 255 / 0.55);
  --dsw-specific-sidebar-glass-hover: rgb(255 255 255 / 0.3);
  --dsw-specific-sidebar-tint: var(--dsw-specific-sidebar-fill);
  --dsw-specific-sidebar-wash-bottom: transparent;
  --dsw-specific-sidebar-wash-bottom-clear: transparent;
  --dsw-specific-sidebar-wash-top: transparent;
  --dsw-specific-sidebar-wash-top-clear: transparent;
}
html[data-dshm-shell] body[data-platform='darwin'][data-ds-dark-theme] {
  --dsw-specific-menu: rgba(48, 49, 54, 0.94);
  --dsw-specific-sidebar-glass-collapsed-fill: var(--dsw-specific-sidebar-glass-fill);
  --dsw-specific-sidebar-glass-collapsed-hover: var(--dsw-specific-sidebar-glass-hover);
  --dsw-specific-sidebar-glass-fill: rgb(255 255 255 / 0.15);
  --dsw-specific-sidebar-glass-hover: rgb(255 255 255 / 0.2);
  --dsw-specific-sidebar-tint: var(--dsw-specific-sidebar-fill);
}
/* 顶栏：把红黄绿让位做进侧栏顶部实底里，按钮嵌进侧栏、折叠键回到按钮同一行。 */
html[data-dshm-shell] [data-window-drag]:has([data-sidebar-toggle]) {
  position: relative;
  margin: -6px -8px 0;
  padding: 44px 12px 8px;
  height: auto;
  overflow: visible;
  box-sizing: border-box;
}
html[data-dshm-shell] [data-window-drag]:has([data-sidebar-toggle]) > [data-sidebar-toggle] {
  position: absolute;
  top: 10px;
  right: 12px;
}
html[data-dshm-shell][data-fullscreen] [data-window-drag]:has([data-sidebar-toggle]) {
  padding-top: 8px;
}
html[data-dshm-shell] body[data-platform='darwin'] [data-sidebar-collapsed]:not([data-sidebar-drawer]) {
  --dsh-frame-leading-clearance: 0px;
}
`;

/**
 * 桌面壳会话：只在页面主体打开官方的 Mac 排版，把网页自带的拖动标记翻成 Tauri 认的说法。
 * Tauri 的 deep 覆盖整块子树、自动放过按钮，官方标了不许拖的那一支用 false 挡住；
 * 页面切换时会增删这些元素，跟着同步。
 */
function browserShell(css) {
  const root = document.documentElement;
  if (root.dataset.dshmShell === '1') return;
  root.dataset.dshmShell = '1';
  document.body.dataset.platform = 'darwin';
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  const MARK = 'data-tauri-drag-region';
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    const frame = window.requestAnimationFrame || window.setTimeout;
    frame.call(window, () => {
      scheduled = false;
      observer.disconnect();
      sync();
      observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    });
  });
  function sync() {
    for (const row of document.querySelectorAll('[data-window-drag]')) {
      if (row.getAttribute(MARK) !== 'deep') row.setAttribute(MARK, 'deep');
    }
    for (const blocked of document.querySelectorAll('[data-window-drag-exclude],[data-window-drag-recall]')) {
      if (blocked.getAttribute(MARK) !== 'false') blocked.setAttribute(MARK, 'false');
    }
  }
  sync();
  observer.observe(document.body, { subtree: true, childList: true, attributes: true });
}

function shellScript(platform) {
  return platform === 'darwin' ? `(${browserShell.toString()})(${JSON.stringify(SHELL_CSS)});` : '';
}

function noticeScript({ shell = false, platform = '' } = {}) {
  return `${shell ? shellScript(platform) : ''}(${browserNotice.toString()})(${JSON.stringify(TEXT)});`;
}

/** 仅保留开头少量字节定位 head；剩余文档直接透传，保留字节与背压。 */
function createNoticeTransform() {
  let prefix = Buffer.alloc(0);
  let inserted = false;
  const prefixLimit = 4096;
  return new Transform({
    transform(chunk, encoding, callback) {
      if (inserted) { callback(null, chunk); return; }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      prefix = Buffer.concat([prefix, bytes]);
      const match = /<head(?:\s[^>]*)?>/i.exec(prefix.toString('latin1'));
      if (match) {
        const end = match.index + match[0].length;
        this.push(prefix.subarray(0, end));
        this.push(SCRIPT_TAG);
        this.push(prefix.subarray(end));
        prefix = Buffer.alloc(0);
        inserted = true;
      } else if (prefix.length >= prefixLimit) {
        this.push(prefix);
        prefix = Buffer.alloc(0);
        inserted = true;
      }
      callback();
    },
    flush(callback) { if (prefix.length) this.push(prefix); callback(); },
  });
}

module.exports = { noticeScript, shellScript, createNoticeTransform };
