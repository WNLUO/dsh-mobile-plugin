/**
 * 远程桌面壳会话里的官方快捷键运行时桥接脚本。
 *
 * 桌面壳打开的是 A 电脑上的完整 DSH 网页。官方 @deepseek-ai/dsh-client-shortcuts
 * 靠根元素的 data-platform 判断运行时：有值走 desktop、没值走 web。想在壳里用上官方
 * desktop 快捷键，就得让根元素的 dataset.platform 有值；但这个值绝不能变成真实的
 * HTML 属性，否则会命中官方桌面 CSS、让壳排版错乱，所以只在 dataset 对象上挂一个
 * 自有属性，JS 读到精确平台值（决定键位和键帽），CSS 的 [data-platform] 一概不命中。
 * desktop 运行时还要求 window.dshDesktop 提供 keyboard 和 shortcuts 两个桥，缺一个
 * 就抛 "Desktop keyboard bridge unavailable"、让整页插件加载失败，因此这里把浏览器
 * 键盘事件转成官方 DesktopShortcutInput，并用 localStorage 持久化一份合法快捷键文档。
 * 只在 Mac/Windows 壳接管：Linux 桌面运行时仍由 DOM 处理可配置键，装原生桥会双投递。
 *
 * 日期：2026-11-26
 */
'use strict';

/**
 * 浏览器端自执行函数，完全自包含，不引用任何 Node 作用域变量，可在 vm.runInContext 上执行。
 * @param {string} nodePlatform Node 的 process.platform（darwin/win32/linux）。
 */
function install(nodePlatform) {
  'use strict';

  // 官方 detectEnvironment 读根元素 dataset.platform 决定运行时和平台。挂一个自有属性
  // 让 JS 读到精确平台值（决定 default profile 和键帽），但不写真实属性，避免命中
  // 官方桌面 CSS。重复执行时属性已在，整体跳过，保持幂等。
  // Linux 桌面运行时仍由 DOM 处理可配置快捷键，再装原生桥会双投递，故只接管 Mac/Windows。
  const root = document.documentElement;
  if (Object.prototype.hasOwnProperty.call(root.dataset, 'platform')) return;
  const platform = nodePlatform === 'darwin' ? 'darwin'
    : nodePlatform === 'win32' ? 'win32' : '';
  if (!platform) return;
  try {
    Object.defineProperty(root.dataset, 'platform', { value: platform, configurable: true });
  } catch { return; } // 浏览器不让挂就整段跳过：退回网页版快捷键，绝不半安装触发原生桥缺失。
  if (root.dataset.platform !== platform) return;

  // 官方 shortcut document 的 profile 键是 desktop:<平台标识>。
  const official = platform === 'darwin' ? 'macos' : 'windows';
  const profileKey = 'desktop:' + official;
  const storageKey = 'dshm:remote:shortcuts';

  let sequence = 1;
  let revision = 'remote-1';
  let profile = {};

  function buildDocument() {
    const doc = { schemaVersion: 1, profiles: {} };
    doc.profiles[profileKey] = profile;
    return doc;
  }

  // 某些 webview 会禁用 localStorage，读写都要兜住，坏数据就当无覆盖。
  function read() {
    try {
      const raw = window.localStorage.getItem(storageKey);
      const saved = raw ? JSON.parse(raw) : null;
      const value = saved && saved.profiles && saved.profiles[profileKey];
      if (value && typeof value === 'object' && !Array.isArray(value)) profile = value;
    } catch { /* 禁用或坏数据：从空覆盖开始。 */ }
  }

  function write() {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(buildDocument()));
    } catch { /* 写不进去也不影响本次会话。 */ }
  }

  read();

  const shortcutListeners = new Set();
  const keyboardListeners = new Set();

  function snapshot() {
    return {
      revision,
      sequence,
      document: buildDocument(),
      status: 'ready',
      error: null,
      usingDefaults: Object.keys(profile).length === 0,
    };
  }

  // 官方 ShortcutsService.syncDefinitions() 会 .then() 这个返回值，必须是 Promise。
  const shortcuts = {
    get() {
      return Promise.resolve(snapshot());
    },
    edit(edit) {
      if (edit && typeof edit === 'object') {
        if (edit.type === 'set' && edit.id != null) profile[edit.id] = edit.binding;
        else if (edit.type === 'reset' && edit.id != null) delete profile[edit.id];
        else if (edit.type === 'reset-all') profile = {};
      }
      write();
      sequence += 1;
      revision = 'remote-' + sequence;
      const next = snapshot();
      for (const listener of shortcutListeners) listener(next);
      return Promise.resolve({ status: 'saved', snapshot: next });
    },
    subscribe(listener) {
      shortcutListeners.add(listener);
      return () => shortcutListeners.delete(listener);
    },
    recording() {
      return Promise.resolve();
    },
  };

  // 官方 installNativeKeyboard 会拿 input.revision 与 get() 的 revision 比对，
  // 所以派发时读最新值，edit 之后自然跟上。只监听 keydown：官方原生键盘桥只在
  // 按下时投递一次，keyup 再投一次会让每个快捷键执行两遍。
  function dispatch(event) {
    const input = {
      revision,
      kind: 'keyboard',
      frameName: '',
      code: event.code,
      control: !!event.ctrlKey,
      alt: !!event.altKey,
      shift: !!event.shiftKey,
      meta: !!event.metaKey,
      repeat: !!event.repeat,
    };
    for (const listener of keyboardListeners) listener(input);
  }

  // 不 preventDefault / stopPropagation：键盘事件还要照常到达输入框。
  window.addEventListener('keydown', dispatch);

  const keyboard = {
    subscribe(listener) {
      keyboardListeners.add(listener);
      return () => keyboardListeners.delete(listener);
    },
    closeWindow() {
      return Promise.resolve();
    },
  };

  // fileActions / deviceInfo 只在被读取时提供，且都不能是「有对象但缺方法」：
  // 官方 BrowserFileActions 用 desktop!==undefined 判断能否 save，缺方法会在点保存时抛错。
  window.dshDesktop = {
    keyboard,
    shortcuts,
    deviceInfo: () => Promise.resolve('DSH remote desktop'),
  };
}

/** 生成可注入主文档的自执行脚本字符串。 */
function shortcutBridgeScript(platform) {
  return `(${install.toString()})(${JSON.stringify(platform)});`;
}

module.exports = { shortcutBridgeScript };
