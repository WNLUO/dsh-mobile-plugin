'use strict';

/**
 * 给模型的两个工具：读一篇公众号文章、写一篇。
 *
 * ## 为什么要有工具，而不是让它自己往目录里写文件
 *
 * 文章得有一个稳定的编号，用户会照着这个编号跟它说话（「wxa1b2c3d4 这篇改一下」）；还得
 * 有标题、时间这些能列出来的东西。让模型自己拼目录、自己起文件名，这些就全靠它记着，
 * 换个说法就散了。工具负责的正是这几件它记不住的事：编号、放哪儿、怎么写回去。
 *
 * ## 为什么先写标题、后写正文是同一个工具
 *
 * 用户的工作方式是分阶段的：题目定下来就先进列表，内容之后再一段一段补。所以「写」这个
 * 动作本来就是「有就给、没有就不动」——第一次只给标题也成立，之后每次给什么改什么。
 * 没有状态、没有草稿 / 完成之分（用户 2026-11-05：完成了就是完成，没完成就继续改）。
 *
 * ## 能力面的边界
 *
 * 两个工具都只碰这一个库：编号形状卡死、正文大小有上限、图片名不含斜杠。模型给不了任意
 * 路径，也没有「删」——删文章是人的动作，不该由模型顺手做掉。
 */

const { defineTool } = require('@deepseek-ai/dsh-tools');

const {
  writeArticle,
  readArticle,
  listArticles,
  plainTextOf,
  ID_RE,
} = require('./wechat.js');

/** 工具结果里给模型看的一行话：说清编号，它下一轮才引得上。 */
function summaryLine(article, isNew) {
  const parts = [isNew ? '新建' : '更新'];
  parts.push(`《${article.title}》`);
  parts.push(`编号 ${article.id}`);
  parts.push(article.hasBody ? `${article.chars} 字` : '还没有正文');
  return parts.join('，');
}

/**
 * 注册这两个工具。
 *
 * 必须走 `ctx.inject(['tools'], …)`：宿主里 `tools` 是子代理作用域提供的服务，插件这一层
 * 直接读 `ctx.tools` 拿到的是 undefined（见 `phone/tools.js` 那一整段教训）。缺失时静默
 * 跳过，别把整块装配掀掉。
 */
