'use strict';

/**
 * 悬浮宠物的包目录（`/pet/packs`、`/pet/pack/file`、`/pet/pack/delete`，以及给 AI 的那两个工具）。
 *
 * 每条断言对着一个真会出事的写法：
 *
 *  1. **内置目录不存在不是错**：素材还没放进来的构建里，用户自己的包照常列 —— 少了内置那份
 *     只是「列表短一点」，不能整张列表打不开。
 *  2. **id 是目录名，形状要卡死**：`../` 这种形状进不来，取文件也读不到包外面去。
 *  3. **用户目录同 id 覆盖内置**：`builtin` 变 false、删得掉；删内置回 forbidden。
 *  4. **坏包静默跳过**：坏 JSON、schema 不是 1、缺 idle、引用不存在的图、超限，都不进列表。
 *  5. **写包是整包判据**：不成立就一个字节都不落，原来那份不许被写坏。
 *  6. **工具那一侧与 HTTP 那一侧是同一个库**：模型写完，手机列表里立刻看得到。
 *
 * 路由那三条直接调 handler（真 req/res 形状），只有两个根目录是临时目录 —— 与
 * extension-catalog.test.cjs 同一个口径。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  handlePackList,
  handlePackFile,
  handlePackDelete,
  listPacks,
  writePack,
  deletePack,
  readPackFile,
  isImageName,
  ID_RE,
  builtinRoot,
  MAX_FILE_BYTES,
  MAX_PACK_BYTES,
  MAX_PACK_FILES,
} = require('../lib/mobile/pets.js');

/** 一张最小的 PNG（1×1，透明）。取文件那条按扩展名给媒体类型，不解析内容。 */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');

/** 一份成立的 pack.json。各用例在它上面改一两处，只改要测的那一条。 */
function goodPack(id) {
  return {
    schema: 1,
    id,
    name: '小鲸鱼',
    author: '作者',
    canvas: { w: 52, h: 52 },
    states: { idle: { file: 'idle.png' }, working: { file: 'working.png' } },
  };
}

/** 铺一个包目录：`files` 是「文件名 → 内容」，`pack` 为 null 时不写 pack.json。 */
function makePack(root, id, pack, files) {
  const directory = path.join(root, id);
  fs.mkdirSync(directory, { recursive: true });
  if (pack !== null) {
    fs.writeFileSync(path.join(directory, 'pack.json'), typeof pack === 'string' ? pack : JSON.stringify(pack));
  }
  for (const [name, content] of Object.entries(files || {})) {
    fs.writeFileSync(path.join(directory, name), content);
  }
  return directory;
}

/** 两个临时根。`DSH_MOBILE_PETS*` 只给测试用，用完就删。 */
function setup(t) {
  const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pets-user-'));
  const builtinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pets-builtin-'));
  process.env.DSH_MOBILE_PETS = userRoot;
  process.env.DSH_MOBILE_PETS_BUILTIN = builtinDir;
  t.after(() => {
    fs.rmSync(userRoot, { recursive: true, force: true });
    fs.rmSync(builtinDir, { recursive: true, force: true });
    delete process.env.DSH_MOBILE_PETS;
    delete process.env.DSH_MOBILE_PETS_BUILTIN;
  });
  return { userRoot, builtinDir };
}

/** 假 ServerResponse：只记最后一次回包。 */
function fakeRes() {
  const res = { status: 0, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (payload) => {
    try {
      res.body = JSON.parse(String(payload));
    } catch {
      res.body = null;
    }
  };
  return res;
}

const fakeGet = (url) => ({ url, method: 'GET', headers: {} });

async function callList() {
  const res = fakeRes();
  await handlePackList(null, fakeGet('/api/mobile/v1/pet/packs'), res);
  return res;
}

async function callFile(id, name) {
  const res = fakeRes();
  await handlePackFile(null, fakeGet(`/api/mobile/v1/pet/pack/file?id=${encodeURIComponent(id)}&path=${encodeURIComponent(name)}`), res);
  return res;
}

/** POST 那条：`readJsonBody` 认 `req.body`，递一个已经解析好的 body 就够。 */
async function callDelete(id) {
  const res = fakeRes();
  await handlePackDelete(null, { url: '/api/mobile/v1/pet/pack/delete', method: 'POST', body: { id } }, res);
  return res;
}

test('内置目录不存在也不炸：用户包照列，内置那份只是没有', async (t) => {
  const { userRoot, builtinDir } = setup(t);
  fs.rmSync(builtinDir, { recursive: true, force: true });
  makePack(userRoot, 'mine', goodPack('mine'), { 'idle.png': PNG_BYTES });

  const listed = listPacks();
  assert.deepEqual(listed.map((pack) => pack.id), ['mine']);
  assert.equal(listed[0].builtin, false);

  const res = await callList();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.packs.map((pack) => pack.id), ['mine']);
});

test('两个根都空 / 都不在：空表，不抛', (t) => {
  const { userRoot, builtinDir } = setup(t);
  assert.deepEqual(listPacks(), []);
  fs.rmSync(userRoot, { recursive: true, force: true });
  fs.rmSync(builtinDir, { recursive: true, force: true });
  assert.deepEqual(listPacks(), [], '两个根都不在时回空表，不是报错');
});

