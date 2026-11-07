# 技能 frontmatter 与字段：哪些真会被看到

这份子文档只讲一件事：一份 `SKILL.md` 头部该写什么，以及写进去的字段在宿主与手机端**到底哪个会被用到**。

## 有效的字段

DSH 宿主读取技能元数据后，`skills.list`（手机「/」菜单的数据源）只投影这几个字段：

| 字段 | 是否生效 | 说明 |
|---|---|---|
| `name` | **生效** | 小写英文、数字、连字符（kebab），如 `order-coffee`。必须是斜杠菜单里显示的名字 `/name`，且**与所在目录名一致**。 |
| `description` | **生效** | 一句话说清「什么时候用」。手机菜单只显示它，所有能让用户对上的说法都写进这里。 |
| `whenToUse` | 宿主有，手机不显示 | 桌面/模型侧可用的补充提示；手机菜单不展示、也不透传。 |
| `display` | **不生效** | Mika 的写法；会落进 metadata，但 `skills.list` 与手机菜单都不读它。 |
| `aliases` | **不生效** | 同上。别指望靠它命中用户说法。 |
| `terms` | **不生效** | 同上。 |

结论：**真正决定「以后遇事会不会被用上」的只有 `name` 和 `description`**。Mika 那套 `display/aliases/terms` 可以保留当注释，但不能替代 `description`。

## 可调用的两个开关（一般不用写）

宿主技能带 `modelInvocable` 与 `userInvocable` 两个调用策略。默认两者都为真（既可被模型调用，也出现在人的「/」菜单里）。不写就按默认；除非明确要「只给用户看、不给模型用」，一般不需要动。

## 目录与文件约定

```
.dsh/skills/<name>/
├── SKILL.md            # 必需；frontmatter + 五节正文
├── references/         # 可选；长资料，正文用相对路径引用
└── scripts/            # 可选；能跑的脚本
    └── manifest.json   # 登记脚本：file / runnable / needs
```

- 目录名必须等于 frontmatter 的 `name`。
- 正文里引用附件一律用**相对路径**（如 `references/字段表.md`），不要写绝对路径。
- `scripts/manifest.json` 的形状照 Mika `documents` 的清单：

```json
[
  {"file": "scripts/check_skill.py", "runnable": true, "needs": ["python3"]}
]
```

## 校验

写完用 `scripts/check_skill.py` 自检一遍：frontmatter 有没有 `name`+`description`、五节齐不齐、`name` 是不是 kebab、目录名与 `name` 对不对得上、正文引用的 `references/` 文件在不在。只有标准库，直接 `python3 scripts/check_skill.py <技能目录>` 就能跑。
