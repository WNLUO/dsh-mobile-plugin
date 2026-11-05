'use strict';

/**
 * 给模型的两个工具：看一眼这台电脑上有哪些宠物包、做一只新的（或者改现有的）。
 *
 * ## 为什么要有工具
 *
 * 宠物包是「一个目录 + 一份 pack.json + 几张图」，而素材基本都已经是电脑上的图片文件了。
 * 让模型自己往目录里写，它记不住放哪儿、id 什么形状、状态键叫什么；写完还得自己回一句
 * 「好了」，用户那边刷半天也不一定看得到。工具负责的正是这几件它记不住的事。
 *
 * ## 为什么不收 base64 为主
 *
 * 与公众号那条同一个理由：让模型把几 MB 的图抄进工具参数，抄不动也抄不对。它手里真有的是
 * 「那张图在这台电脑上的路径」，所以 `filePath` 是主路，`base64` 只在它手上真有字节时兜底。
 *
 * ## 能力面的边界
 *
 * 只碰这个库：id 形状卡死、图片只认单层 `.gif` / `.png`、单张与整包都有上限。**没有删除** ——
 * 删是人的动作（设置页那边有个按钮），不该由模型顺手做掉。
 */

const { defineTool } = require('@deepseek-ai/dsh-tools');

const {
  listPacks,
  writePack,
  isImageName,
  ID_RE,
  KNOWN_STATES,
} = require('./pets.js');

/** 列表里一行一只：名字、id、内置还是自己做的、状态齐不齐。 */
function packLine(pack) {
  const tags = [pack.builtin ? '内置' : '自己做的'];
  tags.push(`id ${pack.id}`);
  const missing = KNOWN_STATES.filter((state) => state !== 'sleeping' && !pack.states[state]);
  tags.push(missing.length === 0 ? '五个状态都有' : `缺 ${missing.join(' / ')}（将回退到 idle）`);
  if (pack.author) tags.push(pack.author);
  return `· 《${pack.name}》${tags.join('，')}`;
}

/**
 * 注册这两个工具。
 *
 * 必须走 `ctx.inject(['tools'], …)`：宿主里 `tools` 是子代理作用域提供的服务，插件这一层
 * 直接读 `ctx.tools` 拿到的常常是 undefined（见 `phone/tools.js` 那一整段教训）。缺失时
 * 静默跳过，别把整块装配掀掉。
 */
function installPetTools(ctx) {
  if (typeof ctx.inject !== 'function') return;
  try {
    ctx.inject(['tools'], mountTools);
  } catch (error) {
    // 没有 tools 注入的 profile（cordis 抛 "… without inject"）：只少这两个工具，包目录与
    // 三条路由照常可用。其余错误照抛 —— 别把真的注册失败也当成「这个 profile 没注入」。
    const message = error && error.message ? error.message : String(error);
    if (!message.includes('without inject')) throw error;
  }
}