function installWechatTools(ctx) {
  if (typeof ctx.inject !== 'function') return;
  ctx.inject(['tools'], (scoped) => {
    if (!scoped || !scoped.tools || typeof scoped.tools.register !== 'function') return;

    scoped.tools.register(defineTool({
      name: 'wechat_article_read',
      description: 'Read the WeChat official-account articles the user keeps on this computer. Without an id it lists them (title, id, time, character count); with an id it returns that article\'s full HTML source, which is what you edit when the user asks for a revision.',
      parameters: {
        id: {
          type: 'string',
          description: 'Article id (looks like wxa1b2c3d4). Omit to list all articles.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  updatedAt: { type: 'number' },
                  chars: { type: 'number' },
                  hasBody: { type: 'boolean' },
                },
                required: ['id', 'title'],
              },
            },
            article: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                html: { type: 'string' },
                chars: { type: 'number' },
              },
              required: ['id', 'title', 'html'],
            },
          },
        },
        render: (_args, value) => {
          if (value.article) {
            return [{ type: 'text', text: `《${value.article.title}》（${value.article.id}），${value.article.chars} 字，正文源码在下面的 html 字段里。` }];
          }
          const items = Array.isArray(value.items) ? value.items : [];
          return [{
            type: 'text',
            text: items.length === 0
              ? '这个库里还没有文章。'
              : `${items.length} 篇：\n${items.map((row) => `· ${row.id} 《${row.title}》${row.hasBody ? '' : '（还没有正文）'}`).join('\n')}`,
          }];
        },
      },
      execute: async (args) => {
        const id = typeof args.id === 'string' ? args.id.trim() : '';
        if (id) {
          if (!ID_RE.test(id)) throw new Error(`"${id}" 不像一个文章编号（形如 wxa1b2c3d4）。`);
          const article = await readArticle(id);
          if (!article) throw new Error(`没有找到编号为 ${id} 的文章，先用不带 id 的调用列一遍。`);
          return {
            article: {
              id: article.id,
              title: article.title,
              html: article.html,
              chars: article.chars,
            },
          };
        }
        const rows = await listArticles();
        return {
          items: rows.map((row) => ({
            id: row.id,
            title: row.title,
            updatedAt: row.updatedAt,
            chars: row.chars,
            hasBody: row.hasBody,
          })),
        };
      },
    }));

    scoped.tools.register(defineTool({
      name: 'wechat_article_write',
      description: 'Create or update a WeChat official-account article in the library the user browses from their phone. Without an id it creates a new article (a title alone is fine — the user will see it in the list right away and you can fill in the body later). With an id it updates that article: pass only the fields you want to change. The body is finished HTML, not Markdown, and it is rendered as-is — write the styling you want inline. Pictures go in images[] and must be referenced from the HTML as media/<name>; give each one the PATH of the picture file on this computer (not its bytes) and the host copies it into the article folder, so never inline base64 into the HTML.',
      parameters: {
        id: {
          type: 'string',
          description: 'Article id to update. Omit to create a new article.',
        },
        title: {
          type: 'string',
          description: 'Article title. Shown in the list; give it as soon as it is decided.',
        },
        html: {
          type: 'string',
          description: 'The finished article body as HTML (no <html>/<head> wrapper, no Markdown). It is rendered exactly as given. Reference uploaded pictures as media/<name>.',
        },
        images: {
          type: 'array',
          description: 'Pictures used by this body. Each one is copied into the article folder and then reachable in the HTML as media/<name>.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', description: 'File name inside the article folder, e.g. cover.png. Letters, digits, dot, dash, underscore only. Keep the extension in step with the real format.' },
              path: { type: 'string', description: 'Absolute path of the picture file on this computer. This is the normal way: generate or find the picture, then hand over its path.' },
              base64: { type: 'string', description: 'The image bytes, base64 encoded. Only when you already hold the bytes and have no file to point at.' },
            },
            required: ['name'],
          },
        },
        sessionId: {
          type: 'string',
          description: 'The session this article came from. Filled in automatically; leave it out.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            created: { type: 'boolean' },
            chars: { type: 'number' },
            hasBody: { type: 'boolean' },
            images: { type: 'array', items: { type: 'string' } },
            note: { type: 'string' },
          },
          required: ['id', 'title'],
        },
        render: (_args, value) => {
          const lines = [summaryLine({ ...value, chars: value.chars || 0 }, value.created)];
          if (Array.isArray(value.images) && value.images.length > 0) {
            lines.push(`图片已存：${value.images.join('、')}（正文里按 media/<名字> 引用）。`);
          }
          if (value.note) lines.push(value.note);
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      execute: async (args, exec) => {
        // 会话 id 从执行上下文取，不从参数取：模型不该有机会把文章写到别的对话名下。
        const sessionId = (exec && exec.agent && typeof exec.agent.id === 'string') ? exec.agent.id : '';
        const before = typeof args.id === 'string' && args.id.trim() ? await readArticle(args.id.trim()) : null;
        let result;
        try {
          result = await writeArticle({
            id: args.id,
            title: args.title,
            html: args.html,
            images: args.images,
            sessionId,
          });
        } catch (error) {
          const message = error && error.message ? error.message : '没能写进去';
          // 正文里引用了没上传的图：这是真会发生的（模型先写正文、再补图），说清楚让它补一发。
          throw new Error(message);
        }
        const { article, images, rejected } = result;
        const missing = missingMedia(article.html, images);
        const notes = [];
        if (missing.length > 0) {
          notes.push(`正文里引用了还没有的图：${missing.join('、')}。把它们的路径放进 images[] 再调用一次，否则手机上这几张是空的。`);
        }
        if (rejected.length > 0) {
          notes.push(`这几张没能收进来：${rejected.join('、')}（读不到、不是图片，或者名字不合规矩）。`);
        }
        return {
          id: article.id,
          title: article.title,
          created: !before,
          chars: article.chars,
          hasBody: article.hasBody,
          images,
          ...(notes.length > 0 ? { note: notes.join('\n') } : {}),
        };
      },
    }));
  });
}

/**
 * 正文里 `media/<名字>` 引用了、但这次没有上传的图。
 *
 * 只用来提醒：这句提示能省掉一轮「手机上是空图、模型不知道为什么」的往返。图本来就可以
 * 分两次传（先写正文、再补图），所以这不是错误。
 */
function missingMedia(html, uploaded) {
  const have = new Set(uploaded);
  const out = [];
  const seen = new Set();
  for (const match of String(html || '').matchAll(/media\/([A-Za-z0-9][A-Za-z0-9._-]{0,80})/g)) {
    const name = match[1];
    if (have.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

module.exports = { installWechatTools, missingMedia, plainTextOf };