test('内置包照常列：builtin 为 true，size 是包内图片之和，min 从大到小', async (t) => {
  const { builtinDir } = setup(t);
  makePack(builtinDir, 'deepy-whale', {
    schema: 1, id: 'deepy-whale', name: 'Deepy 小鲸鱼', author: 'DSH Mobile',
    canvas: { w: 52, h: 52 },
    states: { idle: { file: 'idle.png' }, sleeping: { file: 'sleeping.png' } },
    tiers: { working: [{ min: 1, file: 'idle.png' }, { min: 3, file: 'sleeping.png' }] },
    loop: ['idle', 'working', 'attention'],
    sleepAfterMs: 60000,
  }, { 'idle.png': PNG_BYTES, 'sleeping.png': PNG_BYTES, 'README.md': 'not an image' });

  const [pack] = listPacks();
  assert.equal(pack.builtin, true);
  assert.equal(pack.name, 'Deepy 小鲸鱼');
  assert.equal(pack.author, 'DSH Mobile');
  assert.equal(pack.license, null, '没填就是 null，页脚按它决定画不画');
  assert.deepEqual(pack.canvas, { w: 52, h: 52 });
  assert.deepEqual(pack.states, { idle: { file: 'idle.png' }, sleeping: { file: 'sleeping.png' } });
  assert.deepEqual(pack.files.map((file) => file.path), ['idle.png', 'sleeping.png'], '非图片不进 files');
  assert.equal(pack.size, PNG_BYTES.length * 2);
  assert.equal(pack.sleepAfterMs, 60000);
  assert.deepEqual(pack.tiers.working.map((row) => row.min), [3, 1], 'min 从大到小匹配');

  const res = await callList();
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.packs[0].builtin, true);
});

test('用户目录同 id 覆盖内置：builtin 变 false，列表里只有一份', (t) => {
  const { userRoot, builtinDir } = setup(t);
  makePack(builtinDir, 'deepy-whale', { ...goodPack('deepy-whale'), name: '内置那只' }, { 'idle.png': PNG_BYTES });
  makePack(userRoot, 'deepy-whale', { ...goodPack('deepy-whale'), name: '我改的那只' }, { 'idle.png': PNG_BYTES });

  const listed = listPacks();
  assert.equal(listed.length, 1, '同 id 只该出现一次');
  assert.equal(listed[0].name, '我改的那只');
  assert.equal(listed[0].builtin, false, '用户那份不进「内置」那一档');
});

test('字段收窄：不认识的状态键忽略、坏 canvas 当没填、loop 只留认识的、坏 sleepAfterMs 当没填', (t) => {
  const { userRoot } = setup(t);
  makePack(userRoot, 'shrink', {
    schema: 1,
    id: 'shrink',
    name: '  收窄  ',
    author: 12,
    license: '',
    canvas: { w: 52 },
    anchor: { x: 1, baseline: 2 },
    states: {
      idle: { file: 'idle.png' },
      dancing: { file: 'idle.png' },
      working: { file: 'missing.png' },
      error: { file: '../escape.png' },
    },
    loop: ['idle', 'nope', 'idle', 42],
    sleepAfterMs: -1,
  }, { 'idle.png': PNG_BYTES });

  const [pack] = listPacks();
  assert.equal(pack.name, '收窄', 'name 去掉首尾空白');
  assert.equal(pack.author, null, 'author 不是字符串就是 null');
  assert.equal(pack.license, null);
  assert.equal(pack.canvas, undefined, 'canvas 缺一个字段就当没填');
  assert.deepEqual(pack.anchor, { x: 1, baseline: 2 });
  assert.deepEqual(Object.keys(pack.states), ['idle'], '不认识的状态键忽略；引用不存在的图也算拿不到');
  assert.deepEqual(pack.loop, ['idle'], 'loop 只留认识且不重复的');
  assert.equal(pack.sleepAfterMs, undefined, '非正数没有意义');
});

test('坏包静默跳过：坏 JSON、schema 不对、缺 idle / name、没图、id 对不上，都不进列表', (t) => {
  const { userRoot } = setup(t);
  makePack(userRoot, 'good', goodPack('good'), { 'idle.png': PNG_BYTES });
  makePack(userRoot, 'broken-json', '{ 这不是 json', { 'idle.png': PNG_BYTES });
  makePack(userRoot, 'no-pack', null, { 'idle.png': PNG_BYTES });
  makePack(userRoot, 'wrong-schema', { ...goodPack('wrong-schema'), schema: 2 }, { 'idle.png': PNG_BYTES });
  makePack(userRoot, 'no-idle', {
    schema: 1, id: 'no-idle', name: '没有 idle', states: { working: { file: 'w.png' } },
  }, { 'w.png': PNG_BYTES });
  makePack(userRoot, 'no-name', { schema: 1, id: 'no-name', states: { idle: { file: 'idle.png' } } }, { 'idle.png': PNG_BYTES });
  makePack(userRoot, 'no-images', goodPack('no-images'), { 'README.md': 'x' });
  makePack(userRoot, 'id-mismatch', goodPack('somewhere-else'), { 'idle.png': PNG_BYTES });
  makePack(userRoot, 'Bad-Id', goodPack('Bad-Id'), { 'idle.png': PNG_BYTES });
  // 目录名不合规矩：连读都不读。
  makePack(userRoot, 'bad slug', goodPack('bad slug'), { 'idle.png': PNG_BYTES });

  const ids = listPacks().map((pack) => pack.id);
  assert.deepEqual(ids, ['good'], `坏包不该出现在列表里：${ids.join(', ')}`);
});

