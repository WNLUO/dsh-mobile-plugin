# 聊天嵌入页：保留网页顶部栏

DSH 网页插件把按钮放在网页顶部时，可以向 `dsh-mobile-plugin` 的客户端服务声明：在手机 App 的聊天网页中保留顶部栏。声明只在插件需要时生效，插件卸载或设置关闭后撤销。

它作用于 App 为聊天网页隐藏的网页页头和顶部前导区。侧栏、侧栏占位与 App 原生顶栏照旧；用户自己隐藏的区域仍然隐藏。这里的“保留”只撤去 App 自己的顶部隐藏规则，不会强制覆盖用户样式。

## 服务契约

移动端插件的客户端部分加载后，始终提供 Cordis 服务 `mobileChatEmbed`。它不依赖会话、工作区或设备列表服务就绪。

```ts
interface MobileChatEmbed {
  isEmbedded(): boolean;
  keepTopBar(): () => void;
}
```

- `isEmbedded()`：当前文档有受支持的 App 聊天桥时返回 `true`。普通电脑网页、没有桥的新旧 App 页面都返回 `false`，不会改变页面。
- `keepTopBar()`：新建一份保留声明，返回撤销函数。每次调用独立登记，重复调用同一撤销函数不会重复释放。
- 至少有一份有效声明时，App 撤去自己的顶部隐藏规则；最后一份撤销后恢复 App 默认隐藏。一个插件不能撤销另一个插件的声明。

没有安装或启用移动端插件时，这个服务不存在。通过 `ctx.inject(['mobileChatEmbed'], ...)` 等待它，只让这项增强依赖它；不要把 `mobileChatEmbed` 放进整个插件导出的必选 `inject`，否则插件的其他功能也会等待移动端插件。

## 最小 Client 示例

这是可放进 Client 入口的完整模块。把 `id` 改成自己的包名；已有 Client 模块时，把 `apply` 中的注入块合进去即可。工厂只返回插件定义，声明在 `apply` 中创建。

```js
window.__ModuleLoader__.load({
  id: '@example/chat-toolbar',
  factory() {
    return {
      apply(ctx) {
        ctx.inject(['mobileChatEmbed'], (scope) => {
          scope.effect(() => {
            if (!scope.mobileChatEmbed.isEmbedded()) return;
            return scope.mobileChatEmbed.keepTopBar();
          }, 'chat-toolbar: keep embedded top bar');
        });
      },
    };
  },
});
```

`scope.effect` 持有返回的撤销函数。消费插件卸载、移动端服务撤下或这段注入作用域结束时，Cordis 会清理它；服务重新可用时再建立声明。移动端服务提供方卸载时也会释放自身登记、撤回对 App 的控制。

不要把声明放在组件每次渲染里，也不要在工厂顶层调用。声明应跟随需要顶部栏的插件功能或作用域，而不是跟随当前会话。

## 带运行时设置的完整示例

设置关闭时不登记；设置变化时先撤销旧声明，再按当前设置重新登记。不能只在 `apply` 开始时读一次开关。

下面使用 DSH `0.2.2-rc.3` 的真实设置 API：`configForms.get(entryId)`、`getSnapshot()` 和 `subscribe()`。示例假设自己的 Host 插件已经向设置服务公开 `chat-toolbar` 命名空间，其中有布尔字段 `keepWebTopBar`。把模块 `id`、`ENTRY_ID` 和字段名换成自己的；`ENTRY_ID` 是 Host 插件条目的设置命名空间，不一定等于 npm 包名。

```js
window.__ModuleLoader__.load({
  id: '@example/chat-toolbar',
  factory() {
    const ENTRY_ID = 'chat-toolbar';

    return {
      apply(ctx) {
        ctx.inject(['mobileChatEmbed', 'configForms'], (scope) => {
          scope.effect(() => {
            const embed = scope.mobileChatEmbed;
            if (!embed.isEmbedded()) return;

            const form = scope.configForms.get(ENTRY_ID);
            let release = () => {};

            const sync = () => {
              release();
              release = () => {};

              const snapshot = form.getSnapshot();
              if (snapshot.status !== 'ready') return;
              if (snapshot.value?.keepWebTopBar !== true) return;
              release = embed.keepTopBar();
            };

            const unsubscribe = form.subscribe(sync);
            sync();

            return () => {
              unsubscribe();
              release();
            };
          }, 'chat-toolbar: follow embedded top bar preference');
        });
      },
    };
  },
});
```

设置尚未就绪、不可用或开关为 `false` 时，示例不持有声明。设置页继续通过这个共享表单的 `set('keepWebTopBar', value)` 保存选择；表单接受新值后，订阅回调会更新声明。已有自己的设置订阅时，保留相同的“先撤销，再按真值登记”流程即可。

表单由 `configForms` 服务所有，消费方只清理自己的订阅和声明。这里把两者都放在注入作用域的 `scope.effect` 中，清理时先退订，再撤销当前声明。两个服务中的任意一个卸载，或消费插件卸载，都会结束该作用域；缺少它们只暂停这项顶部栏增强。

## 加载与页面生命周期

- 插件和移动端服务可以先后加载。`ctx.inject` 会在服务可用时建立作用域，不需要广播、轮询或自己猜加载顺序。
- 声明可以在页面启动后任意时刻到达，没有九秒截止时间。晚到时可能先看到顶部隐藏，声明生效后再恢复；顶部元素稍后才挂载也会遵循当前声明。
- 在同一个网页文档里切换会话，声明继续有效，不需要每次切会话重复申请。
- 网页重载、重试或其他操作建立新文档后，原声明结束，由消费插件再次执行 `apply` 重建。不要跨文档缓存服务或撤销函数。
- 所有声明撤销后恢复的是 App 的默认顶部隐藏规则。用户样式、其他插件自己控制的显示状态，以及侧栏和原生顶栏的既有行为继续保留。

## App 桥约定

App 在 document-start 阶段向聊天网页提供 `globalThis.__DSH_MOBILE_CHAT_EMBED__`，形状为：

```ts
interface MobileChatEmbedBridge {
  version: 1;
  surface: 'chat';
  setTopBarVisible(visible: boolean): void;
}
```

`mobileChatEmbed.isEmbedded()` 检查桥的版本、聊天 surface 和可调用的方法。普通网页及没有这份桥的新旧 App 页面会得到 `false`；`keepTopBar()` 在这些页面也没有显示副作用。

网页插件通过 Cordis 服务声明需求，由移动端插件合并多份声明后调用桥。直接调用 `setTopBarVisible(false)` 会绕开合并，覆盖其他插件仍在持有的保留需求，因此消费方应只使用服务和它返回的撤销函数。