/** `ctx.inject` 的回调体。单独拎出来只为让上面那层 try/catch 短一点。 */
function mountTools(scoped) {
  if (!scoped || !scoped.tools || typeof scoped.tools.register !== 'function') return;

  scoped.tools.register(defineTool({
    name: 'pet_pack_list',
    description: 'List the desktop-pet packages on this computer: the built-in ones that ship with the app, plus any the user made. Each line gives the id, name, whether it is built-in, and which animation states it has. Use this when the user asks what pets they have or what their pet looks like, and before writing a pack so you pick an id that is free.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          packs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                builtin: { type: 'boolean' },
                states: { type: 'array', items: { type: 'string' } },
              },

            },
          },
        },
      },
      render: (_args, value) => {
        const packs = Array.isArray(value.packs) ? value.packs : [];
        return [{
          type: 'text',
          text: packs.length === 0
            ? '这台电脑上一个宠物包都还没有。用户想做一只的话，用 pet_pack_write 建一个。'
            : `这台电脑上有 ${packs.length} 只：\n${packs.map(packLine).join('\n')}`,
        }];
      },
    },
    execute: async () => ({
      packs: listPacks().map((pack) => ({
        id: pack.id,
        name: pack.name,
        builtin: pack.builtin,
        states: Object.keys(pack.states),
      })),
    }),
  }));

  scoped.tools.register(defineTool({
    name: 'pet_pack_write',
    description: 'Create or replace a desktop-pet package on this computer, so it shows up on the user\'s phone under Settings → floating pet. Use this whenever the user wants to change their pet, make a new one, or drop in their own artwork. A pack is one directory with a pack.json plus the images it references. States are idle / working / attention / done / error / sleeping, and idle is required; a state you leave out falls back to idle. Pictures are GIF (animated) or PNG (static). Give each picture the PATH of the file on this computer — the host reads it — rather than its bytes; base64 is only for when you already hold the bytes. Existing packs with the same id are replaced wholesale, including a built-in one (warn the user before doing that). You cannot delete packs; that is the user\'s job in Settings.',
    parameters: {
      id: {
        type: 'string',
        description: 'Pack id, also the folder name: 1-64 lowercase letters, digits and dashes, not starting with a dash, e.g. deepy-whale.',
      },
      pack: {
        type: 'object',
        additionalProperties: true,
        description: 'The whole pack.json as an object. Required keys: name and states (with at least idle). Optional: author, license, canvas {w,h}, anchor {x,baseline}, tiers.working [{min,file}] (largest min wins), loop [], sleepAfterMs. Every file named here must be one you pass in files[].',
        properties: {
          name: { type: 'string', description: 'Shown in the picker on the phone.' },
          author: { type: 'string', description: 'Credited in the picker footer. Fill it in whenever the artwork is not yours.' },
          license: { type: 'string', description: 'License note, shown next to the author.' },
          states: {
            type: 'object',
            additionalProperties: true,
            description: 'State name → { file }. Recognised: idle, working, attention, done, error, sleeping. At least idle is required.',
          },
          tiers: {
            type: 'object',
            additionalProperties: true,
            description: 'Optional. tiers.working is [{min, file}]: pick the image by how many conversations are running.',
          },
          loop: { type: 'array', items: { type: 'string' }, description: 'States that loop. Defaults to idle, working, attention.' },
          sleepAfterMs: { type: 'number', description: 'Idle time before switching to sleeping. Only meaningful when the sleeping state exists.' },
        },
      },
      files: {
        type: 'array',
        description: 'The images this pack uses. Each one is written into the pack folder under that name.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true, description: 'File name inside the pack, e.g. idle.gif. Single level, .gif or .png, no slashes.' },
            filePath: { type: 'string', description: 'Absolute path of the picture on this computer. This is the normal way.' },
            base64: { type: 'string', description: 'The image bytes, base64 encoded. Only when you already hold the bytes and have no file to point at.' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          states: { type: 'array', items: { type: 'string' } },
          written: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const lines = [`《${value.name}》存好了，id ${value.id}，状态：${(value.states || []).join(' / ') || 'idle'}。`];
        if (Array.isArray(value.written) && value.written.length > 0) lines.push(`图片已存：${value.written.join('、')}。`);
        if (value.note) lines.push(value.note);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute: async (args) => {
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      if (!ID_RE.test(id)) {
        throw new Error(`"${id}" 不是合法的宠物包 id：只认 1-64 位小写字母、数字与连字符，且不以连字符开头。`);
      }
      // 文件名先收窄一遍再交给库：这样「哪几个名字不合规矩」能在写之前就一趟说清。
      const files = Array.isArray(args.files) ? args.files : [];
      const badNames = files
        .map((item) => (item && typeof item.path === 'string' ? item.path.trim() : ''))
        .filter((name) => !isImageName(name));
      if (badNames.length > 0) {
        throw new Error(`这几个文件名不合规矩：${badNames.map((name) => `"${name}"`).join('、')}。只认单层 .gif / .png（不含斜杠），例如 idle.gif。`);
      }

      let result;
      try {
        result = await writePack({ id, pack: args.pack, files });
      } catch (error) {
        throw new Error(error && error.message ? error.message : '没能写进去。');
      }
      const { pack, rejected, written, overriddenBuiltin } = result;
      const notes = [];
      if (overriddenBuiltin) {
        notes.push(`这个 id 原本有一只内置的宠物，现在被这份盖住了（手机上显示的是新的这只）。内置那份没被改动。`);
      }
      if (rejected.length > 0) {
        notes.push(`这几张没能收进来：${rejected.join('、')}（读不到，或者不是 .gif / .png）。`);
      }
      return {
        id: pack.id,
        name: pack.name,
        states: Object.keys(pack.states),
        written,
        ...(notes.length > 0 ? { note: notes.join('\n') } : {}),
      };
    },
  }));
}

module.exports = { installPetTools };