test('超限整包拒收：单张超 4MB、文件数超 60、总量超 20MB', (t) => {
  const { userRoot } = setup(t);
  makePack(userRoot, 'ok', goodPack('ok'), { 'idle.png': PNG_BYTES });
  makePack(userRoot, 'big-file', goodPack('big-file'), { 'idle.png': Buffer.alloc(MAX_FILE_BYTES + 1, 7) });
  const many = { 'idle.png': PNG_BYTES };
  for (let index = 0; index <= MAX_PACK_FILES; index += 1) many[`f-${index}.png`] = PNG_BYTES;
  makePack(userRoot, 'too-many', goodPack('too-many'), many);
  // 每张都不超单张上限，合起来顶过整包上限。
  const heavy = { 'idle.png': PNG_BYTES };
  for (let index = 0; index < Math.ceil(MAX_PACK_BYTES / MAX_FILE_BYTES) + 1; index += 1) {
    heavy[`h-${index}.png`] = Buffer.alloc(MAX_FILE_BYTES, 1);
  }
  makePack(userRoot, 'too-heavy', goodPack('too-heavy'), heavy);

  assert.deepEqual(listPacks().map((pack) => pack.id), ['ok']);
});

test('取文件：回 base64 与 mediaType，两种扩展名各自对得上', async (t) => {
  const { builtinDir } = setup(t);
  makePack(builtinDir, 'deepy-whale', goodPack('deepy-whale'), {
    'idle.png': PNG_BYTES,
    // 一个真 GIF 头即可：媒体类型按扩展名给。
    'working.gif': Buffer.from('GIF89a', 'latin1'),
  });

  const gif = await callFile('deepy-whale', 'working.gif');
  assert.equal(gif.status, 200);
  assert.equal(gif.body.ok, true);
  assert.equal(gif.body.mediaType, 'image/gif');
  assert.equal(Buffer.from(gif.body.base64, 'base64').toString('latin1'), 'GIF89a');

  const png = await callFile('deepy-whale', 'idle.png');
  assert.equal(png.status, 200);
  assert.equal(png.body.mediaType, 'image/png');
  assert.deepEqual(Buffer.from(png.body.base64, 'base64'), PNG_BYTES);
});

test('取文件：路径穿越、包里没有的名字、坏 id 都拒绝', async (t) => {
  const { builtinDir } = setup(t);
  const directory = makePack(builtinDir, 'deepy-whale', goodPack('deepy-whale'), { 'idle.png': PNG_BYTES });
  // 包外面放一张「本该读不到」的图。
  fs.writeFileSync(path.join(builtinDir, 'secret.png'), PNG_BYTES);
  fs.mkdirSync(path.join(directory, 'sub'));
  fs.writeFileSync(path.join(directory, 'sub', 'inner.png'), PNG_BYTES);

  for (const name of ['../secret.png', 'sub/inner.png', '/etc/passwd.png', '.hidden.png']) {
    const res = await callFile('deepy-whale', name);
    assert.equal(res.status, 400, `${name} 该在参数那一步就被挡掉`);
    assert.equal(res.body.error.code, 'bad-request');
  }

  const missing = await callFile('deepy-whale', 'nope.png');
  assert.equal(missing.status, 404, '名字合规矩但包里没有：404，不是读到包外去');

  const badId = await callFile('../../x', 'idle.png');
  assert.equal(badId.status, 400, 'id 形状不对直接 400');

  assert.equal(readPackFile('deepy-whale', 'secret.png'), null);
  assert.equal(readPackFile('deepy-whale', 'sub/inner.png'), null);
  assert.equal(readPackFile('deepy-whale', 'idle.png').mediaType, 'image/png');
  assert.equal(isImageName('../secret.png'), false);
  assert.equal(isImageName('sub/idle.png'), false);
  assert.equal(isImageName('idle.png'), true);
  assert.equal(isImageName('idle.gif'), true);
  assert.equal(isImageName('idle.webp'), false);
});

test('删除：用户包删得掉、内置包回 forbidden、不存在回 404', async (t) => {
  const { userRoot, builtinDir } = setup(t);
  makePack(builtinDir, 'deepy-whale', goodPack('deepy-whale'), { 'idle.png': PNG_BYTES });
  makePack(userRoot, 'mine', goodPack('mine'), { 'idle.png': PNG_BYTES });

  const mine = await callDelete('mine');
  assert.equal(mine.status, 200);
  assert.equal(mine.body.ok, true);
  assert.equal(fs.existsSync(path.join(userRoot, 'mine')), false, '目录要真的没了');

  const builtin = await callDelete('deepy-whale');
  assert.equal(builtin.status, 403);
  assert.equal(builtin.body.error.code, 'forbidden');
  assert.equal(fs.existsSync(path.join(builtinDir, 'deepy-whale')), true, '内置那份不许被删');

  const gone = await callDelete('nothing-here');
  assert.equal(gone.status, 404);
  assert.equal(gone.body.error.code, 'pack-not-found');

  const bad = await callDelete('../etc');
  assert.equal(bad.status, 400, 'id 形状不对是 400，不是删别的目录');

  await assert.rejects(() => deletePack('deepy-whale'), (error) => error.code === 'forbidden');
});

