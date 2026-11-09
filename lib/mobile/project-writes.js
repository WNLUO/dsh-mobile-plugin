'use strict';

/**
 * 项目写入暂停的对外出口：`GET / POST /api/mobile/v1/project/writes`。
 *
 * ## 为什么要有这一条
 *
 * `project-write-queue.js` 的 `pauseProjectWrites` / `resumeProjectWrites` 语义是对的
 * （暂停之后同项目后续排到的写停在门口、恢复放行），但此前**零调用方**：手机上看不到、
 * 点不到，等于一个写着「能暂停」却没人用得上的开关。这条路由把它接到 App 侧右栏文件浏览器
 * 工具栏那颗「暂停写入」上 —— 写就发生在那一页（新建文件夹 / 上传落盘），开关放在它旁边
 * 才是它该在的位置。
 *
 * ## 这条路由能做什么、不能做什么
 *
 * 只切「插件自己发起的写」的**排队行为**，不落盘任何文件、不碰模型在宿主里跑的工具。
 * 所以它不归 `files.write`：一个只读设备点它不会写出任何东西，只是让这台电脑上那几个写
 * 在门口多停一会儿。暂停状态是**进程内**状态、不落盘 —— 插件重载之后自动恢复「不暂停」，
 * 这是对的：没有人愿意哪天重启完发现自己忘了哪个开关还压着。
 *
 * 能力面：`path` 只用来当队列键（与 `file-ops.js` 的 `queueKeyOf` 同一层语义，是项目目录的
 * 绝对路径）。它不来自用户输入以外的任何地方，也不参与任何文件操作 —— 拼错一个键最多是
 * 「暂停了一个不存在的队列」，不会写到别处去。
 */

const { sendJson, readJsonBody } = require('../shared/http-util');
const {
  pauseProjectWrites, resumeProjectWrites, isProjectPaused,
} = require('./project-write-queue.js');

/**
 * GET /api/mobile/v1/project/writes?path=…（token）→ { ok, path, paused }
 *
 * `path` 必填：暂停是按项目目录算的，没有「全局」那一档 —— 一个全局开关会让用户以为
 * 「整个电脑都不写了」，而实际被挡住的只有这个项目里那三个插件写接口。
 */
async function handleProjectWrites(_ctx, req, res) {
  const url = new URL(req.url || '/', 'http://x');
  const path = (url.searchParams.get('path') || '').trim();

  if (req.method === 'GET' || !req.method) {
    if (!path) {
      return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 path（项目目录的绝对路径）' } });
    }
    return sendJson(res, 200, { ok: true, path, paused: isProjectPaused(path) });
  }

  const body = await readJsonBody(req, 64 * 1024);
  const bodyPath = body && typeof body.path === 'string' ? body.path.trim() : '';
  if (!bodyPath || typeof body.paused !== 'boolean') {
    return sendJson(res, 400, {
      ok: false,
      error: { code: 'bad-request', message: '需要 { path, paused: true|false }' },
    });
  }
  if (body.paused) pauseProjectWrites(bodyPath);
  else resumeProjectWrites(bodyPath);
  sendJson(res, 200, { ok: true, path: bodyPath, paused: isProjectPaused(bodyPath) });
}

module.exports = { handleProjectWrites };
