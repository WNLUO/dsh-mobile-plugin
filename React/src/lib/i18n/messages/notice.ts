// 用途：一次性提示文案（公用中转通知与反馈回执），十门语言逐键对齐。
/**
 * 面板「公用中转提示」弹窗与反馈回执的文案（十门语言）。
 *
 * 公用中转这扇只在用户还在用公用中转时进来弹一次，可关闭；正文是一整段带空行的长句，靠
 * `whitespace-pre-line` 还原分段，不拆成多条键。
 */
import type { PanelMessages } from './shell.ts'

export const NOTICE: PanelMessages = {
  'zh-Hans': {
    'panel.publicRelayNotice.title': '关于公用中转',
    'panel.publicRelayNotice.body': '公用中转（公共网络）我们以后不再提供，建议尽早配置一条自己的网络，这样不受影响。\n\n国内可以用 ZeroNews 或节点小宝，海外可以用 Cloudflare，也可以自建中转、直连或其它公网入口。\n\n配好之后不再走公用中转，这个提示也就不会再出现。\n\n拿不准怎么配，可以让你的 AI 帮你挑一条合适的方案。',
    'panel.publicRelayNotice.action': '稍后再说',
    'panel.feedback.receipt': '已提交，反馈编号 {key}。请复制编号留档；这条先留在本机，不会写进 App 的反馈列表。',
    'panel.feedback.copyKey': '复制编号',
    'panel.feedback.keyCopied': '编号已复制。',
    'panel.feedback.keyCopyFailed': '复制失败，请手动选中编号复制。',
  },
  'zh-Hant': {
    'panel.publicRelayNotice.title': '關於公用中轉',
    'panel.publicRelayNotice.body': '公用中轉（公共網路）我們之後不再提供，建議盡早設定一條自己的網路，這樣不受影響。\n\n國內可以用 ZeroNews 或節點小寶，海外可以用 Cloudflare，也可以自架中轉、直連或其它公網入口。\n\n設定好之後就不再走公用中轉，這個提示也不會再出現。\n\n不確定怎麼設定，可以請你的 AI 幫你挑一條合適的方案。',
    'panel.publicRelayNotice.action': '稍後再說',
    'panel.feedback.receipt': '已提交，回饋編號 {key}。請複製編號留存；這則先留在本機，不會寫進 App 的回饋清單。',
    'panel.feedback.copyKey': '複製編號',
    'panel.feedback.keyCopied': '編號已複製。',
    'panel.feedback.keyCopyFailed': '複製失敗，請手動選取編號複製。',
  },
  en: {
    'panel.publicRelayNotice.title': 'About the public relay',
    'panel.publicRelayNotice.body': 'We will no longer provide the public relay (public network) going forward, so it is best to set up your own network soon to avoid disruption.\n\nIn China you can use ZeroNews or Jdxb; elsewhere Cloudflare works, or you can run your own relay, a direct connection, or another public entry.\n\nOnce your own network is set up, traffic no longer goes through the public relay and this notice will stop appearing.\n\nIf you are unsure how to set it up, ask your AI to pick a suitable option for you.',
    'panel.publicRelayNotice.action': 'Later',
    'panel.feedback.receipt': 'Submitted. Feedback key {key}. Copy it for your records; this stays local first and is not written into the in-app feedback list.',
    'panel.feedback.copyKey': 'Copy key',
    'panel.feedback.keyCopied': 'Key copied.',
    'panel.feedback.keyCopyFailed': 'Could not copy the key; select it and copy it manually.',
  },
  ja: {
    'panel.publicRelayNotice.title': '公開リレーについて',
    'panel.publicRelayNotice.body': '公開リレー（パブリックネットワーク）は今後提供を終了します。影響を避けるため、早めにご自身のネットワークを設定することをおすすめします。\n\n中国では ZeroNews やノード小宝、海外では Cloudflare が使えます。自前の中継、直接接続、その他の公開入口でも構いません。\n\nご自身のネットワークを設定すれば公開リレーを使わなくなり、この案内も表示されなくなります。\n\n設定方法が分からない場合は、お使いの AI に合った方法を選んでもらってください。',
    'panel.publicRelayNotice.action': 'あとで',
    'panel.feedback.receipt': '送信しました。フィードバック番号 {key}。番号をコピーして控えてください。まずこのコンピューターに残され、App のフィードバック一覧には書き込まれません。',
    'panel.feedback.copyKey': '番号をコピー',
    'panel.feedback.keyCopied': '番号をコピーしました。',
    'panel.feedback.keyCopyFailed': 'コピーできませんでした。番号を選択して手動でコピーしてください。',
  },
  ko: {
    'panel.publicRelayNotice.title': '공용 릴레이 안내',
    'panel.publicRelayNotice.body': '공용 릴레이(공용 네트워크)는 앞으로 제공하지 않습니다. 영향을 받지 않으려면 되도록 빨리 직접 네트워크를 설정하시길 권장합니다.\n\n중국에서는 ZeroNews나 Jdxb, 해외에서는 Cloudflare를 쓸 수 있고, 직접 중계 서버·직접 연결·기타 공인 진입점을 써도 됩니다.\n\n직접 네트워크를 설정하면 더 이상 공용 릴레이를 쓰지 않게 되고 이 안내도 나타나지 않습니다.\n\n설정 방법이 막막하면 사용 중인 AI에게 알맞은 방법을 골라 달라고 하세요.',
    'panel.publicRelayNotice.action': '나중에',
    'panel.feedback.receipt': '제출했습니다. 피드백 번호 {key}. 번호를 복사해 보관하세요. 이 내용은 먼저 이 컴퓨터에 남으며 App 피드백 목록에는 기록되지 않습니다.',
    'panel.feedback.copyKey': '번호 복사',
    'panel.feedback.keyCopied': '번호를 복사했습니다.',
    'panel.feedback.keyCopyFailed': '복사하지 못했습니다. 번호를 선택해 직접 복사하세요.',
  },
  de: {
    'panel.publicRelayNotice.title': 'Zum öffentlichen Relay',
    'panel.publicRelayNotice.body': 'Das öffentliche Relay (öffentliches Netzwerk) bieten wir künftig nicht mehr an. Richte am besten bald ein eigenes Netzwerk ein, um Ausfälle zu vermeiden.\n\nIn China kannst du ZeroNews oder Jdxb nutzen, international Cloudflare, oder du betreibst ein eigenes Relay, eine direkte Verbindung oder einen anderen öffentlichen Zugang.\n\nSobald dein eigenes Netzwerk steht, läuft nichts mehr über das öffentliche Relay und dieser Hinweis verschwindet.\n\nWenn du unsicher bist, frag deine KI, welche Variante zu dir passt.',
    'panel.publicRelayNotice.action': 'Später',
    'panel.feedback.receipt': 'Gesendet. Feedback-Schlüssel {key}. Kopiere ihn für deine Unterlagen; er bleibt zunächst auf diesem Rechner und wird nicht in die Feedback-Liste der App geschrieben.',
    'panel.feedback.copyKey': 'Schlüssel kopieren',
    'panel.feedback.keyCopied': 'Schlüssel kopiert.',
    'panel.feedback.keyCopyFailed': 'Kopieren fehlgeschlagen; markiere den Schlüssel und kopiere ihn von Hand.',
  },
  es: {
    'panel.publicRelayNotice.title': 'Sobre el relé público',
    'panel.publicRelayNotice.body': 'Dejaremos de ofrecer el relé público (red pública), así que conviene configurar tu propia red pronto para no verte afectado.\n\nEn China puedes usar ZeroNews o Jdxb; en el resto del mundo sirve Cloudflare, o puedes montar tu propio relé, una conexión directa u otra entrada pública.\n\nCuando tengas tu propia red, el tráfico dejará de pasar por el relé público y este aviso dejará de aparecer.\n\nSi no sabes cómo, pide a tu IA que elija una opción adecuada para ti.',
    'panel.publicRelayNotice.action': 'Más tarde',
    'panel.feedback.receipt': 'Enviado. Clave de comentarios {key}. Cópiala para tus registros; primero se queda en este equipo y no se escribe en la lista de comentarios de la App.',
    'panel.feedback.copyKey': 'Copiar clave',
    'panel.feedback.keyCopied': 'Clave copiada.',
    'panel.feedback.keyCopyFailed': 'No se pudo copiar; selecciona la clave y cópiala a mano.',
  },
  fr: {
    'panel.publicRelayNotice.title': 'À propos du relais public',
    'panel.publicRelayNotice.body': 'Nous ne fournirons plus le relais public (réseau public) à l\'avenir ; mieux vaut donc configurer votre propre réseau rapidement pour éviter toute coupure.\n\nEn Chine, vous pouvez utiliser ZeroNews ou Jdxb ; ailleurs, Cloudflare convient, ou vous pouvez héberger votre propre relais, une connexion directe ou une autre entrée publique.\n\nUne fois votre réseau en place, le trafic ne passera plus par le relais public et cet avis ne s\'affichera plus.\n\nSi vous hésitez, demandez à votre IA de choisir une option adaptée.',
    'panel.publicRelayNotice.action': 'Plus tard',
    'panel.feedback.receipt': 'Envoyé. Clé de retour {key}. Copiez-la pour vos archives ; elle reste d\'abord sur cet ordinateur et n\'est pas inscrite dans la liste de retours de l\'App.',
    'panel.feedback.copyKey': 'Copier la clé',
    'panel.feedback.keyCopied': 'Clé copiée.',
    'panel.feedback.keyCopyFailed': 'Copie impossible ; sélectionnez la clé et copiez-la à la main.',
  },
  pt: {
    'panel.publicRelayNotice.title': 'Sobre o retransmissor público',
    'panel.publicRelayNotice.body': 'Não vamos mais oferecer o retransmissor público (rede pública), então é melhor configurar a sua própria rede logo para não ser afetado.\n\nNa China você pode usar ZeroNews ou Jdxb; no exterior, o Cloudflare serve, ou você pode montar seu próprio retransmissor, uma conexão direta ou outra entrada pública.\n\nQuando tiver a sua própria rede, o tráfego deixa de passar pelo retransmissor público e este aviso para de aparecer.\n\nSe não souber como, peça à sua IA para escolher uma opção adequada.',
    'panel.publicRelayNotice.action': 'Mais tarde',
    'panel.feedback.receipt': 'Enviado. Chave de feedback {key}. Copie-a para seus registros; ela fica primeiro neste computador e não é gravada na lista de feedback do App.',
    'panel.feedback.copyKey': 'Copiar chave',
    'panel.feedback.keyCopied': 'Chave copiada.',
    'panel.feedback.keyCopyFailed': 'Não foi possível copiar; selecione a chave e copie manualmente.',
  },
  ru: {
    'panel.publicRelayNotice.title': 'О публичном ретрансляторе',
    'panel.publicRelayNotice.body': 'Публичный ретранслятор (публичную сеть) мы больше не предоставляем. Лучше поскорее настроить собственную сеть, чтобы это вас не затронуло.\n\nВ Китае можно использовать ZeroNews или Jdxb, за рубежом подойдёт Cloudflare; также можно поднять свой ретранслятор, прямое подключение или другой публичный вход.\n\nКогда своя сеть будет настроена, трафик перестанет идти через публичный ретранслятор, и это уведомление больше не появится.\n\nЕсли не знаете как, попросите свой ИИ подобрать подходящий вариант.',
    'panel.publicRelayNotice.action': 'Позже',
    'panel.feedback.receipt': 'Отправлено. Ключ обратной связи {key}. Скопируйте его для сохранения; сначала он остаётся на этом компьютере и не записывается в список отзывов App.',
    'panel.feedback.copyKey': 'Скопировать ключ',
    'panel.feedback.keyCopied': 'Ключ скопирован.',
    'panel.feedback.keyCopyFailed': 'Не удалось скопировать; выделите ключ и скопируйте вручную.',
  },
}
