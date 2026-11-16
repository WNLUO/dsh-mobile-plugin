'use strict';

/**
 * 聊天嵌入页：把宿主注入好的官方网页版整页取回来，加工成 App WebView 能直接用的形态。
 *
 * 不拼官方前端路径、不自己调 renderIndex：宿主已经把注入完成的整页挂在自己的 web 端口上，
 * 插件只拿端口与一次性启动令牌走一遍那道登录，把结果原样取回。页面长什么样、以后怎么变，
 * 都由宿主自己负责 —— 插件只改三件与自身形态有关的事：把 base 指到根、藏掉官方外壳、
 * 按 sessionId 把会话切过去。
 *
 * 这一页以 `source={{html, baseUrl}}` 的方式进 App 的 WebView，baseUrl 是预览管道映射出来的
 * 手机环回地址。把 `<base href="./">` 改成 `<base href="/">` 才让官方那堆 `./assets/...`
 * 与 `plugins/...` 落到该地址的根，再由字节管道原样转发给宿主的 web 端口；不改就会按文档
 * 所在路径解析，整页资源全 404。
 */

const { sendJson } = require('../shared/http-util');

/** 页面加工脚本派回 App 的消息标记，App 据此分辨这是定位回报而不是业务消息。 */
const TAG = 'dsh-chat-embed';

/**
 * 注入脚本：藏外壳 + 定位会话 + 回报。
 *
 * 官方前端没有按会话跳转的 hash 路由（构建产物里只有 `#dsh-mobile-plugins` 这类面板入口），
 * 所以走现成的 DOM 入口：会话行的 `data-row-key="session:<id>"` 是 stable 钩子（见
 * dsh-client-ui-workspace 的 rows/Rows.tsx），点它等于桌面端用户点开那条会话。手机窄屏下侧栏
 * 默认收成抽屉，先点 `[data-sidebar-toggle]` 展开再找那一行；找不到就把顶层结构与定位结果
 * 原样报回去，让真机上能据此收紧选择器，而不是猜一个宽泛选择器把正文一起藏掉。
 *
 * 藏外壳只认两处确切 DOM：会话顶栏 `header[data-window-drag]`，与侧栏列（从展开按钮上溯到
 * frame 的直接子元素）。同时把 frame 的侧栏轨道清零，否则列虽然 display:none，网格仍留一条
 * 空轨，正文会被顶到屏幕右边。
 *
 * sessionId 先剔掉会闭合脚本的符号再塞进字面量：注入脚本里不能出现 `</script`。
 */