test('写包：一份成立的 pack.json + 图，落盘后立刻出现在列表里；不认识的状态键忽略', async (t) => {
  const { userRoot } = setup(t);
  const source = path.join(userRoot, 'source.png');
  fs.writeFileSync(source, PNG_BYTES);

  const result = await writePack({
    id: 'mine',
    pack: {
      schema: 1,
      id: 'mine',
      name: '我做的',
      author: '我',
      license: '自用',
      states: { idle: { file: 'idle.png' }, working: { file: 'working.png' }, dancing: { file: 'idle.png' } },
    },
    files: [
      { path: 'idle.png', filePath: source }, // filePath 是主路：图已经在电脑上了
      { path: 'working.png', base64: PNG_BASE64 }, // base64 只在手上真有字节时兜底
    ],
  });

  assert.equal(result.pack.name, '我做的');
  assert.deepEqual(result.written, ['idle.png', 'working.png']);
  assert.deepEqual(result.rejected, []);
  assert.ok(result.pack.states.idle);
  assert.equal(result.pack.states.dancing, undefined, '不认识的状态键忽略');
  assert.equal(result.overriddenBuiltin, false);

  const listed = listPacks();
  assert.deepEqual(listed.map((pack) => pack.id), ['mine']);
  assert.equal(listed[0].builtin, false);
});

test('写包：覆盖内置 id 允许，但要能被告知', async (t) => {
  const { builtinDir } = setup(t);
  makePack(builtinDir, 'deepy-whale', { ...goodPack('deepy-whale'), name: '内置那只' }, { 'idle.png': PNG_BYTES });

  const result = await writePack({
    id: 'deepy-whale',
    pack: { ...goodPack('deepy-whale'), name: '我改的那只' },
    files: [{ path: 'idle.png', base64: PNG_BASE64 }],
  });
  assert.equal(result.overriddenBuiltin, true, '工具那条路要据此告警一句');
  assert.equal(result.pack.builtin, false);

  const [pack] = listPacks();
  assert.equal(pack.name, '我改的那只');
  assert.equal(pack.builtin, false);
  // 内置那份还在原处，只是被盖住了。
  const onDisk = JSON.parse(fs.readFileSync(path.join(builtinDir, 'deepy-whale', 'pack.json'), 'utf8'));
  assert.equal(onDisk.name, '内置那只');
});

test('写包：不成立就整包拒收，原来那份一个字节不动', async (t) => {
  const { userRoot } = setup(t);
  makePack(userRoot, 'mine', { ...goodPack('mine'), name: '原来那份' }, { 'idle.png': PNG_BYTES });

  // 缺 idle：整包不成立。
  await assert.rejects(
    () => writePack({ id: 'mine', pack: { schema: 1, id: 'mine', name: '新的', states: {} }, files: [{ path: 'w.png', base64: PNG_BASE64 }] }),
    (error) => error.code === 'bad-pack',
  );
  // 引用了包里没有的图：同样不成立。
  await assert.rejects(
    () => writePack({ id: 'mine', pack: { ...goodPack('mine'), states: { idle: { file: 'ghost.png' } } }, files: [] }),
    (error) => error.code === 'bad-pack',
  );
  // id 形状不对、pack 不是对象：400 那一档。
  await assert.rejects(() => writePack({ id: 'Bad Id', pack: goodPack('Bad Id') }), (error) => error.code === 'bad-request');
  await assert.rejects(() => writePack({ id: 'mine', pack: 'not an object' }), (error) => error.code === 'bad-request');

  const [pack] = listPacks();
  assert.equal(pack.name, '原来那份', '失败的写入不许把原来那份写坏');
  assert.equal(fs.existsSync(path.join(userRoot, 'mine', 'w.png')), false, '整包拒收时一个文件都不该落');
  assert.equal(fs.existsSync(path.join(userRoot, 'mine', 'pack.json.tmp')), false, '也不该留半份临时档案');
});

test('写包：文件数超上限整包拒收', async (t) => {
  setup(t);
  const many = [];
  for (let index = 0; index <= MAX_PACK_FILES; index += 1) many.push({ path: `f-${index}.png`, base64: PNG_BASE64 });
  await assert.rejects(
    () => writePack({ id: 'mine', pack: goodPack('mine'), files: many }),
    (error) => error.code === 'too-large',
  );
});

test('写包：不合规矩的文件名与读不到的路径都进 rejected，不挡其余几张', async (t) => {
  const { userRoot } = setup(t);
  const result = await writePack({
    id: 'mine',
    // 唯一真能收进来的那张就是 idle，所以 states 只引用它。
    pack: { ...goodPack('mine'), states: { idle: { file: 'working.png' } } },
    files: [
      { path: '../escape.png', base64: PNG_BASE64 },
      { path: 'sub/idle.png', base64: PNG_BASE64 },
      { path: 'idle.webp', base64: PNG_BASE64 },
      { path: 'idle.png', filePath: '/definitely/not/here.png' },
      { path: 'working.png', base64: PNG_BASE64 },
    ],
  });
  assert.deepEqual(result.written, ['working.png']);
  assert.deepEqual(result.rejected, ['../escape.png', 'sub/idle.png', 'idle.webp', 'idle.png']);
  assert.equal(fs.existsSync(path.join(userRoot, 'mine', 'escape.png')), false);
});

