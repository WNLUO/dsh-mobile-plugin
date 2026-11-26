// 2026-11-26：面板补齐第 11 门语言土耳其语（tr），新增完整 tr 文案表。
// 用途：反馈回执文案，十一门语言逐键对齐。
/**
 * 反馈提交后的回执文案（十一门语言）。
 *
 * 正文是一整段带空行的长句，靠 `whitespace-pre-line` 还原分段，不拆成多条键。
 */
import type { PanelMessages } from './shell.ts'

export const NOTICE: PanelMessages = {
  'zh-Hans': {
    'panel.feedback.receipt': '已提交，反馈编号 {key}。请复制编号留档；这条先留在本机，不会写进 App 的反馈列表。',
    'panel.feedback.copyKey': '复制编号',
    'panel.feedback.keyCopied': '编号已复制。',
    'panel.feedback.keyCopyFailed': '复制失败，请手动选中编号复制。',
  },
  'zh-Hant': {
    'panel.feedback.receipt': '已提交，回饋編號 {key}。請複製編號留存；這則先留在本機，不會寫進 App 的回饋清單。',
    'panel.feedback.copyKey': '複製編號',
    'panel.feedback.keyCopied': '編號已複製。',
    'panel.feedback.keyCopyFailed': '複製失敗，請手動選取編號複製。',
  },
  en: {
    'panel.feedback.receipt': 'Submitted. Feedback key {key}. Copy it for your records; this stays local first and is not written into the in-app feedback list.',
    'panel.feedback.copyKey': 'Copy key',
    'panel.feedback.keyCopied': 'Key copied.',
    'panel.feedback.keyCopyFailed': 'Could not copy the key; select it and copy it manually.',
  },
  ja: {
    'panel.feedback.receipt': '送信しました。フィードバック番号 {key}。番号をコピーして控えてください。まずこのコンピューターに残され、App のフィードバック一覧には書き込まれません。',
    'panel.feedback.copyKey': '番号をコピー',
    'panel.feedback.keyCopied': '番号をコピーしました。',
    'panel.feedback.keyCopyFailed': 'コピーできませんでした。番号を選択して手動でコピーしてください。',
  },
  ko: {
    'panel.feedback.receipt': '제출했습니다. 피드백 번호 {key}. 번호를 복사해 보관하세요. 이 내용은 먼저 이 컴퓨터에 남으며 App 피드백 목록에는 기록되지 않습니다.',
    'panel.feedback.copyKey': '번호 복사',
    'panel.feedback.keyCopied': '번호를 복사했습니다.',
    'panel.feedback.keyCopyFailed': '복사하지 못했습니다. 번호를 선택해 직접 복사하세요.',
  },
  de: {
    'panel.feedback.receipt': 'Gesendet. Feedback-Schlüssel {key}. Kopiere ihn für deine Unterlagen; er bleibt zunächst auf diesem Rechner und wird nicht in die Feedback-Liste der App geschrieben.',
    'panel.feedback.copyKey': 'Schlüssel kopieren',
    'panel.feedback.keyCopied': 'Schlüssel kopiert.',
    'panel.feedback.keyCopyFailed': 'Kopieren fehlgeschlagen; markiere den Schlüssel und kopiere ihn von Hand.',
  },
  es: {
    'panel.feedback.receipt': 'Enviado. Clave de comentarios {key}. Cópiala para tus registros; primero se queda en este equipo y no se escribe en la lista de comentarios de la App.',
    'panel.feedback.copyKey': 'Copiar clave',
    'panel.feedback.keyCopied': 'Clave copiada.',
    'panel.feedback.keyCopyFailed': 'No se pudo copiar; selecciona la clave y cópiala a mano.',
  },
  fr: {
    'panel.feedback.receipt': 'Envoyé. Clé de retour {key}. Copiez-la pour vos archives ; elle reste d\'abord sur cet ordinateur et n\'est pas inscrite dans la liste de retours de l\'App.',
    'panel.feedback.copyKey': 'Copier la clé',
    'panel.feedback.keyCopied': 'Clé copiée.',
    'panel.feedback.keyCopyFailed': 'Copie impossible ; sélectionnez la clé et copiez-la à la main.',
  },
  pt: {
    'panel.feedback.receipt': 'Enviado. Chave de feedback {key}. Copie-a para seus registros; ela fica primeiro neste computador e não é gravada na lista de feedback do App.',
    'panel.feedback.copyKey': 'Copiar chave',
    'panel.feedback.keyCopied': 'Chave copiada.',
    'panel.feedback.keyCopyFailed': 'Não foi possível copiar; selecione a chave e copie manualmente.',
  },
  ru: {
    'panel.feedback.receipt': 'Отправлено. Ключ обратной связи {key}. Скопируйте его для сохранения; сначала он остаётся на этом компьютере и не записывается в список отзывов App.',
    'panel.feedback.copyKey': 'Скопировать ключ',
    'panel.feedback.keyCopied': 'Ключ скопирован.',
    'panel.feedback.keyCopyFailed': 'Не удалось скопировать; выделите ключ и скопируйте вручную.',
  },
  tr: {
    'panel.feedback.receipt': 'Gönderildi. Geri bildirim anahtarı {key}. Kayıtlarınız için kopyalayın; bu önce bu bilgisayarda kalır ve uygulamanın geri bildirim listesine yazılmaz.',
    'panel.feedback.copyKey': 'Anahtarı kopyala',
    'panel.feedback.keyCopied': 'Anahtar kopyalandı.',
    'panel.feedback.keyCopyFailed': 'Anahtar kopyalanamadı; seçip elle kopyalayın.',
  },
}
