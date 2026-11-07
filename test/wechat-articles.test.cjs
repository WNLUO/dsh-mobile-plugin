'use strict';

/**
 * 公众号文章库（`/wechat/articles`、`/wechat/article`、`/wechat/media`、`/wechat/article/save`、
 * `/wechat/article/delete`，以及给 AI 的那两个工具）。
 *
 * 每条断言对着一个真会出事的写法：
 *
 *  1. **只有标题也要能落进列表**：用户的工作方式就是先定题目、再写正文；要求「正文一起给」
 *     的话，分阶段这件事直接不成立。
 *  2. **id 是目录名，形状要卡死**：`../` 这种形状必须进不来，也不能读到目录外面去。
 *  3. **更新是「给什么改什么」**：只改标题不该把正文清空，只补正文不该把标题改回默认。
 *  4. **图片按名字取、取不到的图不能把整页带崩**：正文里引用了没传的图，正文照常回，
 *     图那一发 404。
 *  5. **坏档案按「这篇不在」处理**，不能让一份坏 JSON 把整个列表打不开。
 *  6. **工具那一侧与 HTTP 那一侧写的是同一个库**：模型写完，手机列表里立刻看得到。
 *  7. **HTTP 入口不收 path、只收 {name, base64}**：手机给的本机路径读的是宿主机器上同名的
 *     任意文件，所以 HTTP 这条要把 path 剥掉；工具那一侧（模型自己有读盘权）的 path 保留。
 *
 * 驱动真实 handler（起真 http 服务、走真 req/res），只有库根是临时目录。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  handleArticleList,
  handleArticleRead,
  handleArticleMedia,
  handleArticleWrite,
  handleArticleDelete,
  writeArticle,
  readArticle,
  rootDir,
  httpImagesOnly,
} = require('../lib/mobile/wechat.js');

/** 一张最小的 PNG（1×1，透明）：媒体那条按魔术字节认类型，不认扩展名。 */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function serve(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wechat-'));
  process.env.DSH_MOBILE_WECHAT = root;
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.DSH_MOBILE_WECHAT;
  });
  const server = http.createServer((req, res) => {
    const route = String(req.url || '').split('?')[0];
    const handler = {
      '/wechat/articles': handleArticleList,
      '/wechat/article': handleArticleRead,
      '/wechat/media': handleArticleMedia,
      '/wechat/article/save': handleArticleWrite,
      '/wechat/article/delete': handleArticleDelete,
    }[route];
    if (!handler) {
      res.writeHead(404).end('{}');
      return;
    }
    void handler({}, req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    root,
    base,
    get: async (route) => {
      const response = await fetch(base + route);
      return { status: response.status, body: await response.json() };
    },
    post: async (route, body) => {
      const response = await fetch(base + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    // fetch 会把连接留着复用，不掐掉的话 server.close 永远等不完（测试挂住不退出）。
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

test('只有标题也能写进去：列表里立刻有它，正文为空不算坏数据', async (t) => {
  const api = await serve(t);
  const saved = await api.post('/wechat/article/save', { title: '先定个题目' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const id = saved.body.id;
  assert.match(id, /^wx[0-9a-f]{8}$/);

  const list = await api.get('/wechat/articles');
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].title, '先定个题目');
  assert.equal(list.body.items[0].hasBody, false);
  assert.equal(list.body.totals.count, 1);
  assert.equal(list.body.totals.withBody, 0);
  await api.close();
});

test('更新是「给什么改什么」：补正文不动标题，改标题不动正文', async (t) => {
  const api = await serve(t);
  const saved = await api.post('/wechat/article/save', { title: '第一版', html: '<p>正文一</p>' });
  const id = saved.body.id;

  const retitled = await api.post('/wechat/article/save', { id, title: '改过的标题' });
  assert.equal(retitled.status, 200, JSON.stringify(retitled.body));
  const afterTitle = await api.get(`/wechat/article?id=${id}`);
  assert.equal(afterTitle.body.article.title, '改过的标题');
  assert.equal(afterTitle.body.article.html, '<p>正文一</p>');

  await api.post('/wechat/article/save', { id, html: '<p>正文二</p>' });
  const afterBody = await api.get(`/wechat/article?id=${id}`);
  assert.equal(afterBody.body.article.title, '改过的标题');
  assert.equal(afterBody.body.article.html, '<p>正文二</p>');
  await api.close();
});

test('id 是目录名：形状不对的一律不认，读不到目录外面去', async (t) => {
  const api = await serve(t);
  for (const id of ['../etc', 'wxzzzzzzzz', '', 'wx1234567']) {
    const read = await api.get(`/wechat/article?id=${encodeURIComponent(id)}`);
    assert.equal(read.status, 404, `${id} 应读不到`);
    const media = await api.get(`/wechat/media?id=${encodeURIComponent(id)}&name=a.png`);
    assert.equal(media.status, 400, `${id} 的图片请求应被拒`);
  }
  await api.close();
});

test('正文里引用了没传的图：正文照常回，图那一发 404', async (t) => {
  const api = await serve(t);
  const saved = await api.post('/wechat/article/save', {
    title: '带图',
    html: '<p><img src="media/cover.png"></p>',
  });
  const id = saved.body.id;

  const read = await api.get(`/wechat/article?id=${id}`);
  assert.equal(read.status, 200);
  // 正文原样回去：图片地址的改写与取字节是 App 那边的事，宿主不改写模型写的东西。
  assert.match(read.body.article.html, /media\/cover\.png/);

  const missing = await api.get(`/wechat/media?id=${id}&name=cover.png`);
  assert.equal(missing.status, 404);
  await api.close();
});

test('图片按名字落进 media/、按魔术字节回类型，名字不合规矩的直接拒', async (t) => {
  const api = await serve(t);
  const saved = await api.post('/wechat/article/save', {
    title: '有图',
    html: '<p><img src="media/cover.png"></p>',
    images: [{ name: 'cover.png', base64: PNG_BASE64 }],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const id = saved.body.id;

  const media = await api.get(`/wechat/media?id=${id}&name=cover.png`);
  assert.equal(media.status, 200);
  assert.equal(media.body.mediaType, 'image/png');
  assert.equal(media.body.data, PNG_BASE64);

  const bad = await api.get(`/wechat/media?id=${id}&name=${encodeURIComponent('../article.json')}`);
  assert.equal(bad.status, 400);
  await api.close();
});

test('坏档案按「这篇不在」处理：一份坏 JSON 不让整个列表打不开', async (t) => {
  const api = await serve(t);
  const saved = await api.post('/wechat/article/save', { title: '正常的' });
  const broken = 'wxdeadbeef';
  fs.mkdirSync(path.join(rootDir(), broken), { recursive: true });
  fs.writeFileSync(path.join(rootDir(), broken, 'article.json'), '{ 不是 JSON');

  const list = await api.get('/wechat/articles');
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].id, saved.body.id);

  const read = await api.get(`/wechat/article?id=${broken}`);
  assert.equal(read.status, 404);
  await api.close();
});

test('工具那一侧可以直接给电脑上的路径：宿主自己读过来复制进 media，不用模型抄字节', async (t) => {
  const api = await serve(t);
  const png = Buffer.from(PNG_BASE64, 'base64');
  const filePath = path.join(os.tmpdir(), `dsh-wechat-src-${Date.now()}.png`);
  fs.writeFileSync(filePath, png);
  t.after(() => fs.rmSync(filePath, { force: true }));

  // 直接调 writeArticle（工具那条 AI 路径背后就是它）：path 仍然生效，证明工具侧没被砍。
  const { article, images, rejected } = await writeArticle({
    title: '路径给图',
    html: '<p><img src="media/cover.png"></p>',
    images: [{ name: 'cover.png', path: filePath }],
  });
  assert.deepEqual(images, ['cover.png']);
  assert.deepEqual(rejected, []);

  const media = await api.get(`/wechat/media?id=${article.id}&name=cover.png`);
  assert.equal(media.status, 200);
  assert.equal(media.body.data, PNG_BASE64);
  await api.close();
});

test('工具那一侧给的路径指向的不是图片 / 读不到：那张图不收，正文照常写进去', async (t) => {
  const api = await serve(t);
  const txt = path.join(os.tmpdir(), `dsh-wechat-src-${Date.now()}.txt`);
  fs.writeFileSync(txt, '这不是图片');
  t.after(() => fs.rmSync(txt, { force: true }));

  const { article, images, rejected } = await writeArticle({
    title: '坏图',
    html: '<p>正文</p>',
    images: [
      { name: 'a.png', path: txt },
      { name: 'b.png', path: path.join(os.tmpdir(), 'dsh-wechat-nope-does-not-exist.png') },
    ],
  });
  assert.deepEqual(images, []);
  assert.equal(rejected.length, 2);
  const missing = await api.get(`/wechat/media?id=${article.id}&name=a.png`);
  assert.equal(missing.status, 404);
  const read = await readArticle(article.id);
  assert.equal(read.html, '<p>正文</p>');
  await api.close();
});

test('httpImagesOnly 只留 {name, base64}：路径字段全剥，非数组 / 非对象都不抛', () => {
  assert.deepEqual(
    httpImagesOnly([{ name: 'a.png', path: '/etc/passwd' }]),
    [{ name: 'a.png', base64: undefined }],
  );
  assert.deepEqual(
    httpImagesOnly([{ name: 'b.png', base64: 'xx', filePath: '/x', localPath: '/y', src: '/z' }]),
    [{ name: 'b.png', base64: 'xx' }],
  );
  assert.deepEqual(httpImagesOnly(null), []);
  assert.deepEqual(httpImagesOnly({ name: 'a.png', base64: 'x' }), []);
  assert.deepEqual(httpImagesOnly('nope'), []);
  assert.deepEqual(
    httpImagesOnly([null, 'x', 42, { name: 'c.png', base64: 'y' }]),
    [{ name: 'c.png', base64: 'y' }],
  );
});

test('HTTP 保存不收 path：带 {path} 的图一律当没给，不落盘', async (t) => {
  const api = await serve(t);
  const png = Buffer.from(PNG_BASE64, 'base64');
  const filePath = path.join(os.tmpdir(), `dsh-wechat-src-${Date.now()}.png`);
  fs.writeFileSync(filePath, png);
  t.after(() => fs.rmSync(filePath, { force: true }));

  const saved = await api.post('/wechat/article/save', {
    title: '路径给图但走 HTTP',
    html: '<p><img src="media/cover.png"></p>',
    images: [{ name: 'cover.png', path: filePath }],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  // 哪怕这个路径在宿主上真实存在且是张合法 PNG，HTTP 这条路也不该去读它。
  const media = await api.get(`/wechat/media?id=${saved.body.id}&name=cover.png`);
  assert.equal(media.status, 404);
  await api.close();
});

test('HTTP 保存：带 base64 的照常落盘，带 path 的那张被当没给', async (t) => {
  const api = await serve(t);
  const pngFile = path.join(os.tmpdir(), `dsh-wechat-src-${Date.now()}.png`);
  fs.writeFileSync(pngFile, Buffer.from(PNG_BASE64, 'base64'));
  t.after(() => fs.rmSync(pngFile, { force: true }));

  const saved = await api.post('/wechat/article/save', {
    title: '一张能用一张不行',
    html: '<p>正文</p>',
    images: [
      { name: 'ok.png', base64: PNG_BASE64 },
      { name: 'viapath.png', path: pngFile },
    ],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  const ok = await api.get(`/wechat/media?id=${saved.body.id}&name=ok.png`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data, PNG_BASE64);
  const viaPath = await api.get(`/wechat/media?id=${saved.body.id}&name=viapath.png`);
  assert.equal(viaPath.status, 404);
  await api.close();
});

test('删除只认 DELETE：GET 那条路上删不掉文章（预取 / 链接预览都会发 GET）', async (t) => {
  const api = await serve(t);
  const saved = await api.post('/wechat/article/save', { title: '别被 GET 删掉' });
  const id = saved.body.id;

  const viaGet = await api.get(`/wechat/article/delete?id=${id}`);
  assert.equal(viaGet.status, 405);

  const read = await api.get(`/wechat/article?id=${id}`);
  assert.equal(read.status, 200, '一次 GET 之后这篇还必须活着');
  await api.close();
});

test('删掉之后再读是 404，列表里也没有了', async (t) => {
  const api = await serve(t);
  const saved = await api.post('/wechat/article/save', { title: '待删' });
  const id = saved.body.id;
  const del = await fetch(`${api.base}/wechat/article/delete?id=${id}`, { method: 'DELETE' })
    .then((r) => r.json());
  assert.equal(del.ok, true);
  const read = await api.get(`/wechat/article?id=${id}`);
  assert.equal(read.status, 404);
  const list = await api.get('/wechat/articles');
  assert.equal(list.body.items.length, 0);
  await api.close();
});

test('工具那一侧与 HTTP 那一侧写的是同一个库', async (t) => {
  const api = await serve(t);
  // 直接调工具背后的那个函数（工具的壳只负责说人话）。
  const { article } = await writeArticle({
    title: 'AI 写的',
    html: '<h1>AI 写的</h1><p>正文</p>',
    images: [{ name: 'a.png', base64: PNG_BASE64 }],
  });
  const read = await readArticle(article.id);
  assert.ok(read);
  assert.equal(read.title, 'AI 写的');
  assert.equal(read.hasBody, true);

  const list = await api.get('/wechat/articles');
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].id, article.id);
  assert.equal(list.body.totals.withBody, 1);

  const media = await api.get(`/wechat/media?id=${article.id}&name=a.png`);
  assert.equal(media.status, 200);
  await api.close();
});

test('摘要与字数剥掉样式块：成品 HTML 带 <style> 是常事，别把 CSS 当正文', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wechat-'));
  process.env.DSH_MOBILE_WECHAT = root;
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.DSH_MOBILE_WECHAT;
  });
  const { article } = await writeArticle({
    title: '带样式',
    html: '<style>.x{color:red}</style><p>真正的正文</p>',
  });
  const read = await readArticle(article.id);
  assert.equal(read.excerpt, '真正的正文');
  assert.equal(read.chars, 5);
});