test('内置包库的默认根在插件包自己的 assets/pets/；id 形状卡死', () => {
  delete process.env.DSH_MOBILE_PETS_BUILTIN;
  const root = builtinRoot();
  assert.ok(path.isAbsolute(root));
  assert.equal(root, path.join(path.dirname(__dirname), 'assets', 'pets'));
  assert.equal(ID_RE.test('deepy-whale'), true);
  assert.equal(ID_RE.test('-leading'), false);
  assert.equal(ID_RE.test('has space'), false);
  assert.equal(ID_RE.test('a'.repeat(65)), false);
});

test('可选表现字段：bonus / timings / idlePool / reactions / hitBoxes / tiers.juggling / 元数据照原样透传', async (t) => {
  const { builtinDir } = setup(t);
  const files = {
    'idle.png': PNG_BYTES,
    'thinking.gif': Buffer.from('GIF89a', 'latin1'),
    'music.gif': Buffer.from('GIF89a', 'latin1'),
    'building.gif': Buffer.from('GIF89a', 'latin1'),
    'hearts.gif': Buffer.from('GIF89a', 'latin1'),
    'poke-left.gif': Buffer.from('GIF89a', 'latin1'),
  };
  makePack(builtinDir, 'deepy-whale', {
    schema: 1, id: 'deepy-whale', name: 'Deepy 小鲸鱼',
    author: 'DSH Mobile', license: '随本项目发布', source: 'https://example.com/pets/deepy',
    pixelArt: true, scale: 5,
    canvas: { w: 52, h: 52 },
    anchor: { x: 28, baseline: 48 },
    contentBox: { x: 12, y: 26, w: 36, h: 22 },
    hitBoxes: {
      default: { x: 12, y: 26, w: 33, h: 22 },
      wide: { x: 8, y: 18, w: 44, h: 31 },
      sleeping: { x: 7, y: 23, w: 39, h: 25 },
      byAnim: { typing: { x: 0, y: 26, w: 52, h: 23 } },
      wideAnims: ['typing', 'music'],
      sleepingAnims: ['sleeping'],
    },
    states: {
      idle: { file: 'idle.png' }, working: { file: 'idle.png' },
      thinking: { file: 'thinking.gif' }, juggling: { file: 'music.gif' },
    },
    tiers: {
      working: [{ min: 3, file: 'building.gif' }, { min: 1, file: 'idle.png' }],
      juggling: [{ min: 2, file: 'music.gif' }, { min: 1, file: 'idle.png' }],
    },
    bonus: { attention: { anims: ['hearts.gif'], chance: 0.2 } },
    timings: {
      minDisplay: { attention: 5200, error: 4800 },
      autoReturn: { attention: 5200, carrying: 3200 },
    },
    idlePool: {
      everyMs: { mean: 120000, min: 45000, max: 300000 },
      anims: [{ file: 'thinking.gif', ms: 6800, weight: 1 }],
    },
    reactions: { tapLeft: 'poke-left.gif', tapRight: 'poke-left.gif' },
    roam: { anim: 'thinking.gif', faces: 'left' },
    sleep: { afterMs: 60000 },
  }, files);

  const [pack] = listPacks();
  assert.equal(pack.source, 'https://example.com/pets/deepy');
  assert.equal(pack.pixelArt, true);
  assert.equal(pack.scale, 5);
  assert.deepEqual(pack.contentBox, { x: 12, y: 26, w: 36, h: 22 });
  assert.deepEqual(pack.hitBoxes, {
    default: { x: 12, y: 26, w: 33, h: 22 },
    wide: { x: 8, y: 18, w: 44, h: 31 },
    sleeping: { x: 7, y: 23, w: 39, h: 25 },
    byAnim: { typing: { x: 0, y: 26, w: 52, h: 23 } },
    wideAnims: ['typing', 'music'],
    sleepingAnims: ['sleeping'],
  });
  assert.deepEqual(Object.keys(pack.states), ['idle', 'working', 'thinking', 'juggling'], '扩展态认得');
  assert.deepEqual(pack.tiers.juggling.map((row) => row.min), [2, 1]);
  assert.deepEqual(pack.bonus, { attention: { anims: ['hearts.gif'], chance: 0.2 } });
  assert.deepEqual(pack.timings, {
    minDisplay: { attention: 5200, error: 4800 },
    autoReturn: { attention: 5200, carrying: 3200 },
  });
  assert.deepEqual(pack.idlePool, {
    everyMs: { mean: 120000, min: 45000, max: 300000 },
    anims: [{ file: 'thinking.gif', ms: 6800, weight: 1 }],
  });
  assert.deepEqual(pack.reactions, { tapLeft: 'poke-left.gif', tapRight: 'poke-left.gif' });
  assert.deepEqual(pack.roam, { anim: 'thinking.gif', faces: 'left' });
  assert.deepEqual(pack.sleep, { afterMs: 60000 }, '嵌套写法和顶层 sleepAfterMs 并存');

  // 列表接口要带出去：App/原生靠这一份对齐，少一格就得再发一版插件。
  const res = await callList();
  const listed = res.body.packs[0];
  for (const key of ['source', 'pixelArt', 'scale', 'contentBox', 'hitBoxes', 'bonus', 'timings', 'idlePool', 'reactions', 'roam', 'sleep']) {
    assert.deepEqual(listed[key], pack[key], `${key} 没带出去`);
  }
  assert.deepEqual(listed.tiers.juggling.map((row) => row.min), [2, 1]);
});

