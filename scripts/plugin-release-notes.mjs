#!/usr/bin/env node
/**
 * 插件发版说明的唯一读写口。
 *
 * 规格见 `docs/plugin-release-notes.md`，格式与 App 那份（`app/scripts/release-notes.mjs`）
 * 同源：每版一份 JSON、若干条改动、十门语言正文、发布前校验。区别只在**版本坐标取自插件
 * 自己的 `package.json`**（插件版本自成一线，和 App 的 `app/src/version.ts` 不是一套），
 * 文件放在 `docs/plugin-release-notes/`，且改动类型多一档 `security`（界面据此标「安全修复」）。
 *
 * 这里做四件事：
 *   1. 读文件并把关：版本对得上、`from` 齐、`notes` 十门齐全且非空、每门 ≤4000 字符；
 *   2. `--check`：发版预检里单独校验一份文件；
 *   3. `--draft`：按 `from.ref..HEAD` 的提交生成骨架，中文那一门先铺草稿，其余九门留空 ——
 *      绝不把中文复制到别的语言键上冒充翻译；
 *   4. `--stamp`：把这份说明压成一份精简结构写进 `package.json` 的 `dshMobileReleaseNotes`，
 *      随包清单一起发布 —— 旧版本查「有没有新版」时从 npm 注册表就能顺带读到本版说明。
 *
 * 命令行：
 *   node dsh-mobile-plugin/scripts/plugin-release-notes.mjs --version 0.5.105 --check
 *   node dsh-mobile-plugin/scripts/plugin-release-notes.mjs --version 0.5.105 --draft --from-ref <sha> --from-version 0.5.104
 *   node dsh-mobile-plugin/scripts/plugin-release-notes.mjs --version 0.5.105 --stamp
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 插件目录（本脚本所在 `scripts/` 的上一级）。 */
export const PLUGIN_DIR = path.resolve(HERE, '..')
/** 仓库根（插件目录的上一级）。 */
export const ROOT = path.resolve(PLUGIN_DIR, '..')
/** 插件发版说明的存放目录：跟 App 的 `docs/release-notes/` 分开放，避免同号互相覆盖。 */
export const NOTES_DIR = path.join(ROOT, 'docs', 'plugin-release-notes')

/** 各门语言键名，顺序与 `app/src/i18n/language.ts` 的界面语言一致（插件说明面向手机用户）。 */
export const RELEASE_NOTE_LANGS = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko', 'de', 'es', 'fr', 'pt', 'ru', 'tr']

/** 平台每条说明的硬上限；超了拒发，不做静默截断。 */
export const MAX_NOTE_LENGTH = 4000

/** `changes` 里允许的分类。`security` 让界面能单独标出「安全修复」。 */
export const CHANGE_KINDS = ['feature', 'fix', 'security', 'other']

/** `package.json` 里承载本版说明的字段名（旧版本从 npm 注册表清单读它）。 */
export const STAMP_FIELD = 'dshMobileReleaseNotes'

/** 某个版本说明文件的路径。插件版本不带构建号，一个版本一份。 */
export function notesFilePath(version, root = ROOT) {
  return path.join(root, 'docs', 'plugin-release-notes', `${version}.json`)
}

/** 从插件 `package.json` 读本版版本号。 */
export function readPluginVersion(root = ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'dsh-mobile-plugin', 'package.json'), 'utf8'))
  const version = String(pkg.version ?? '').trim()
  if (!version) throw new Error('插件 package.json 里读不到 version')
  return version
}

/**
 * 把一份说明压成随包清单发布的精简结构。
 *
 * 只带界面要用的两样：`notes`（十门正文）与 `kinds`（改动类型去重后的集合，界面据此标
 * 「安全修复 / 功能更新」）。逐条改动的文字已在 `notes` 的条目里，清单里不再重复一遍。
 */
export function compactReleaseNotes(data) {
  const notes = {}
  for (const lang of RELEASE_NOTE_LANGS) notes[lang] = String(data?.notes?.[lang] ?? '')
  const kinds = Array.isArray(data?.changes)
    ? [...new Set(data.changes.map((change) => change && change.kind).filter((kind) => CHANGE_KINDS.includes(kind)))]
    : []
  return { version: String(data?.version ?? ''), kinds, notes }
}

/**
 * 校验一份发版说明，返回问题清单（空数组 = 通过）。
 *
 * `coords` 给了就核对 version；不给就只查结构。
 */
