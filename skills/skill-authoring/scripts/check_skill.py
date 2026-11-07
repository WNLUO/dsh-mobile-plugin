#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""技能自检：只读校验一份技能的 SKILL.md 是否可被宿主/手机正确装配。

用法：
    python3 check_skill.py <技能目录>
    python3 check_skill.py <技能目录>/SKILL.md

检查项：
  1. SKILL.md 存在。
  2. 头部有 frontmatter 块，含 name 与 description。
  3. name 是小写 kebab-case。
  4. 目录名与 name 一致（传入的是目录时）。
  5. 正文五节齐全：入口 / 步骤 / 容易出错的地方 / 怎样算办成 / 什么时候停下交给用户。
  6. 正文引用的 references/*.md 相对路径文件存在。
  7. 若存在 scripts/manifest.json，其每项 file 指向的文件存在。

只用标准库；发现问题打印到 stderr 并以非零码退出。
"""

import json
import os
import re
import sys

REQUIRED_SECTIONS = [
    "入口",
    "步骤",
    "容易出错的地方",
    "怎样算办成",
    "什么时候停下交给用户",
]

KEBAB_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
# 正文里引用的 references 相对路径（<参数> 这类占位不会匹配，因为 <> 不在字符集内）
REF_RE = re.compile(r"references/[A-Za-z0-9._/\-]+\.md")


def read_text(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def split_frontmatter(text):
    """返回 (frontmatter_dict, body)。没有合法 frontmatter 时 frontmatter_dict 为 None。"""
    if not text.startswith("---"):
        return None, text
    # 第一行必须是 ---
    lines = text.split("\n")
    if lines[0].strip() != "---":
        return None, text
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        return None, text
    fm_lines = lines[1:end]
    body = "\n".join(lines[end + 1:])
    data = {}
    for raw in fm_lines:
        line = raw.rstrip()
        if not line or line.lstrip().startswith("#"):
            continue
        # 只解析顶层 key: value（缩进行属于上层的嵌套值，忽略）
        if raw[:1].isspace():
            continue
        m = re.match(r"^([A-Za-z0-9_\-]+)\s*:\s*(.*)$", line)
        if not m:
            continue
        key, value = m.group(1), m.group(2).strip()
        # 去掉简单的成对引号
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        data[key] = value
    return data, body


def check(skill_dir, skill_md):
    problems = []
    if not os.path.isfile(skill_md):
        problems.append("找不到 SKILL.md：%s" % skill_md)
        return problems

    text = read_text(skill_md)
    fm, body = split_frontmatter(text)

    if fm is None:
        problems.append("头部没有合法的 frontmatter 块（应以 --- 开头并以 --- 结束）")
        fm = {}

    name = fm.get("name", "").strip()
    description = fm.get("description", "").strip()

    if not name:
        problems.append("frontmatter 缺 name")
    elif not KEBAB_RE.match(name):
        problems.append("name 不是小写 kebab-case：%r（只允许小写字母、数字、连字符）" % name)

    if not description:
        problems.append("frontmatter 缺 description（手机「/」菜单只显示它，必须写）")

    # 目录名与 name 一致
    if skill_dir and name:
        dir_name = os.path.basename(os.path.normpath(skill_dir))
        if dir_name != name:
            problems.append("目录名 %r 与 name %r 不一致（必须相同）" % (dir_name, name))

    # 五节齐全
    headings = set(re.findall(r"^##\s+(.+?)\s*$", body, flags=re.MULTILINE))
    for sec in REQUIRED_SECTIONS:
        if sec not in headings:
            problems.append("缺小节：## %s" % sec)

    # references 引用存在
    referenced = sorted(set(REF_RE.findall(body)))
    for rel in referenced:
        if not os.path.isfile(os.path.join(skill_dir, rel)):
            problems.append("正文引用了不存在的文件：%s" % rel)

    # scripts/manifest.json 的 file 项存在
    manifest_path = os.path.join(skill_dir, "scripts", "manifest.json")
    if os.path.isfile(manifest_path):
        try:
            entries = json.loads(read_text(manifest_path))
        except json.JSONDecodeError as e:
            problems.append("scripts/manifest.json 不是合法 JSON：%s" % e)
            entries = None
        if isinstance(entries, list):
            for idx, item in enumerate(entries):
                if not isinstance(item, dict) or not item.get("file"):
                    problems.append("scripts/manifest.json 第 %d 项缺 file 字段" % idx)
                    continue
                target = os.path.join(skill_dir, item["file"])
                if not os.path.isfile(target):
                    problems.append("manifest 里登记的文件不存在：%s" % item["file"])

    return problems


def main(argv):
    if len(argv) != 2:
        sys.stderr.write("用法：python3 check_skill.py <技能目录 | SKILL.md>\n")
        return 2

    target = argv[1]
    if os.path.isdir(target):
        skill_dir = target
        skill_md = os.path.join(target, "SKILL.md")
    else:
        skill_md = target
        skill_dir = os.path.dirname(os.path.abspath(target))

    problems = check(skill_dir, skill_md)
    if problems:
        sys.stderr.write("检查未通过（%d 个问题）：\n" % len(problems))
        for p in problems:
            sys.stderr.write("  - %s\n" % p)
        return 1

    print("检查通过：%s" % skill_md)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