test('可选表现字段：坏值逐项丢掉，包本身照常在（不是坏包）', (t) => {
  const { builtinDir } = setup(t);
  makePack(builtinDir, 'shrink', {
    schema: 1, id: 'shrink', name: '收窄',
    pixelArt: 'yes',
    scale: -2,
    source: '   ',
    contentBox: { x: 1, y: 2, w: 0, h: 3 },
    hitBoxes: {
      default: { x: 1, y: 2, w: 3, h: 4 },
      wide: { x: 1, y: 2, w: 3 },
      byAnim: { typing: { x: 1, y: 2, w: 3, h: 4 }, '../nope': { x: 0, y: 0, w: 1, h: 1 } },
      wideAnims: [42, 'typing', 'typing', '../nope'],
      sleepingAnims: 'sleeping',
    },
    states: { idle: { file: 'idle.png' } },
    tiers: {
      working: [{ min: 1, file: 'idle.png' }, { min: 0, file: 'idle.png' }, { min: 2, file: '../escape.png' }],
      juggling: [{ min: 1, file: 'ghost.gif' }],
    },
    bonus: {
      attention: { anims: ['ghost.gif'], chance: 0.5 },
      idle: { anims: ['idle.png'], chance: 2 },
      nope: { anims: ['idle.png'], chance: 0.5 },
      error: { anims: [], chance: 0.5 },
    },
    timings: { minDisplay: { attention: -5, nope: 1000, working: 900 }, autoReturn: 'fast' },
    idlePool: {
      everyMs: { mean: 120000, min: 300000, max: 45000 },
      anims: [{ file: 'ghost.gif', ms: 100 }, { file: 'idle.png', ms: -1, weight: 0 }],
    },
    reactions: { tapLeft: 'ghost.gif', tapRight: '../escape.png', drag: 'idle.png' },
    roam: { anim: 'ghost.gif', faces: 'left' },
    sleep: { afterMs: -5 },
  }, { 'idle.png': PNG_BYTES });

  const [pack] = listPacks();
  assert.ok(pack, '个别字段写坏不该让整只宠物消失');
  assert.equal(pack.pixelArt, true, '不是布尔就按缺省「像素画」');
  assert.equal(pack.scale, 1, '不是正数就按缺省 1:1');
  assert.equal(pack.source, undefined, '空白串按「没填」处理');
  assert.equal(pack.contentBox, undefined, 'w 为 0 的框没有意义');
  assert.deepEqual(pack.hitBoxes, {
    default: { x: 1, y: 2, w: 3, h: 4 },
    byAnim: { typing: { x: 1, y: 2, w: 3, h: 4 } },
    wideAnims: ['typing'],
  }, '缺字段的 wide 丢掉；byAnim 里带斜杠的键进不来；wideAnims 只留合规名字、去重；sleepingAnims 不是数组就不收');
  assert.deepEqual(pack.tiers.working.map((row) => row.file), ['idle.png'], 'min<1 与包里没有的图都丢掉');
  assert.equal(pack.tiers.juggling, undefined);
  assert.deepEqual(pack.bonus, { idle: { anims: ['idle.png'], chance: 1 } }, 'chance 夹到 1；空列表、未知状态、引用不存在的图全丢');
  assert.deepEqual(pack.timings, { minDisplay: { working: 900 } }, '不认识的键与负数都丢掉，autoReturn 不是对象就当没填');
  assert.deepEqual(pack.idlePool, { anims: [{ file: 'idle.png' }] }, 'ms/weight 不是正数就只留文件名');
  assert.deepEqual(pack.reactions, { drag: 'idle.png' });
  assert.equal(pack.roam, undefined, 'roam 引用的图不在包里就整格丢掉');
  assert.equal(pack.sleep, undefined, 'afterMs 不是正数就当没填');
});

test('roam：faces 只认 left / right / front，不在里面就整格丢掉；sleep.afterMs 与顶层 sleepAfterMs 并存', (t) => {
  const { userRoot } = setup(t);
  const base = { schema: 1, name: '游走测试', states: { idle: { file: 'idle.png' } }, sleepAfterMs: 90000 };
  const write = (id, extra) => {
    fs.mkdirSync(path.join(userRoot, id), { recursive: true });
    fs.writeFileSync(path.join(userRoot, id, 'pack.json'), JSON.stringify({ ...base, id, ...extra }));
    fs.writeFileSync(path.join(userRoot, id, 'idle.png'), PNG_BYTES);
  };
  write('front', { roam: { anim: 'idle.png', faces: 'front' } });
  write('bad-face', { roam: { anim: 'idle.png', faces: 'sideways' } });
  write('no-face', { roam: { anim: 'idle.png' } });
  write('bad-anim', { roam: { anim: '../escape.png', faces: 'left' } });
  write('nested-sleep', { sleep: { afterMs: 30000 } });
  write('float-sleep', { sleep: { afterMs: 1500.6 } });

  const packs = new Map(listPacks().map((pack) => [pack.id, pack]));
  assert.deepEqual(packs.get('front').roam, { anim: 'idle.png', faces: 'front' });
  assert.equal(packs.get('bad-face').roam, undefined, 'faces 不认识就整格丢');
  assert.equal(packs.get('no-face').roam, undefined, 'faces 必填');
  assert.equal(packs.get('bad-anim').roam, undefined, '不是包里单层图就丢');
  assert.deepEqual(packs.get('nested-sleep').sleep, { afterMs: 30000 });
  assert.equal(packs.get('nested-sleep').sleepAfterMs, 90000, '顶层老写法不受影响，两者并存');
  assert.deepEqual(packs.get('float-sleep').sleep, { afterMs: 1501 }, '毫秒取整');
});

