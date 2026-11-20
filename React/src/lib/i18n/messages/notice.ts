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
  },
  'zh-Hant': {
    'panel.publicRelayNotice.title': '關於使用公共網路的通知',
    'panel.publicRelayNotice.body': '公共網路（公用中轉）是為了方便你第一次使用 App 時，能更快地綁定裝置、直接開始體驗。\n\n考量到安全性與穩定性，長期使用建議你自行架設網路，讓連線與資料都掌握在自己手裡。\n\n當你的裝置不再使用公共網路時，此通知會自動消失。\n\n建議你自行詢問你的 AI，為你量身打造合適的網路方案。',
    'panel.publicRelayNotice.action': '我已知曉',
  },
  en: {
    'panel.publicRelayNotice.title': 'About Using the Public Network',
    'panel.publicRelayNotice.body': 'The public network (public relay) exists to make it quicker to pair your device and start trying the App the first time you use it.\n\nFor security and stability, we recommend setting up your own network for long-term use, so your connections and data stay in your hands.\n\nThis notice will disappear automatically once your device no longer uses the public network.\n\nConsider asking your AI to tailor a suitable network setup for you.',
    'panel.publicRelayNotice.action': 'Got it',
  },
  ja: {
    'panel.publicRelayNotice.title': 'パブリックネットワークのご利用について',
    'panel.publicRelayNotice.body': 'パブリックネットワーク（公開リレー）は、App を初めて使うときにデバイスをより速くペアリングし、すぐに体験を始められるようにするためのものです。\n\nセキュリティと安定性の観点から、長期的に使う場合はご自身でのネットワーク構築をおすすめします。接続とデータを自分の手元で管理できます。\n\nデバイスがパブリックネットワークを使わなくなると、この通知は自動的に消えます。\n\nお使いの AI に相談して、最適なネットワーク構成を調整してもらうことをおすすめします。',
    'panel.publicRelayNotice.action': '了解しました',
  },
  ko: {
    'panel.publicRelayNotice.title': '공용 네트워크 사용에 관한 안내',
    'panel.publicRelayNotice.body': '공용 네트워크(공용 릴레이)는 App을 처음 사용할 때 기기를 더 빠르게 페어링하고 바로 체험할 수 있도록 돕기 위한 것입니다.\n\n보안과 안정성을 위해 장기적으로 사용하실 때는 직접 네트워크를 구축하시길 권장합니다. 연결과 데이터를 직접 관리할 수 있습니다.\n\n기기가 더 이상 공용 네트워크를 사용하지 않으면 이 안내는 자동으로 사라집니다.\n\n사용 중인 AI에게 물어보고 알맞은 네트워크 구성을 맞춤 설정하시길 권장합니다.',
    'panel.publicRelayNotice.action': '확인',
  },
  de: {
    'panel.publicRelayNotice.title': 'Hinweis zur Nutzung des öffentlichen Netzwerks',
    'panel.publicRelayNotice.body': 'Das öffentliche Netzwerk (öffentliches Relay) soll es erleichtern, dein Gerät beim ersten Einsatz der App schneller zu koppeln und direkt loszulegen.\n\nAus Gründen der Sicherheit und Stabilität empfehlen wir für die dauerhafte Nutzung, ein eigenes Netzwerk aufzubauen, damit Verbindungen und Daten in deiner Hand bleiben.\n\nDieser Hinweis verschwindet automatisch, sobald dein Gerät das öffentliche Netzwerk nicht mehr nutzt.\n\nFrag am besten deine KI, eine passende Netzwerklösung für dich einzurichten.',
    'panel.publicRelayNotice.action': 'Verstanden',
  },
  es: {
    'panel.publicRelayNotice.title': 'Aviso sobre el uso de la red pública',
    'panel.publicRelayNotice.body': 'La red pública (relé público) existe para que la primera vez que uses la App puedas vincular el dispositivo más rápido y empezar a probarla enseguida.\n\nPor seguridad y estabilidad, para el uso a largo plazo te recomendamos montar tu propia red, para que las conexiones y los datos queden en tus manos.\n\nEste aviso desaparecerá automáticamente cuando tu dispositivo deje de usar la red pública.\n\nTe sugerimos preguntar a tu IA para que te configure una solución de red adecuada.',
    'panel.publicRelayNotice.action': 'Entendido',
  },
  fr: {
    'panel.publicRelayNotice.title': 'À propos de l\'utilisation du réseau public',
    'panel.publicRelayNotice.body': 'Le réseau public (relais public) sert à faciliter l\'association de votre appareil et à démarrer rapidement la première fois que vous utilisez l\'App.\n\nPour des raisons de sécurité et de stabilité, nous vous recommandons de mettre en place votre propre réseau pour un usage durable, afin de garder les connexions et les données entre vos mains.\n\nCet avis disparaîtra automatiquement dès que votre appareil n\'utilisera plus le réseau public.\n\nPensez à demander à votre IA de vous configurer une solution réseau adaptée.',
    'panel.publicRelayNotice.action': 'Compris',
  },
  pt: {
    'panel.publicRelayNotice.title': 'Aviso sobre o uso da rede pública',
    'panel.publicRelayNotice.body': 'A rede pública (retransmissor público) serve para facilitar a vinculação do seu dispositivo e começar a experimentar mais rápido na primeira vez que você usa o App.\n\nPor segurança e estabilidade, para uso a longo prazo recomendamos montar a sua própria rede, para manter as conexões e os dados nas suas mãos.\n\nEste aviso desaparecerá automaticamente quando o seu dispositivo deixar de usar a rede pública.\n\nSugerimos que pergunte à sua IA para configurar uma solução de rede adequada para você.',
    'panel.publicRelayNotice.action': 'Entendi',
  },
  ru: {
    'panel.publicRelayNotice.title': 'Об использовании публичной сети',
    'panel.publicRelayNotice.body': 'Публичная сеть (публичный ретранслятор) нужна, чтобы при первом запуске App можно было быстрее привязать устройство и сразу начать работу.\n\nВ целях безопасности и стабильности при долгосрочном использовании рекомендуем развернуть собственную сеть, чтобы соединения и данные оставались под вашим контролем.\n\nЭто уведомление исчезнет автоматически, когда ваше устройство перестанет использовать публичную сеть.\n\nСоветуем спросить у своего ИИ, чтобы он подобрал подходящую схему сети.',
    'panel.publicRelayNotice.action': 'Понятно',
  },
}
