// 用途：一次性提示文案（公用中转通知与反馈回执），十门语言逐键对齐。
/**
 * 面板「公用中转提示」弹窗的文案（十门语言）。
 *
 * 这扇弹窗只在用户还在用公用中转时进来弹一次，可关闭；正文是一整段带空行的长句，靠
 * `whitespace-pre-line` 还原分段，不拆成多条键。
 */
import type { PanelMessages } from './shell.ts'

export const NOTICE: PanelMessages = {
  'zh-Hans': {
    'panel.publicRelayNotice.title': '关于使用公共网络的通知',
    'panel.publicRelayNotice.body': '公共网络（公用中转）是为了方便你第一次使用 App 时，能更快地绑定设备、直接开始体验。\n\n考虑到安全性和稳定性，长期使用建议你自行搭建网络，让连接和数据都掌握在自己手里。\n\n当你的设备不再使用公用网络时，此通知会自动消失。\n\n建议你自行询问你的 AI，为你定制合适的网络方案。',
    'panel.publicRelayNotice.action': '我已知晓',
    'panel.feedback.receipt': '已提交，反馈编号 {key}。请复制编号留档；这条先留在本机，不会写进 App 的反馈列表。',
    'panel.feedback.copyKey': '复制编号',
    'panel.feedback.keyCopied': '编号已复制。',
    'panel.feedback.keyCopyFailed': '复制失败，请手动选中编号复制。',
  },
  'zh-Hant': {
    'panel.publicRelayNotice.title': '關於使用公共網路的通知',
    'panel.publicRelayNotice.body': '公共網路（公用中轉）是為了方便你第一次使用 App 時，能更快地綁定裝置、直接開始體驗。\n\n考量到安全性與穩定性，長期使用建議你自行架設網路，讓連線與資料都掌握在自己手裡。\n\n當你的裝置不再使用公共網路時，此通知會自動消失。\n\n建議你自行詢問你的 AI，為你量身打造合適的網路方案。',
    'panel.publicRelayNotice.action': '我已知曉',
    'panel.feedback.receipt': '已提交，回饋編號 {key}。請複製編號留存；這則先留在本機，不會寫進 App 的回饋清單。',
    'panel.feedback.copyKey': '複製編號',
    'panel.feedback.keyCopied': '編號已複製。',
    'panel.feedback.keyCopyFailed': '複製失敗，請手動選取編號複製。',
  },
  en: {
    'panel.publicRelayNotice.title': 'About Using the Public Network',
    'panel.publicRelayNotice.body': 'The public network (public relay) exists to make it quicker to pair your device and start trying the App the first time you use it.\n\nFor security and stability, we recommend setting up your own network for long-term use, so your connections and data stay in your hands.\n\nThis notice will disappear automatically once your device no longer uses the public network.\n\nConsider asking your AI to tailor a suitable network setup for you.',
    'panel.publicRelayNotice.action': 'Got it',
    'panel.feedback.receipt': 'Submitted. Feedback key {key}. Copy it for your records; this stays local first and is not written into the in-app feedback list.',
    'panel.feedback.copyKey': 'Copy key',
    'panel.feedback.keyCopied': 'Key copied.',
    'panel.feedback.keyCopyFailed': 'Could not copy the key; select it and copy it manually.',
  },
  ja: {
    'panel.publicRelayNotice.title': 'パブリックネットワークのご利用について',
    'panel.publicRelayNotice.body': 'パブリックネットワーク（公開リレー）は、App を初めて使うときにデバイスをより速くペアリングし、すぐに体験を始められるようにするためのものです。\n\nセキュリティと安定性の観点から、長期的に使う場合はご自身でのネットワーク構築をおすすめします。接続とデータを自分の手元で管理できます。\n\nデバイスがパブリックネットワークを使わなくなると、この通知は自動的に消えます。\n\nお使いの AI に相談して、最適なネットワーク構成を調整してもらうことをおすすめします。',
    'panel.publicRelayNotice.action': '了解しました',
    'panel.feedback.receipt': '送信しました。フィードバック番号 {key}。番号をコピーして控えてください。まずこのコンピューターに残され、App のフィードバック一覧には書き込まれません。',
    'panel.feedback.copyKey': '番号をコピー',
    'panel.feedback.keyCopied': '番号をコピーしました。',
    'panel.feedback.keyCopyFailed': 'コピーできませんでした。番号を選択して手動でコピーしてください。',
  },
  ko: {
    'panel.publicRelayNotice.title': '공용 네트워크 사용에 관한 안내',
    'panel.publicRelayNotice.body': '공용 네트워크(공용 릴레이)는 App을 처음 사용할 때 기기를 더 빠르게 페어링하고 바로 체험할 수 있도록 돕기 위한 것입니다.\n\n보안과 안정성을 위해 장기적으로 사용하실 때는 직접 네트워크를 구축하시길 권장합니다. 연결과 데이터를 직접 관리할 수 있습니다.\n\n기기가 더 이상 공용 네트워크를 사용하지 않으면 이 안내는 자동으로 사라집니다.\n\n사용 중인 AI에게 물어보고 알맞은 네트워크 구성을 맞춤 설정하시길 권장합니다.',
    'panel.publicRelayNotice.action': '확인',
    'panel.feedback.receipt': '제출했습니다. 피드백 번호 {key}. 번호를 복사해 보관하세요. 이 내용은 먼저 이 컴퓨터에 남으며 App 피드백 목록에는 기록되지 않습니다.',
    'panel.feedback.copyKey': '번호 복사',
    'panel.feedback.keyCopied': '번호를 복사했습니다.',
    'panel.feedback.keyCopyFailed': '복사하지 못했습니다. 번호를 선택해 직접 복사하세요.',
  },
  de: {
    'panel.publicRelayNotice.title': 'Hinweis zur Nutzung des öffentlichen Netzwerks',
    'panel.publicRelayNotice.body': 'Das öffentliche Netzwerk (öffentliches Relay) soll es erleichtern, dein Gerät beim ersten Einsatz der App schneller zu koppeln und direkt loszulegen.\n\nAus Gründen der Sicherheit und Stabilität empfehlen wir für die dauerhafte Nutzung, ein eigenes Netzwerk aufzubauen, damit Verbindungen und Daten in deiner Hand bleiben.\n\nDieser Hinweis verschwindet automatisch, sobald dein Gerät das öffentliche Netzwerk nicht mehr nutzt.\n\nFrag am besten deine KI, eine passende Netzwerklösung für dich einzurichten.',
    'panel.publicRelayNotice.action': 'Verstanden',
    'panel.feedback.receipt': 'Gesendet. Feedback-Schlüssel {key}. Kopiere ihn für deine Unterlagen; er bleibt zunächst auf diesem Rechner und wird nicht in die Feedback-Liste der App geschrieben.',
    'panel.feedback.copyKey': 'Schlüssel kopieren',
    'panel.feedback.keyCopied': 'Schlüssel kopiert.',
    'panel.feedback.keyCopyFailed': 'Kopieren fehlgeschlagen; markiere den Schlüssel und kopiere ihn von Hand.',
  },
  es: {
    'panel.publicRelayNotice.title': 'Aviso sobre el uso de la red pública',
    'panel.publicRelayNotice.body': 'La red pública (relé público) existe para que la primera vez que uses la App puedas vincular el dispositivo más rápido y empezar a probarla enseguida.\n\nPor seguridad y estabilidad, para el uso a largo plazo te recomendamos montar tu propia red, para que las conexiones y los datos queden en tus manos.\n\nEste aviso desaparecerá automáticamente cuando tu dispositivo deje de usar la red pública.\n\nTe sugerimos preguntar a tu IA para que te configure una solución de red adecuada.',
    'panel.publicRelayNotice.action': 'Entendido',
    'panel.feedback.receipt': 'Enviado. Clave de comentarios {key}. Cópiala para tus registros; primero se queda en este equipo y no se escribe en la lista de comentarios de la App.',
    'panel.feedback.copyKey': 'Copiar clave',
    'panel.feedback.keyCopied': 'Clave copiada.',
    'panel.feedback.keyCopyFailed': 'No se pudo copiar; selecciona la clave y cópiala a mano.',
  },
  fr: {
    'panel.publicRelayNotice.title': 'À propos de l\'utilisation du réseau public',
    'panel.publicRelayNotice.body': 'Le réseau public (relais public) sert à faciliter l\'association de votre appareil et à démarrer rapidement la première fois que vous utilisez l\'App.\n\nPour des raisons de sécurité et de stabilité, nous vous recommandons de mettre en place votre propre réseau pour un usage durable, afin de garder les connexions et les données entre vos mains.\n\nCet avis disparaîtra automatiquement dès que votre appareil n\'utilisera plus le réseau public.\n\nPensez à demander à votre IA de vous configurer une solution réseau adaptée.',
    'panel.publicRelayNotice.action': 'Compris',
    'panel.feedback.receipt': 'Envoyé. Clé de retour {key}. Copiez-la pour vos archives ; elle reste d\'abord sur cet ordinateur et n\'est pas inscrite dans la liste de retours de l\'App.',
    'panel.feedback.copyKey': 'Copier la clé',
    'panel.feedback.keyCopied': 'Clé copiée.',
    'panel.feedback.keyCopyFailed': 'Copie impossible ; sélectionnez la clé et copiez-la à la main.',
  },
  pt: {
    'panel.publicRelayNotice.title': 'Aviso sobre o uso da rede pública',
    'panel.publicRelayNotice.body': 'A rede pública (retransmissor público) serve para facilitar a vinculação do seu dispositivo e começar a experimentar mais rápido na primeira vez que você usa o App.\n\nPor segurança e estabilidade, para uso a longo prazo recomendamos montar a sua própria rede, para manter as conexões e os dados nas suas mãos.\n\nEste aviso desaparecerá automaticamente quando o seu dispositivo deixar de usar a rede pública.\n\nSugerimos que pergunte à sua IA para configurar uma solução de rede adequada para você.',
    'panel.publicRelayNotice.action': 'Entendi',
    'panel.feedback.receipt': 'Enviado. Chave de feedback {key}. Copie-a para seus registros; ela fica primeiro neste computador e não é gravada na lista de feedback do App.',
    'panel.feedback.copyKey': 'Copiar chave',
    'panel.feedback.keyCopied': 'Chave copiada.',
    'panel.feedback.keyCopyFailed': 'Não foi possível copiar; selecione a chave e copie manualmente.',
  },
  ru: {
    'panel.publicRelayNotice.title': 'Об использовании публичной сети',
    'panel.publicRelayNotice.body': 'Публичная сеть (публичный ретранслятор) нужна, чтобы при первом запуске App можно было быстрее привязать устройство и сразу начать работу.\n\nВ целях безопасности и стабильности при долгосрочном использовании рекомендуем развернуть собственную сеть, чтобы соединения и данные оставались под вашим контролем.\n\nЭто уведомление исчезнет автоматически, когда ваше устройство перестанет использовать публичную сеть.\n\nСоветуем спросить у своего ИИ, чтобы он подобрал подходящую схему сети.',
    'panel.publicRelayNotice.action': 'Понятно',
    'panel.feedback.receipt': 'Отправлено. Ключ обратной связи {key}. Скопируйте его для сохранения; сначала он остаётся на этом компьютере и не записывается в список отзывов App.',
    'panel.feedback.copyKey': 'Скопировать ключ',
    'panel.feedback.keyCopied': 'Ключ скопирован.',
    'panel.feedback.keyCopyFailed': 'Не удалось скопировать; выделите ключ и скопируйте вручную.',
  },
}