test('老包兼容：没有可选字段时它们不出现，一份老包照旧能列、能取图', async (t) => {
  const { userRoot } = setup(t);
  makePack(userRoot, 'old', goodPack('old'), { 'idle.png': PNG_BYTES });

  const [pack] = listPacks();
  for (const key of ['source', 'contentBox', 'bonus', 'timings', 'idlePool', 'reactions', 'hitBoxes', 'roam', 'sleep']) {
    assert.equal(pack[key], undefined, `${key} 在老包里该是「没填」`);
  }
  assert.equal(pack.pixelArt, true, '老包没有 pixelArt 时按像素画（与原来一致）');
  assert.equal(pack.scale, 1, '老包没有 scale 时按 1:1（与原来一致）');
  assert.deepEqual(pack.tiers, {}, '老包没有分档时 tiers 是空对象，与原来一致');

  const res = await callList();
  const listed = res.body.packs[0];
  assert.equal(listed.source, undefined);
  assert.equal(listed.bonus, undefined);
  assert.equal((await callFile('old', 'idle.png')).status, 200);
});

test('可选字段里的文件名同样过单层 + 真在包里的判据：路径穿越拿不到任何东西', (t) => {
  const { builtinDir } = setup(t);
  const directory = makePack(builtinDir, 'deepy-whale', {
    schema: 1, id: 'deepy-whale', name: '穿越测试',
    states: { idle: { file: 'idle.png' } },
    bonus: { attention: { anims: ['../secret.png', 'sub/inner.png', '/etc/passwd.png'], chance: 0.5 } },
    reactions: { tapLeft: '../secret.png', tickle: 'sub/inner.png' },
    hitBoxes: { default: { x: 0, y: 0, w: 10, h: 10 } },
  }, { 'idle.png': PNG_BYTES });
  fs.writeFileSync(path.join(builtinDir, 'secret.png'), PNG_BYTES);
  fs.mkdirSync(path.join(directory, 'sub'));
  fs.writeFileSync(path.join(directory, 'sub', 'inner.png'), PNG_BYTES);

  const [pack] = listPacks();
  assert.equal(pack.bonus, undefined, '彩蛋里全是非法名：整格丢掉，而不是留下一串读不到的路径');
  assert.equal(pack.reactions, undefined);
  assert.equal(readPackFile('deepy-whale', 'secret.png'), null);
  assert.equal(readPackFile('deepy-whale', 'sub/inner.png'), null);
  assert.deepEqual(pack.files.map((file) => file.path), ['idle.png'], '子目录里的图不进包清单');
  // 体积上限也还是原来那几条：新增字段不放宽任何一条。
  assert.equal(isImageName('../secret.png'), false);
});

test('写包工具：新字段经 pet_pack_write 整份落盘，再读回来一字不差', async (t) => {
  const { userRoot } = setup(t);
  const { installPetTools } = require('../lib/mobile/pet-tools.js');
  const registered = [];
  installPetTools({ inject: (_deps, scoped) => scoped({ tools: { register: (tool) => registered.push(tool) } }) });
  const write = registered.find((tool) => tool.name === 'pet_pack_write');

  const out = await write.execute({
    id: 'mine',
    pack: {
      name: '我做的',
      pixelArt: true,
      scale: 1,
      source: '自己画的',
      contentBox: { x: 1, y: 2, w: 3, h: 4 },
      states: { idle: { file: 'idle.png' }, juggling: { file: 'idle.png' } },
      tiers: { juggling: [{ min: 2, file: 'idle.png' }] },
      bonus: { attention: { anims: ['idle.png'], chance: 0.3 } },
      timings: { minDisplay: { attention: 3000 } },
      idlePool: { everyMs: { mean: 1000, min: 500, max: 2000 }, anims: [{ file: 'idle.png', ms: 800, weight: 2 }] },
      reactions: { tickle: 'idle.png' },
      hitBoxes: { default: { x: 0, y: 0, w: 10, h: 10 }, wideAnims: ['idle'], sleepingAnims: ['idle'] },
      roam: { anim: 'idle.png', faces: 'front' },
      sleep: { afterMs: 45000 },
    },
    files: [{ path: 'idle.png', base64: PNG_BASE64 }],
  });
  assert.equal(out.id, 'mine');
  assert.deepEqual(out.written, ['idle.png']);

  const [pack] = listPacks();
  assert.equal(pack.source, '自己画的');
  assert.deepEqual(pack.contentBox, { x: 1, y: 2, w: 3, h: 4 });
  assert.deepEqual(pack.tiers.juggling, [{ min: 2, file: 'idle.png' }]);
  assert.deepEqual(pack.bonus, { attention: { anims: ['idle.png'], chance: 0.3 } });
  assert.deepEqual(pack.timings, { minDisplay: { attention: 3000 } });
  assert.deepEqual(pack.idlePool, { everyMs: { mean: 1000, min: 500, max: 2000 }, anims: [{ file: 'idle.png', ms: 800, weight: 2 }] });
  assert.deepEqual(pack.reactions, { tickle: 'idle.png' });
  assert.deepEqual(pack.hitBoxes, {
    default: { x: 0, y: 0, w: 10, h: 10 },
    wideAnims: ['idle'],
    sleepingAnims: ['idle'],
  });
  assert.deepEqual(pack.roam, { anim: 'idle.png', faces: 'front' });
  assert.deepEqual(pack.sleep, { afterMs: 45000 });

  // 档案里同样落了盘（不是只在内存里凑出来的）。
  const onDisk = JSON.parse(fs.readFileSync(path.join(userRoot, 'mine', 'pack.json'), 'utf8'));
  assert.deepEqual(onDisk.bonus, { attention: { anims: ['idle.png'], chance: 0.3 } });
  assert.equal(onDisk.source, '自己画的');
});