function embedScript(sessionId) {
  const safe = String(sessionId || '').replace(/[<>&"']/g, '');
  return [
    '<script>(function(){',
    'var d=document,sid=' + JSON.stringify(safe) + ',n=0,MAX=60;',
    'function post(o){if(window.ReactNativeWebView&&window.ReactNativeWebView.postMessage){try{window.ReactNativeWebView.postMessage(JSON.stringify(o));}catch(e){}}}',
    'function top(){var r=d.getElementById("root"),a=[];if(r){for(var i=0;i<r.children.length&&i<12;i++){var e=r.children[i];a.push({tag:e.tagName,id:e.id||"",cls:String(e.className||"").slice(0,80)});}}return a;}',
    'function report(ok){post({kind:' + JSON.stringify(TAG) + ',sessionId:sid,located:!!ok,top:top()});}',
    'function frame(){var r=d.getElementById("root");if(!r)return null;var f=r.querySelector("[style*=\\"grid-template-columns\\"]");return f||r.firstElementChild;}',
    'function hide(){var f=frame(),i,hs=d.querySelectorAll("header[data-window-drag],[data-shell-leading],[data-sidebar-mask]");for(i=0;i<hs.length;i++)hs[i].style.setProperty("display","none","important");var t=d.querySelector("[data-sidebar-toggle]"),col=t;while(col&&f&&col.parentElement!==f)col=col.parentElement;if(col&&col!==f)col.style.setProperty("display","none","important");if(f&&f.style&&typeof f.style.gridTemplateColumns==="string")f.style.gridTemplateColumns=f.style.gridTemplateColumns.replace(/^\\s*\\S+/,"0px");}',
    'function tick(){n++;if(!sid){hide();report(false);return;}var q=String.fromCharCode(34),sel="[data-row-key="+q+"session:"+sid+q+"]",row=d.querySelector(sel);',
    'if(row){try{row.click();}catch(e){}var c=d.querySelector("[data-sidebar-toggle]");if(c)try{c.click();}catch(e){}hide();report(true);return;}',
    'var t=d.querySelector("[data-sidebar-toggle]");if(t&&n===1)try{t.click();}catch(e){}',
    'if(n<MAX)setTimeout(tick,150);else{hide();report(false);}}',
    'function start(){if(d.readyState==="loading")d.addEventListener("DOMContentLoaded",function(){setTimeout(tick,240);});else setTimeout(tick,240);}',
    'start();})();</script>',
  ].join('\n');
}

/**
 * 把官方那页改造成嵌入页。返回 null 表示这页不是宿主注入过的形态，不该往外吐。
 */
function decorate(html, sessionId) {
  if (typeof html !== 'string' || html.indexOf('__DSH_BOOT_READY__') < 0) return null;
  let out = html;
  if (/<base href="\.\/">/i.test(out)) out = out.replace(/<base href="\.\/">/i, '<base href="/">');
  else if (!/<base href="\/"/i.test(out)) out = out.replace(/(<head(?:\s[^>]*)?>)/i, '$1<base href="/">');
  const tail = embedScript(sessionId);
  const close = /<\/body\s*>/i;
  out = close.test(out) ? out.replace(close, tail + '</body>') : out + tail;
  return out;
}

/** 用启动令牌走一遍官方那道登录，把宿主注入好的整页取回来并加工。 */
async function fetchBootstrappedIndex(ctx, sessionId) {
  const port = ctx && ctx.webServer ? ctx.webServer.port : null;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { error: 'no-web-port' };
  const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : null;
  const token = connection && connection.browserAuth ? connection.browserAuth.launchToken : null;
  if (typeof token !== 'string' || token === '') return { error: 'no-launch-token' };

  const origin = `http://127.0.0.1:${port}`;
  const timeout = AbortSignal.timeout(5000);
  const login = await fetch(`${origin}/?token=${encodeURIComponent(token)}`, { redirect: 'manual', signal: timeout });
  const setCookie = login.headers.get('set-cookie');
  const cookie = typeof setCookie === 'string' && setCookie ? setCookie.split(';', 1)[0] : '';
  const page = await fetch(`${origin}/`, {
    headers: cookie ? { cookie } : {},
    redirect: 'manual',
    signal: timeout,
  });
  if (!page.ok) return { error: `index-http-${page.status}` };
  const decorated = decorate(await page.text(), sessionId);
  if (!decorated) return { error: 'index-not-bootstrapped' };
  return { html: decorated };
}

/** `GET /api/mobile/v1/host-web/chat-page`（移动端守卫之后的 handler）。 */
async function handleChatPage(ctx, req, res) {
  let sessionId = '';
  try {
    const url = new URL(String(req?.url || ''), 'http://localhost');
    sessionId = String(url.searchParams.get('sessionId') || '');
  } catch { /* query 残缺就当没带 sessionId，页面照常出，只是不定位 */ }
  let got;
  try {
    got = await fetchBootstrappedIndex(ctx, sessionId);
  } catch (error) {
    got = { error: String(error?.message || error) };
  }
  // 失败一律 200 + ok:false：这条是能力探测，抛上去只会变成 500，App 反而看不出哪一格缺了。
  if (got.error) return sendJson(res, 200, { ok: false, reason: got.error });
  return sendJson(res, 200, { ok: true, html: got.html });
}

module.exports = { handleChatPage, decorate, embedScript, fetchBootstrappedIndex, TAG };