export function validatePluginReleaseNotes(data, coords = null) {
  const problems = []
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return ['发版说明不是一个 JSON 对象']
  }

  if (coords && String(data.version) !== String(coords.version)) {
    problems.push(`version 是 ${JSON.stringify(data.version)}，本次应发布 ${coords.version}`)
  }

  const from = data.from
  if (!from || typeof from !== 'object' || Array.isArray(from)) {
    problems.push('缺 from（上一版已发布的版本与提交）')
  } else {
    for (const key of ['version', 'ref']) {
      if (from[key] === undefined || from[key] === null || String(from[key]).trim() === '') {
        problems.push(`from.${key} 缺失`)
      }
    }
  }

  const notes = data.notes
  if (!notes || typeof notes !== 'object' || Array.isArray(notes)) {
    problems.push('缺 notes（十门语言说明）')
  } else {
    const missing = RELEASE_NOTE_LANGS.filter((lang) => typeof notes[lang] !== 'string' || notes[lang].trim() === '')
    if (missing.length > 0) problems.push(`notes 缺少或为空：${missing.join(', ')}`)
    for (const lang of RELEASE_NOTE_LANGS) {
      const text = notes[lang]
      if (typeof text === 'string' && text.length > MAX_NOTE_LENGTH) {
        problems.push(`notes.${lang} 长 ${text.length} 字符，超过 ${MAX_NOTE_LENGTH}`)
      }
    }
  }

  // 译文自检：机器翻译最容易出的错不是译得差，是「某一门根本没翻」——把中文原样复制过去。
  // 只抓能确定的形状，不评判译文好坏。
  if (notes && typeof notes === 'object' && !Array.isArray(notes)) {
    const CJK = /[\u4e00-\u9fff]/
    const KANA = /[\u3040-\u30ff]/
    const HANGUL = /[\uac00-\ud7af]/
    for (const lang of ['en', 'de', 'es', 'fr', 'pt', 'ru']) {
      const text = notes[lang]
      if (typeof text === 'string' && CJK.test(text)) problems.push(`notes.${lang} 里混进了中文（这一门八成没翻）`)
    }
    if (typeof notes.ja === 'string' && notes.ja.trim() && !KANA.test(notes.ja)) {
      problems.push('notes.ja 里没有假名（只有汉字，多半是中文原样照搬）')
    }
    if (typeof notes.ko === 'string' && notes.ko.trim() && !HANGUL.test(notes.ko)) {
      problems.push('notes.ko 里没有谚文（多半是中文原样照搬）')
    }
    if (typeof notes['zh-Hant'] === 'string' && typeof notes['zh-Hans'] === 'string'
      && notes['zh-Hant'].trim() && notes['zh-Hant'] === notes['zh-Hans']) {
      problems.push('notes.zh-Hant 与 notes.zh-Hans 一字不差（繁体那份没转）')
    }
  }

  if (data.changes !== undefined) {
    if (!Array.isArray(data.changes)) {
      problems.push('changes 必须是数组')
    } else {
      data.changes.forEach((change, index) => {
        if (!change || typeof change !== 'object' || Array.isArray(change)) {
          problems.push(`changes[${index}] 不是对象`)
          return
        }
        if (!CHANGE_KINDS.includes(change.kind)) {
          problems.push(`changes[${index}].kind 是 ${JSON.stringify(change.kind)}，只允许 ${CHANGE_KINDS.join(' / ')}`)
        }
        if (typeof change['zh-Hans'] !== 'string' || change['zh-Hans'].trim() === '') {
          problems.push(`changes[${index}] 缺 zh-Hans 说明`)
        }
      })
    }
  }

  return problems
}

/** 校验不过就抛错，错误里列出每一门缺什么。 */
export function assertValidPluginReleaseNotes(data, coords = null) {
  const problems = validatePluginReleaseNotes(data, coords)
  if (problems.length > 0) {
    throw new Error(`插件发版说明不合规：\n  ${problems.join('\n  ')}`)
  }
  return data
}

