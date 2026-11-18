<h3 align="center">AI-HUB 移动端插件</h3>

![AI-HUB：手机和平板上的 DeepSeek Harness 会话界面](https://raw.githubusercontent.com/WNLUO/dsh-mobile-plugin/main/assets/banner.jpg)

<p align="center">
  <a href="https://app.wnluo.com/api/public/apps/14/download-latest"><img alt="安卓 分发下载" src="https://img.shields.io/badge/%E5%AE%89%E5%8D%93-%E5%88%86%E5%8F%91%E4%B8%8B%E8%BD%BD-3DDC84?style=for-the-badge&logo=android&logoColor=white"></a>
  <a href="https://github.com/WNLUO/dsh-mobile-plugin/releases/latest/download/ai-hub-android.apk"><img alt="安卓 GitHub 下载" src="https://img.shields.io/badge/%E5%AE%89%E5%8D%93-GitHub%E4%B8%8B%E8%BD%BD-181717?style=for-the-badge&logo=github"></a>
  <a href="https://apps.apple.com/us/app/ai-hub/id6821681438"><img alt="App Store" src="https://img.shields.io/badge/App_Store-%E4%B8%8B%E8%BD%BD-black?style=for-the-badge&logo=appstore&logoColor=white"></a>
  <a href="https://testflight.apple.com/join/4fn5PCMD"><img alt="苹果测试版 下载" src="https://img.shields.io/badge/%E8%8B%B9%E6%9E%9C%E6%B5%8B%E8%AF%95%E7%89%88-%E4%B8%8B%E8%BD%BD-0D96F6?style=for-the-badge&logo=apple&logoColor=white"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-mobile-plugin"><img alt="npm" src="https://img.shields.io/npm/v/dsh-mobile-plugin?style=flat-square"></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
  <img alt="platform" src="https://img.shields.io/badge/platform-iOS%20%7C%20Android-999999?style=flat-square">
  <a href="EN-README.md"><img alt="English" src="https://img.shields.io/badge/README-English-2f81f7?style=flat-square"></a>
</p>

<p align="center">电脑上开着的 DeepSeek Harness，手机上接着用。</p>

**AI-HUB 的手机端插件。** 装在电脑这边，手机 App 就通过一条中转隧道或局域网配对连进你的 DeepSeek Harness —— 看会话、接着聊、管理文件和工作区，进度实时同步。

它和绝大多数 DSH 插件不一样的一点：**不需要桌面外壳，也不需要 Electron**。同一份包可以单独跑在没有图形界面的服务器上，当作无头宿主用 —— 手机连的是一台根本没有屏幕的机器。

![手机 App 经中转或局域网连到你电脑上的 DeepSeek Harness](https://raw.githubusercontent.com/WNLUO/dsh-mobile-plugin/main/assets/connection-light.svg)

手机连的是**你自己那台电脑上的 DeepSeek Harness**，不是某个云端服务。电脑不用公网 IP，也不用在路由器上开端口：插件从内网主动往外建一条隧道，手机沿这条路回来。



## 功能

### 会话与工作区

- 新建、接着聊、改名、搜索会话，也能从任意一条分出分支单独往下走。
- 工作区建、改名、删除、置顶、归档都在手机上完成，排序会同步回电脑。
- 回复逐块流式到达，跑到一半就能看见；工具调用也是实时的。
- 手机上读过，电脑那边的未读绿点跟着消失；侧边栏的展开状态两边同步。

### 不用回电脑也能操作

- **审批与提问**：电脑上会弹的卡手机上同样有，权限请求、选择题、多选、自定义回答都能直接点。
- **排队插话**：正在跑的时候补一句，按队列排在当前这一步之后。
- **Git**：看状态和 diff、暂存、提交、推送、切分支，提交信息可以先让模型写。
- **文件**：浏览目录、读文件，也能把手机上的文件传回电脑，落在固定的收件目录。
- **插件**：手机上的插件市场里搜索、安装、更新、卸载；插件自己也能升级。
- **模型**：随时换模型，看有哪些渠道和可用模型，本机自建的渠道也能在手机上配。
- **日程与子代理**：定时任务能看、新建、改、暂停恢复、立刻跑一次、删掉；看正在跑的子代理，打断它或补一句话。

### 连接

- 两种连法：经 relay v2 隧道从公网连回来，或者同一个 Wi-Fi 下走局域网直连。
- 配对码与配对策略可选，设备凭据能单独吊销，也能一次全撤。
- iOS 离线推送可选，不配也不影响其它功能。

移动 API 只开手机需要的口子（`/api/mobile/v1/*`）—— 不暴露 shell、系统设置与任意文件写入。

## 远程电脑

不想带着主电脑走的时候，可以从另一台电脑上用完整的 DSH 网页操作它。在家里的 A 电脑生成一份一次性绑定，到随身的 B 电脑上一点，就能通过本机地址打开 A 的完整网页，不用域名，也不用手机参与。绑定十分钟内有效、只能用一次。

窗口优先由插件随包分发的桌面显示壳打开，Mac 上按官方桌面端的样式排版；每次访问一小时，可续期。细节和撤销方式见 [docs/remote-computer.md](docs/remote-computer.md)。

## 安装与更新

装好手机 App 只是第一步，插件装在这边才算接通。

在 DSH 的 **设置 → 插件** 里搜索并安装 `dsh-mobile-plugin`，然后打开 **设置 → 移动端 → 打开配置页面** 做配对。入口就在 DSH 的「设置 → 移动端」：配对二维码、当前监听地址和中转状态都在那一页，手机上的所有功能都从这页开始。插件市场负责检查和安装更新，通常更新后不用重启 DSH。

想在没有屏幕的服务器上跑，见 [无头部署与配置接口](docs/headless-deploy.md)，本机接口、移动 API 和会话清理的说明都在那里。

## 为什么做这个

DeepSeek Harness 跑在电脑上，但我不是一直坐在电脑前。出门、在别的房间、躺床上，想知道刚才那个任务跑到哪一步了，或者它正卡在一个要我点的审批上，只能走回去。

这个插件的出发点就这么窄：不是把整个 DSH 塞进手机屏幕，而是让人离开电脑之后，还能看见、还能接着聊、还能把该点的那一下点掉。

所以有两条线是硬的。一条是网络：不要求公网 IP、不要在路由器上开端口、不要为了用一次去配 DDNS，插件从内网主动往外出，手机顺着回来。另一条是能力：手机上只开需要的那几个口子，能看会话、能审批、能传文件、能改点配置，但不把 shell 和任意文件写入递到手机上 —— 手机丢了或者被人捡到，损失是可估的。

## 和别的方案比

**用手机浏览器开 DSH 的网页**：不用装东西，但每次都得记住地址，界面按桌面尺寸排，在手机上要靠缩放拖拽；没有推送，离开页面就什么都不知道；审批那种要点准的东西最难用。

**远程桌面**：本质还是操作那块屏幕，手机只是个显示器。网络断了就是黑屏，小屏上做任何事都要先放大。

**各家 AI 助手的手机 App**：那些跑在厂商的服务器上，会话、文件和额度都在别人那儿。这里连的是你自己电脑上那个 DSH，模型是你配的，文件在你硬盘上。



## 交流与反馈

![企业微信群二维码](https://raw.githubusercontent.com/WNLUO/dsh-mobile-plugin/main/assets/wechat-group.png)

扫上面的码进企业微信群。**如果扫不出来或者提示已过期**，发邮件到 <admin@wnluo.com> 索取新的，或者直接提 issue。

不方便的话发邮件到 <admin@wnluo.com> 或 <wnluo2@gmail.com>。用着顺手就给仓库点个 star，这是最实在的支持。

隐私政策见 [PRIVACY.md](PRIVACY.md)，常见问题见 [SUPPORT.md](SUPPORT.md)。

## 赞助与合作

公司或产品想支持这个项目的长期维护，见 [赞助与合作页](https://ai-hub.wnluo.com/sponsor)（也可直接发邮件到 <admin@wnluo.com> 说明合作意向）。赞助用于持续的维护与发版；它换来的是鸣谢与沟通渠道，不会解锁功能、不带来特权，也不表示与深度求索存在隶属或背书关系。个人想支持的话，仓库点个 star 或 App 设置页里的「赞助」入口都可以。

## 开发

```sh
pnpm install --frozen-lockfile
npm test
```

改过 `React/` 面板源码，先在该目录跑 `pnpm run build`，并把生成的 `lib/panel/index.html` 和源码一起提交。

网页插件需要在手机聊天页保留网页顶部栏时，见[聊天嵌入页顶部栏接入](docs/chat-embed.md)。

## License

MIT，见 [LICENSE](LICENSE)。
