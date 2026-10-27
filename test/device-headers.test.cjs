'use strict';

/**
 * 「设备身份跟着每条请求走」的规格（2026-10-26）。
 *
 * 现象是用户报的：App 已经是最新版，面板的「已绑定的设备」里还是老版本号、还有「未知设备」，
 * 而且都写着「加密」。根因不在中转，也不在面板：姓名 / 平台 / 系统版本 / App 版本
 * **只在配对那一刻写一次**，之后谁都不碰；旧会话升级写进来的记录更是只带密钥、不带身份。
 *
 * 这条契约由三截组成，缺一截就回到老样子：
 *  1. 手机在统一的鉴权头里带上这四样（`app/src/services/viewmodels/authHeaders.ts`）；
 *  2. 宿主在鉴权通过那一刻把它们写回凭据记录（`lib/impl.js` 的 `onAuthorized`）；
 *  3. 凭据库按「有哪几格就写哪几格」合并 —— **缺一个不能把已有值冲成空**。
 *
 * 这里钉的是 2 与 3，外加「两侧头名逐字一致」（改一边不改另一边时它不会报错，
 * 只会静静地什么都不发生 —— 那正是这次要修的那种坏法）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { deviceMetaFromHeaders } = require('../lib/shared/device-headers.js');

test('五个头各读各的；缺的格子不出现在结果里（空串会冲掉已有值）', () => {
  const meta = deviceMetaFromHeaders({
    headers: {
      'x-dsh-device-name': 'Pixel 9',
      'x-dsh-device-model': 'Xiaomi 9',
      'x-dsh-platform': 'android',
      'x-dsh-os-version': '34',
      'x-dsh-app-version': '0.3.24',
    },
  });
  assert.deepEqual(meta, { name: 'Pixel 9', model: 'Xiaomi 9', platform: 'android', osVersion: '34', appVersion: '0.3.24' });

  // 老版本 App 一个头都不带：结果必须是空对象，不能是五个空串。
  assert.deepEqual(deviceMetaFromHeaders({ headers: {} }), {});
  assert.deepEqual(deviceMetaFromHeaders(undefined), {});
  assert.deepEqual(deviceMetaFromHeaders({}), {});

  // 只带了版本：只写这一格。
  assert.deepEqual(deviceMetaFromHeaders({ headers: { 'x-dsh-app-version': '0.3.25' } }), { appVersion: '0.3.25' });

  // 只带机型（这一格出生之前配的对，靠这里补登记）：也只写这一格。
  assert.deepEqual(deviceMetaFromHeaders({ headers: { 'x-dsh-device-model': ' iPhone 15 Pro ' } }), { model: 'iPhone 15 Pro' });

  // 重复头是数组，只认第一个；首尾空白裁掉。
  assert.equal(deviceMetaFromHeaders({ headers: { 'x-dsh-device-name': ['  iPhone  ', 'x'] } }).name, 'iPhone');
  // 非字符串（数字 / 对象）一律当作没带。
  assert.deepEqual(deviceMetaFromHeaders({ headers: { 'x-dsh-app-version': 5 } }), {});
});

test('凭据库：touch 带身份时写回去，缺的格子保持原值', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-device-meta-'));
  const file = path.join(dir, 'relay-device-credentials.json');
  // 落盘路径在 require 那一刻定下来，所以环境变量必须先设（与 device-credentials-store 那条同规矩）。
  process.env.DEVICE_CREDENTIALS_FILE = file;
  const credentials = require('../dsh-mobile-credentials/lib/credentials.js');
  credentials.resetForTest();

  const issued = credentials.issue('inst-meta', {
    deviceId: 'dev-meta',
    name: '旧名字',
    model: 'iPhone 14 Pro',
    platform: 'ios',
    appVersion: '0.3.0',
  });
  const record = credentials.lookup(issued.credential, 'inst-meta');
  assert.equal(record.appVersion, '0.3.0');
  assert.equal(record.model, 'iPhone 14 Pro', '配对那一刻带的机型要落进记录');

  // 手机升级了：只带版本与系统版本 → 名字、机型与平台保持原样。
  credentials.touch(record, { channel: 'lan', meta: { appVersion: '0.3.24', osVersion: '18.2' } });
  assert.equal(record.appVersion, '0.3.24', '版本必须被刷新（这正是「面板还报旧版本」那条）');
  assert.equal(record.osVersion, '18.2');
  assert.equal(record.name, '旧名字', '这次没带名字，已有的必须留着');
  assert.equal(record.model, 'iPhone 14 Pro', '这次没带机型，已有的必须留着 —— 冲成空就成了「认不出是哪台」');
  assert.equal(record.platform, 'ios');

  // 不带任何身份（老版本 App）：什么都不改。
  credentials.touch(record, { channel: 'lan' });
  assert.equal(record.appVersion, '0.3.24');
  assert.equal(record.name, '旧名字');

  // 身份变了必须落盘 —— 面板读的是盘上那份（旁路子进程按文件指纹重载）。
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  const stored = (Array.isArray(onDisk) ? onDisk : onDisk.records || []).find((item) => item.deviceId === 'dev-meta');
  assert.ok(stored, '盘上找不到这条记录');
  assert.equal(stored.appVersion, '0.3.24', '身份变了却没落盘：面板会一直显示旧版本');

  credentials.resetForTest();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * App 侧那两份源码只在主仓检出里存在：插件被单独 clone 出去（公开发布仓库）时没有 app/，
 * 那条流水线跑的是「发出去的包」。所以这条跨仓对账按仓里既有写法在缺席时 skip，
 * 并把理由写进 skipped 计数（不静默变绿）。
 */
const APP_DEVICE_IDENTITY = path.join(__dirname, '..', '..', 'app', 'src', 'services', 'device-identity.ts');
const NO_APP = !fs.existsSync(APP_DEVICE_IDENTITY);
const SKIP_NO_APP = NO_APP && `${APP_DEVICE_IDENTITY} 不存在（插件单独检出），跳过跨仓对账`;

test('两侧头名逐字一致：App 写的名字必须就是宿主读的那几个', { skip: SKIP_NO_APP }, () => {
  const app = fs.readFileSync(
    path.join(__dirname, '..', '..', 'app', 'src', 'services', 'device-identity.ts'),
    'utf8',
  );
  const headers = fs.readFileSync(
    path.join(__dirname, '..', '..', 'app', 'src', 'services', 'viewmodels', 'authHeaders.ts'),
    'utf8',
  );
  const host = fs.readFileSync(path.join(__dirname, '..', 'lib', 'shared', 'device-headers.js'), 'utf8');
  for (const name of ['X-Dsh-Device-Model', 'X-Dsh-Platform', 'X-Dsh-Os-Version', 'X-Dsh-App-Version']) {
    assert.ok(app.includes(name), `App 侧没有写 ${name}`);
    assert.ok(
      host.toLowerCase().includes(name.toLowerCase()),
      `宿主侧没有读 ${name}（改了一边忘另一边：身份永远刷不上去，而且不会报错）`,
    );
  }
  // 设备名那一格 App **不再发**（2026-10-27）：它填的是 App 里给这台电脑起的备注，不是手机
  // 自己的名字，报上去等于把「书房的 Mac」挂到手机头上。宿主仍读这条头，老 App 照旧能补。
  assert.ok(!headers.includes('X-Dsh-Device-Name'), 'App 不该再把电脑的备注当手机名发出去');
  assert.ok(host.toLowerCase().includes('x-dsh-device-name'), '宿主侧要读设备名（老 App 还会发）');
});
