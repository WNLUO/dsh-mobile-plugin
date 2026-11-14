/** 远程网页的只读租期提示与主文档流式脚本注入。 */
'use strict';

const { Transform } = require('node:stream');

const SCRIPT_TAG = Buffer.from('<script src="/__dsh_remote_notice.js" defer></script>');
const TEXT = {
  'zh-Hans': ['访问即将到期，请返回本机插件续期。', '本次访问已到期，请返回本机插件重新打开。', '无法确认访问状态，请返回本机插件检查。'],
  'zh-Hant': ['存取即將到期，請返回本機外掛續期。', '本次存取已到期，請返回本機外掛重新開啟。', '無法確認存取狀態，請返回本機外掛檢查。'],
  en: ['Access expires soon. Return to the local plugin to renew it.', 'This visit has expired. Return to the local plugin to open it again.', 'Access status could not be checked. Return to the local plugin to check it.'],
  ja: ['アクセスがまもなく終了します。このパソコンのプラグインで延長してください。', 'アクセス期限が切れました。このパソコンのプラグインから開き直してください。', 'アクセス状態を確認できません。このパソコンのプラグインで確認してください。'],
  ko: ['접속이 곧 만료됩니다. 이 컴퓨터의 플러그인으로 돌아가 연장하세요.', '접속이 만료되었습니다. 이 컴퓨터의 플러그인에서 다시 열어 주세요.', '접속 상태를 확인할 수 없습니다. 이 컴퓨터의 플러그인에서 확인하세요.'],
  de: ['Der Zugriff läuft bald ab. Verlängere ihn im lokalen Plugin.', 'Dieser Zugriff ist abgelaufen. Öffne ihn im lokalen Plugin erneut.', 'Der Zugriffsstatus konnte nicht geprüft werden. Prüfe ihn im lokalen Plugin.'],
  es: ['El acceso caduca pronto. Vuelve al complemento local para renovarlo.', 'Este acceso ha caducado. Vuelve al complemento local para abrirlo de nuevo.', 'No se pudo comprobar el acceso. Revísalo en el complemento local.'],
  fr: ['L’accès expire bientôt. Revenez au plugin local pour le renouveler.', 'Cet accès a expiré. Revenez au plugin local pour le rouvrir.', 'Impossible de vérifier l’accès. Vérifiez-le dans le plugin local.'],
  pt: ['O acesso expira em breve. Volte ao plugin local para renovar.', 'Este acesso expirou. Volte ao plugin local para abrir novamente.', 'Não foi possível verificar o acesso. Confira no plugin local.'],
  ru: ['Доступ скоро истечёт. Продлите его в локальном плагине.', 'Срок доступа истёк. Откройте его заново в локальном плагине.', 'Не удалось проверить доступ. Проверьте его в локальном плагине.'],
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

function noticeScript() {
  return `(${browserNotice.toString()})(${JSON.stringify(TEXT)});`;
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

module.exports = { noticeScript, createNoticeTransform };