test('两个工具真的注册得上（schema 能被 dsh-tools 编译），没有 tools 注入时静默跳过', async (t) => {
  const { userRoot } = setup(t);
  const { installPetTools } = require('../lib/mobile/pet-tools.js');
  const registered = [];
  installPetTools({ inject: (_deps, scoped) => scoped({ tools: { register: (tool) => registered.push(tool) } }) });
  installPetTools({}); // 没有 inject 的 profile：静默跳过，不抛

  assert.deepEqual(registered.map((tool) => tool.name), ['pet_pack_list', 'pet_pack_write']);

  // 工具那一侧与 HTTP 那一侧是同一个库：模型写完，列表里立刻看得到。
  const write = registered.find((tool) => tool.name === 'pet_pack_write');
  const out = await write.execute({
    id: 'mine',
    pack: { name: '我做的', author: '我', states: { idle: { file: 'idle.png' } } },
    files: [{ path: 'idle.png', base64: PNG_BASE64 }],
  });
  assert.equal(out.id, 'mine');
  assert.deepEqual(out.written, ['idle.png']);

  const [pack] = listPacks();
  assert.equal(pack.name, '我做的');
  assert.equal(fs.existsSync(path.join(userRoot, 'mine', 'idle.png')), true);
  assert.match(write.output.render({}, out)[0].text, /我做的/);

  // 参数不成立时工具要报错（模型读得懂的那一句），而不是悄悄不写。
  await assert.rejects(() => write.execute({ id: 'Bad Id', pack: {}, files: [] }), /不是合法的宠物包 id/);
  await assert.rejects(
    () => write.execute({ id: 'mine', pack: { name: 'x', states: {} }, files: [] }),
    /至少要有一个能用的 idle/,
  );
  await assert.rejects(
    () => write.execute({ id: 'mine', pack: { name: 'x', states: { idle: { file: 'idle.png' } } }, files: [{ path: '../x.png' }] }),
    /文件名不合规矩/,
  );
});

test('pet_pack_list 的渲染：六状态齐全的包说「五个状态都有」，真缺的才报缺', async (t) => {
  const { userRoot, builtinDir } = setup(t);
  // 内置这只六个状态键都齐（执行那一步把它折成状态名数组交给渲染）。
  makePack(builtinDir, 'deepy-whale', {
    schema: 1, id: 'deepy-whale', name: 'Deepy 小鲸鱼',
    states: {
      idle: { file: 'idle.png' }, working: { file: 'idle.png' }, attention: { file: 'idle.png' },
      done: { file: 'idle.png' }, error: { file: 'idle.png' }, sleeping: { file: 'idle.png' },
    },
  }, { 'idle.png': PNG_BYTES });
  // 对照用的自制包：只有 idle，缺的那四个得照样点出来。
  makePack(userRoot, 'mine', goodPack('mine'), { 'idle.png': PNG_BYTES });

  const { installPetTools } = require('../lib/mobile/pet-tools.js');
  const registered = [];
  installPetTools({ inject: (_deps, scoped) => scoped({ tools: { register: (tool) => registered.push(tool) } }) });
  const list = registered.find((tool) => tool.name === 'pet_pack_list');

  const out = await list.execute({});
  assert.deepEqual(out.packs.find((pack) => pack.id === 'deepy-whale').states, [
    'idle', 'working', 'attention', 'done', 'error', 'sleeping',
  ], '交给渲染的是状态名数组');

  const text = list.output.render({}, out)[0].text;
  const whale = text.split('\n').find((line) => line.includes('Deepy 小鲸鱼'));
  const mine = text.split('\n').find((line) => line.includes('小鲸鱼》') && line.includes('id mine'));
  assert.match(whale, /五个状态都有/);
  assert.doesNotMatch(whale, /缺 idle/);
  assert.doesNotMatch(whale, /缺 /);
  assert.match(mine, /缺 working \/ attention \/ done \/ error（将回退到 idle）/);
});
