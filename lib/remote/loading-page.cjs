// 远程网页的过渡页：桌面窗口先有内容，隧道建好后再跳到真实页面，不再是一段空白。
// 与租期提示同一套语言判定；只读、自带内联脚本，不依赖远端。
'use strict';

/** 每种语言五句：连接中 / 连接失败 / 已到期 / 授权失效 / 重试。 */
const TEXT = {
  'zh-Hans': ['正在连接远程电脑…', '连接不上远程电脑，请检查网络或对方是否在线。', '本次访问已到期，请返回本机插件重新打开。', '访问授权已失效，请重新绑定这台电脑。', '重试'],
  'zh-Hant': ['正在連線遠端電腦…', '連線不上遠端電腦，請檢查網路或對方是否在線。', '本次存取已到期，請返回本機外掛重新開啟。', '存取授權已失效，請重新綁定這台電腦。', '重試'],
  en: ['Connecting to the remote computer…', 'Cannot connect to the remote computer. Check your network or whether the other computer is online.', 'This visit has expired. Return to the local plugin to open it again.', 'Access is invalid or revoked. Pair this computer again.', 'Retry'],
  ja: ['リモートパソコンに接続しています…', 'リモートパソコンに接続できません。ネットワークか相手のパソコンがオンラインか確認してください。', 'アクセス期限が切れました。このパソコンのローカルプラグインから開き直してください。', 'アクセス権が無効か取り消されています。再登録してください。', '再試行'],
  ko: ['원격 컴퓨터에 연결하는 중…', '원격 컴퓨터에 연결할 수 없습니다. 네트워크나 상대 컴퓨터가 켜져 있는지 확인하세요.', '접속이 만료되었습니다. 이 컴퓨터의 로컬 플러그인에서 다시 열어 주세요.', '접속 권한이 유효하지 않거나 취소되었습니다. 다시 연결 등록하세요.', '다시 시도'],
  de: ['Verbindung zum entfernten Computer wird hergestellt …', 'Verbindung zum entfernten Computer nicht möglich. Prüfe das Netzwerk oder ob der andere Computer online ist.', 'Dieser Zugriff ist abgelaufen. Öffne ihn im lokalen Plugin erneut.', 'Zugriff ungültig oder widerrufen. Kopple diesen Computer erneut.', 'Erneut versuchen'],
  es: ['Conectando con el ordenador remoto…', 'No se puede conectar al ordenador remoto. Comprueba tu red o si el otro ordenador está en línea.', 'Este acceso ha caducado. Vuelve al complemento local para abrirlo de nuevo.', 'Acceso no válido o revocado. Vincula este ordenador de nuevo.', 'Reintentar'],
  fr: ['Connexion à l’ordinateur distant…', 'Connexion à l’ordinateur distant impossible. Vérifiez votre réseau ou si l’autre ordinateur est en ligne.', 'Cet accès a expiré. Revenez au plugin local pour le rouvrir.', 'Accès invalide ou révoqué. Associez cet ordinateur à nouveau.', 'Réessayer'],
  pt: ['Conectando ao computador remoto…', 'Não foi possível conectar ao computador remoto. Verifique sua rede ou se o outro computador está online.', 'Este acesso expirou. Volte ao plugin local para abrir novamente.', 'Acesso inválido ou revogado. Vincule este computador novamente.', 'Tentar novamente'],
  ru: ['Подключение к удалённому компьютеру…', 'Не удаётся подключиться к удалённому компьютеру. Проверьте сеть или включён ли другой компьютер.', 'Срок доступа истёк. Откройте его заново в локальном плагине.', 'Доступ недействителен или отозван. Подключите этот компьютер заново.', 'Повторить'],
};

/** 就绪探测路径与「已就绪」跳转标记，网关两侧共用。 */
const READY_PATH = '/__dsh_remote_ready';
const READY_PARAM = '__dsh_ready';

const PAGE_CSS = `
html, body { height: 100%; margin: 0; }
body {
  display: flex; align-items: center; justify-content: center;
  background: Canvas; color: CanvasText;
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
#box { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 24px; text-align: center; max-width: 360px; }
#spinner {
  width: 28px; height: 28px; box-sizing: border-box;
  border: 2.5px solid rgba(128, 128, 128, .3);
  border-top-color: rgba(128, 128, 128, .9); border-radius: 50%;
  animation: dshm-spin .9s linear infinite;
}
#spinner[hidden] { display: none; }
#msg { margin: 0; }
#retry {
  font: inherit; padding: 6px 16px; border-radius: 8px; cursor: pointer;
  border: .5px solid rgba(128, 128, 128, .45);
  background: transparent; color: inherit;
}
#retry[hidden] { display: none; }
@keyframes dshm-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { #spinner { animation-duration: 2.5s; } }
`;

/** 生成过渡页 HTML：先转圈，fetch 就绪探测，成功后跳到真实页面，失败则提示并给重试。 */
function loadingPageHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH</title>
<style>${PAGE_CSS}</style>
</head><body>
<div id="box">
  <div id="spinner" aria-hidden="true"></div>
  <p id="msg" role="status" aria-live="polite"></p>
  <button id="retry" type="button" hidden></button>
</div>
<script>
(function () {
  var TEXT = ${JSON.stringify(TEXT)};
  function language() {
    var tag = String(navigator.language || 'en').replace(/_/g, '-').toLowerCase();
    var parts = tag.split('-');
    if (parts[0] === 'zh') return parts.some(function (p) { return ['hant', 'tw', 'hk', 'mo'].indexOf(p) >= 0; }) ? 'zh-Hant' : 'zh-Hans';
    return TEXT[parts[0]] ? parts[0] : 'en';
  }
  var T = TEXT[language()] || TEXT.en;
  var msg = document.getElementById('msg');
  var retry = document.getElementById('retry');
  var spinner = document.getElementById('spinner');
  msg.textContent = T[0];
  retry.textContent = T[4];
  var settled = false;
  retry.addEventListener('click', function () { location.replace('/'); });
  function fail(code) {
    if (settled) return;
    settled = true;
    spinner.hidden = true;
    var index = code === 'REMOTE_EXPIRED' ? 2
      : (code === 'REMOTE_REVOKED' || code === 'REMOTE_AUTH' || code === 'REMOTE_VERSION') ? 3 : 1;
    msg.textContent = T[index];
    retry.hidden = false;
  }
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); fail('REMOTE_TIMEOUT'); }, 45000);
  fetch(${JSON.stringify(READY_PATH)}, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' }, signal: controller.signal })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      clearTimeout(timer);
      if (data && data.ok) { settled = true; location.replace('/?${READY_PARAM}=1'); }
      else fail(data && data.code);
    })
    .catch(function () { clearTimeout(timer); fail('REMOTE_CONNECT'); });
})();
</script>
</body></html>`;
}

module.exports = { loadingPageHtml, READY_PATH, READY_PARAM };
