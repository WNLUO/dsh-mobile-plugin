#!/usr/bin/env python3
"""内置宠物包的生成脚本：把矢量参数画成一套像素小鲸鱼 GIF。

只在改素材时跑一次，产物提交进仓库（`assets/pets/deepy-whale/`）。不参与构建、不上手机 ——
手机上跑的是已经生成的 GIF，App 与插件都只认 `pack.json`。

画法：全部在 1 倍逻辑像素的画布上按整数坐标画，最后按 `SCALE` 整数倍放大。
这样放大后每个美术像素正好是 `SCALE × SCALE` 的一块，边缘不会糊。

    python3 dsh-mobile-plugin/scripts/build-pet-pack.py
"""

import json
import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "assets", "pets", "deepy-whale")

# 画布与缩放：52×52 的逻辑画布，5 倍放大成 260×260 的图。
W, H = 52, 52
SCALE = 5
# 身体在画布上的位置（逻辑像素）；pack.json 的 contentBox / anchor 都从这里推。
BODY = (12, 26, 36, 22)  # x, y, w, h
BASELINE = 48

# 调色：暗色主题下也看得清的一小套，不跟 App 主题走（宠物是用户自己的素材）。
INK = (43, 50, 69, 255)
BODY_MAIN = (75, 103, 180, 255)
BODY_LIGHT = (110, 145, 214, 255)
BELLY = (222, 234, 255, 255)
EYE = (24, 28, 40, 255)
BLUSH = (232, 138, 158, 255)
SPOUT = (150, 208, 240, 255)
STAR = (255, 214, 102, 255)
WARN = (236, 118, 96, 255)
SHADOW = (150, 164, 194, 255)


def new_frame():
    return Image.new("RGBA", (W, H), (0, 0, 0, 0))


def rect(img, x, y, w, h, color):
    for px in range(x, x + w):
        for py in range(y, y + h):
            if 0 <= px < W and 0 <= py < H:
                img.putpixel((px, py), color)


def ellipse(img, cx, cy, rx, ry, color, only_if_empty=False):
    """按像素中心落在椭圆里就上色 —— 比「画矩形再削角」圆得多。"""
    for py in range(int(cy - ry), int(cy + ry) + 1):
        for px in range(int(cx - rx), int(cx + rx) + 1):
            dx = (px + 0.5 - cx) / rx
            dy = (py + 0.5 - cy) / ry
            if dx * dx + dy * dy > 1.0:
                continue
            if not (0 <= px < W and 0 <= py < H):
                continue
            if only_if_empty and img.getpixel((px, py))[3] != 0:
                continue
            img.putpixel((px, py), color)


def whale(body_y=BODY[1], squish=0, eye="open", blush=False, mouth=None):
    """一只朝右的小鲸鱼；`squish` 是纵向压扁的像素数（呼吸时动）。"""
    img = new_frame()
    cx, cy = 29, body_y + 9 - squish
    rx, ry = 16, 9 - squish * 0.4
    # 阴影：身体下面一道浅影，落在脚线下面，让「站着」有分量。
    ellipse(img, cx - 1, cy + ry - 0.5, 9, 1.2, SHADOW)
    # 尾巴：先在身体左边画两片鳍，部分会被身体盖住，露出来就是翘起的一条。
    ellipse(img, 11, cy - 3, 4.5, 1.6, BODY_MAIN)
    ellipse(img, 12, cy + 3, 4.5, 1.6, BODY_MAIN)
    # 身体。
    ellipse(img, cx, cy, rx, ry, BODY_MAIN)
    # 肚皮：下缘浅色，跟着身体轮廓走。
    ellipse(img, cx + 1, cy + 5.2, rx - 7, 2.8, BELLY)
    # 高光：左上一道弧。
    ellipse(img, cx - 6, cy - 4, 9, 2.2, BODY_LIGHT, only_if_empty=True)
    # 眼睛（右侧，朝右看）。
    ex, ey = cx + 6, cy - 3
    if eye == "open":
        rect(img, ex, ey, 2, 3, EYE)
        img.putpixel((ex, ey), (255, 255, 255, 255))
    elif eye == "happy":
        # 弯成一道弧的笑眼。
        rect(img, ex, ey + 1, 3, 1, EYE)
        img.putpixel((ex - 1, ey), EYE)
        img.putpixel((ex + 3, ey), EYE)
    elif eye == "closed":
        rect(img, ex, ey + 1, 3, 1, EYE)
    # 腮红。
    if blush:
        ellipse(img, ex - 3, ey + 4, 2.6, 1.4, BLUSH, only_if_empty=True)
    # 嘴。
    mx, my = ex + 1, ey + 4
    if mouth == "smile":
        rect(img, mx, my + 1, 3, 1, INK)
        img.putpixel((mx - 1, my), INK)
        img.putpixel((mx + 3, my), INK)
    elif mouth == "flat":
        rect(img, mx, my, 3, 1, INK)
    elif mouth == "wavy":
        rect(img, mx, my, 1, 1, INK)
        rect(img, mx + 1, my + 1, 2, 1, INK)
    return img