/** 读并解析一份说明文件；找不到 / 不是 JSON 都带上下文报错。 */
export function readNotesFile(file, root = ROOT) {
  const resolved = path.isAbsolute(file) ? file : path.resolve(root, file)
  let text
  try {
    text = fs.readFileSync(resolved, 'utf8')
  } catch {
    throw new Error(`读不到插件发版说明文件：${resolved}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`插件发版说明不是合法 JSON（${resolved}）：${error.message}`)
  }
}

// ── 从提交生成骨架 ───────────────────────────────────────────────────────

function parseCommit(subject) {
  const text = String(subject || '').trim()
  const match = /^([a-zA-Z]+)(?:\(([^)]*)\))?!?:\s*(.*)$/.exec(text)
  if (!match) return { type: 'other', scope: null, subject: text }
  return { type: match[1].toLowerCase(), scope: match[2] || null, subject: match[3].trim() }
}

/** Conventional Commits 类型 → `changes.kind`。`security` 由人显式改，不从提交猜。 */
function commitKind(type) {
  if (type === 'feat') return 'feature'
  if (type === 'fix' || type === 'perf') return 'fix'
  return 'other'
}

const KIND_ORDER = { feature: 0, fix: 1, security: 2, other: 3 }

/**
 * 按提交生成一份草稿（纯函数，好裸 Node 测）。
 * `notes` 里只有 `zh-Hans` 有内容，其余九门是空串 —— 逼着人补全，不拿中文冒充翻译。
 */
export function buildPluginDraft({ commits, from, version }) {
  const parsed = (commits || []).map((subject) => {
    const commit = parseCommit(subject)
    return { kind: commitKind(commit.type), subject: commit.subject || String(subject || '').trim() }
  })
  const ordered = parsed
    .map((item, index) => ({ ...item, index }))
    .sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || (a.index - b.index))

  const changes = ordered.map((item) => ({ kind: item.kind, 'zh-Hans': item.subject }))
  const visible = ordered.filter((item) => item.kind !== 'other')
  const bullets = (visible.length > 0 ? visible : ordered).map((item) => `- ${item.subject}`).join('\n')

  const notes = {}
  for (const lang of RELEASE_NOTE_LANGS) notes[lang] = ''
  notes['zh-Hans'] = bullets

  return { version, from, changes, notes }
}

/** 解析 CLI 参数：布尔开关 + 取值参数。 */
export function parseArgs(argv) {
  const BOOLEAN = new Set(['check', 'draft', 'stamp'])
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const name = arg.slice(2)
    const key = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    if (BOOLEAN.has(name)) out[key] = true
    else out[key] = argv[++i]
  }
  return out
}

function commitsSince(ref) {
  const out = execFileSync('git', ['log', '--no-merges', '--format=%s', `${ref}..HEAD`], { cwd: ROOT, encoding: 'utf8' })
  return out.split('\n').map((line) => line.trim()).filter(Boolean)
}

/**
 * 把本版说明写进插件 `package.json` 的 `dshMobileReleaseNotes`。
 *
 * 用 2 空格缩进、补末尾换行，与仓库里这份 package.json 的既有风格一致。返回写入的紧凑结构。
 */
export function stampIntoPackage(version, root = ROOT) {
  const data = readNotesFile(notesFilePath(version, root), root)
  const problems = validatePluginReleaseNotes(data, { version })
  if (problems.length > 0) {
    throw new Error(`不能盖章：发版说明不合规：\n  ${problems.join('\n  ')}`)
  }
  const compact = compactReleaseNotes(data)
  const pkgFile = path.join(root, 'dsh-mobile-plugin', 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  if (String(pkg.version) !== String(version)) {
    throw new Error(`package.json 版本是 ${pkg.version}，与要盖章的 ${version} 不一致；先抬版本号再盖章`)
  }
  pkg[STAMP_FIELD] = compact
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`)
  return compact
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.version) throw new Error('必须给 --version <x.y.z>')

  if (opts.check) {
    const file = notesFilePath(opts.version)
    const data = readNotesFile(file)
    const problems = validatePluginReleaseNotes(data, { version: opts.version })
    if (problems.length > 0) throw new Error(`发版说明不合规（${file}）：\n  ${problems.join('\n  ')}`)
    console.log(`✔ ${opts.version} 插件发版说明通过校验（十门齐全、版本一致）`)
    return
  }

  if (opts.draft) {
    const file = notesFilePath(opts.version)
    const existing = fs.existsSync(file) ? readNotesFile(file) : null
    const from = existing?.from || (opts.fromRef ? { version: opts.fromVersion || '', ref: opts.fromRef } : null)
    if (!from || !from.ref) {
      throw new Error('--draft 需要知道从哪一版开始：文件里先写好 from，或给 --from-ref <sha>（配套 --from-version）')
    }
    const draft = buildPluginDraft({ commits: commitsSince(from.ref), from, version: opts.version })
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(draft, null, 2)}\n`)
    console.log(`✔ 草稿写入 ${path.relative(ROOT, file)}`)
    console.log('  zh-Hans 已按提交铺好草稿；其余九门留空，需人工补全再 --check')
    return
  }

  if (opts.stamp) {
    const compact = stampIntoPackage(opts.version)
    console.log(`✔ 已把 ${opts.version} 的说明写进 package.json 的 ${STAMP_FIELD}（kinds: ${compact.kinds.join('/') || '无'}）`)
    return
  }

  throw new Error('用 --check 校验、--draft 生成骨架，或 --stamp 盖章进包清单')
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main()
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
