/**
 * 网络面板文案：右侧空列那张卡，延迟画真实曲线，流量目前只有「暂无统计」的占位。
 *
 * 十门语言逐键对齐（守卫 `test/panel-network-panel.test.cjs` 会查），以后往容器里加块，
 * 文案往这里加，组件那层不用散着写。
 */
import type { PanelLanguage } from '../core.ts'

type Table = Record<string, string>
export type PanelMessages = Record<PanelLanguage, Table>

/** 网络面板的标题、延迟块与流量块。 */
export const NETWORK_PANEL: PanelMessages = {
  'zh-Hans': {
    'panel.network.title': '网络面板',
    'panel.network.latencyTitle': '中转延迟',
    'panel.network.latencyHint': '每 5 秒测一次当前中转，保留最近 14 次',
    'panel.network.noRelay': '当前没有中转，走的是直连，这里没有延迟曲线。',
    'panel.network.trafficTitle': '流量',
    'panel.network.trafficEmpty': '暂无统计：宿主还没有流量统计接口。',
  },
  'zh-Hant': {
    'panel.network.title': '網路面板',
    'panel.network.latencyTitle': '中轉延遲',
    'panel.network.latencyHint': '每 5 秒測一次當前中轉，保留最近 14 次',
    'panel.network.noRelay': '當前沒有中轉，走的是直連，這裡沒有延遲曲線。',
    'panel.network.trafficTitle': '流量',
    'panel.network.trafficEmpty': '暫無統計：宿主還沒有流量統計介面。',
  },
  en: {
    'panel.network.title': 'Network',
    'panel.network.latencyTitle': 'Relay latency',
    'panel.network.latencyHint': 'Probed every 5 seconds; last 14 samples kept',
    'panel.network.noRelay': 'No relay configured — this host is on direct connection, so there is no latency curve here.',
    'panel.network.trafficTitle': 'Traffic',
    'panel.network.trafficEmpty': 'No statistics yet: the host does not expose traffic counters.',
  },
  ja: {
    'panel.network.title': 'ネットワーク',
    'panel.network.latencyTitle': '中継遅延',
    'panel.network.latencyHint': '5 秒ごとに現在の中継を測定し、直近 14 回を保持',
    'panel.network.noRelay': '中継がありません。ダイレクト接続のため、ここに遅延曲線はありません。',
    'panel.network.trafficTitle': 'トラフィック',
    'panel.network.trafficEmpty': '統計なし：ホストにトラフィック統計インターフェースがありません。',
  },
  ko: {
    'panel.network.title': '네트워크',
    'panel.network.latencyTitle': '릴레이 지연',
    'panel.network.latencyHint': '5초마다 현재 릴레이를 측정하고 최근 14회를 유지',
    'panel.network.noRelay': '릴레이가 없습니다. 직접 연결이라 여기에는 지연 곡선이 없습니다.',
    'panel.network.trafficTitle': '트래픽',
    'panel.network.trafficEmpty': '통계 없음: 호스트에 트래픽 통계 인터페이스가 없습니다.',
  },
  de: {
    'panel.network.title': 'Netzwerk',
    'panel.network.latencyTitle': 'Relay-Latenz',
    'panel.network.latencyHint': 'Alle 5 Sekunden gemessen, letzte 14 Werte behalten',
    'panel.network.noRelay': 'Kein Relay konfiguriert — Direktverbindung, daher gibt es hier keine Latenzkurve.',
    'panel.network.trafficTitle': 'Datenverkehr',
    'panel.network.trafficEmpty': 'Keine Statistik: der Host stellt keine Verkehrszähler bereit.',
  },
  es: {
    'panel.network.title': 'Red',
    'panel.network.latencyTitle': 'Latencia del retransmisor',
    'panel.network.latencyHint': 'Se mide cada 5 segundos; se conservan los últimos 14 valores',
    'panel.network.noRelay': 'No hay retransmisor: conexión directa, así que no hay curva de latencia aquí.',
    'panel.network.trafficTitle': 'Tráfico',
    'panel.network.trafficEmpty': 'Sin estadísticas: el host no expone contadores de tráfico.',
  },
  fr: {
    'panel.network.title': 'Réseau',
    'panel.network.latencyTitle': 'Latence du relais',
    'panel.network.latencyHint': 'Mesurée toutes les 5 secondes ; 14 derniers échantillons conservés',
    'panel.network.noRelay': 'Aucun relais : connexion directe, il n’y a donc pas de courbe de latence ici.',
    'panel.network.trafficTitle': 'Trafic',
    'panel.network.trafficEmpty': 'Aucune statistique : l’hôte n’expose pas de compteurs de trafic.',
  },
  pt: {
    'panel.network.title': 'Rede',
    'panel.network.latencyTitle': 'Latência do relay',
    'panel.network.latencyHint': 'Medido a cada 5 segundos; últimas 14 amostras mantidas',
    'panel.network.noRelay': 'Sem relay: conexão direta, portanto não há curva de latência aqui.',
    'panel.network.trafficTitle': 'Tráfego',
    'panel.network.trafficEmpty': 'Sem estatísticas: o host não expõe contadores de tráfego.',
  },
  ru: {
    'panel.network.title': 'Сеть',
    'panel.network.latencyTitle': 'Задержка ретранслятора',
    'panel.network.latencyHint': 'Замер каждые 5 секунд, хранятся последние 14 значений',
    'panel.network.noRelay': 'Ретранслятор не настроен — прямое соединение, поэтому кривой задержки здесь нет.',
    'panel.network.trafficTitle': 'Трафик',
    'panel.network.trafficEmpty': 'Нет статистики: хост не предоставляет счётчики трафика.',
  },
}