def spout(img, height):
    """头顶喷出来的一道水柱，`height` 决定格数。"""
    x = BODY[0] + BODY[2] // 2
    for i in range(height):
        rect(img, x - 1, BODY[1] - 2 - i * 2, 3, 2, SPOUT)


def zzz(img, step):
    for i in range(2):
        zx = BODY[0] + BODY[2] - 6 + i * 5
        zy = BODY[1] - 6 - i * 4 - step
        rect(img, zx, zy, 3, 1, (200, 214, 240, 200))
        rect(img, zx + 2, zy + 1, 1, 1, (200, 214, 240, 200))
        rect(img, zx, zy + 2, 3, 1, (200, 214, 240, 200))


def stars(img, phase):
    for i, (sx, sy) in enumerate(((BODY[0] + 6, BODY[1] - 4), (BODY[0] + 18, BODY[1] - 7))):
        if (phase + i) % 2:
            continue
        rect(img, sx, sy, 1, 3, STAR)
        rect(img, sx - 1, sy + 1, 3, 1, STAR)


def save(frames, name, duration_ms):
    """把一组逻辑像素帧按整数倍放大后存成 GIF。"""
    big = [f.resize((W * SCALE, H * SCALE), Image.NEAREST) for f in frames]
    # 直接把 RGBA 交给 PIL：它会给每帧生成各自的调色板，透明像素走 transparency 索引。
    # 自己先套一张共享调色板反而要多绕一道（RGBA 只能 FASTOCTREE，且套表要求 RGB/L）。
    big[0].save(
        os.path.join(OUT, name),
        save_all=True,
        append_images=big[1:],
        duration=duration_ms,
        loop=0,
        disposal=2,
    )
    print("  ", name, len(big), "帧")


def build():
    os.makedirs(OUT, exist_ok=True)

    # idle：慢呼吸，偶尔眨眼。
    frames = []
    for i in range(8):
        squish = 1 if i in (3, 4) else 0
        eye = "closed" if i == 6 else "open"
        frames.append(whale(squish=squish, eye=eye, mouth="smile"))
    save(frames, "idle.gif", 420)

    # working：身体上下动 + 头顶喷水，表示在干活。
    frames = []
    for i in range(8):
        f = whale(body_y=BODY[1] - (1 if i % 4 in (1, 2) else 0), eye="open", mouth="flat")
        spout(f, 1 + (i % 3))
        frames.append(f)
    save(frames, "working.gif", 160)

    # working-3：三条以上在跑，喷得更猛。
    frames = []
    for i in range(6):
        f = whale(body_y=BODY[1] - (1 if i % 2 else 0), eye="open", mouth="smile")
        spout(f, 2 + (i % 4))
        frames.append(f)
    save(frames, "working-3.gif", 130)

    # attention：等你确认 —— 举起一只手 + 闪星星。
    frames = []
    for i in range(8):
        f = whale(eye="open", blush=True, mouth="smile")
        # 举起的小鳍：从身体右缘长出来，别悬空。
        ellipse(f, 41, BODY[1] + 4 - (i % 2), 3.2, 4.6, BODY_MAIN)
        ellipse(f, 41, BODY[1] + 1 - (i % 2), 1.6, 1.6, BODY_LIGHT)
        stars(f, i)
        frames.append(f)
    save(frames, "attention.gif", 200)

    # done：做完一蹦一蹦，笑眼。
    frames = []
    for i in range(6):
        lift = (0, 2, 4, 2, 0, 0)[i]
        f = whale(body_y=BODY[1] - lift, eye="happy", blush=True, mouth="smile")
        stars(f, i)
        frames.append(f)
    save(frames, "done.gif", 140)

    # error：歪嘴 + 一滴汗，颜色压暗一档。
    frames = []
    for i in range(6):
        f = whale(eye="closed", mouth="wavy")
        rect(f, BODY[0] + BODY[2] - 2, BODY[1] + 4 - (i % 3), 2, 3, WARN)
        frames.append(f)
    save(frames, "error.gif", 260)

    # sleeping：闭眼 + Zzz 飘。
    frames = []
    for i in range(8):
        f = whale(squish=1 if i % 2 else 0, eye="closed", mouth=None)
        zzz(f, i % 4)
        frames.append(f)
    save(frames, "sleeping.gif", 400)

    pack = {
        "schema": 1,
        "id": "deepy-whale",
        "name": "Deepy 小鲸鱼",
        "author": "DSH Mobile",
        "license": "随本项目发布，可自由修改",
        "canvas": {"w": W, "h": H},
        "anchor": {"x": 28, "baseline": BASELINE},
        "states": {
            "idle": {"file": "idle.gif"},
            "working": {"file": "working.gif"},
            "attention": {"file": "attention.gif"},
            "done": {"file": "done.gif"},
            "error": {"file": "error.gif"},
            "sleeping": {"file": "sleeping.gif"},
        },
        "tiers": {
            "working": [
                {"min": 3, "file": "working-3.gif"},
                {"min": 1, "file": "working.gif"},
            ]
        },
        "loop": ["idle", "working", "attention", "sleeping"],
        "sleepAfterMs": 60000,
    }
    with open(os.path.join(OUT, "pack.json"), "w", encoding="utf-8") as fh:
        json.dump(pack, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print("   pack.json")


if __name__ == "__main__":
    build()
