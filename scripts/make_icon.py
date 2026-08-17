#!/usr/bin/env python3
"""Generate the DeepSeek Desktop app icon: DeepSeek-blue rounded square + white whale
extracted from the official DeepSeek logo (GitHub org avatar)."""
import os
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AVATAR = os.path.join(ROOT, "assets", "ds-avatar-source.png")
OUT = os.path.join(ROOT, "assets", "icon.png")
SIZE = 1024
RADIUS = 228  # macOS 圆角比例 ~22%

# ---------- 1. 提取鲸鱼蒙版 ----------
src = Image.open(AVATAR).convert("RGB")
sw, sh = src.size
mask = Image.new("L", (sw, sh), 0)
sp = src.load()
mp = mask.load()
for y in range(sh):
    for x in range(sw):
        r, g, b = sp[x, y]
        blueness = b - max(r, g)          # 纯蓝≈147，白=0
        mp[x, y] = max(0, min(255, int(blueness / 147 * 255)))

# 鲸鱼 bbox
px = mask.load()
minx, miny, maxx, maxy = sw, sh, -1, -1
for y in range(sh):
    for x in range(sw):
        if px[x, y] > 60:
            if x < minx: minx = x
            if x > maxx: maxx = x
            if y < miny: miny = y
            if y > maxy: maxy = y
whale = mask.crop((minx, miny, maxx + 1, maxy + 1))

# ---------- 2. 背景：橙色渐变圆角方块（与客户端 UI 橙色主题一致，与 DSH 壳的蓝鲸区分） ----------
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
bg = Image.new("RGBA", (SIZE, SIZE))
bd = ImageDraw.Draw(bg)
top = (255, 155, 61, 255)     # 上：#FF9B3D
bottom = (224, 123, 0, 255)   # 下：#E07B00
for y in range(SIZE):
    t = y / (SIZE - 1)
    c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)
    bd.line([(0, y), (SIZE, y)], fill=c)

roundmask = Image.new("L", (SIZE, SIZE), 0)
rd = ImageDraw.Draw(roundmask)
rd.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=RADIUS, fill=255)
img.paste(bg, (0, 0), roundmask)

# 顶部微光，增加质感（alpha_composite 正确叠加，paste 会抹掉背景）
hl = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
hd = ImageDraw.Draw(hl)
hd.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=RADIUS, outline=(255, 255, 255, 40), width=4)
img = Image.alpha_composite(img, hl)

# ---------- 3. 白色鲸鱼（居中，占宽 ~52%） ----------
target_w = int(SIZE * 0.52)
scale = target_w / whale.width
tw, th = int(whale.width * scale), int(whale.height * scale)
whale_s = whale.resize((tw, th), Image.LANCZOS)
whale_s = whale_s.filter(ImageFilter.GaussianBlur(0.6))  # 柔化边缘

white = Image.new("RGBA", (tw, th), (255, 255, 255, 255))
ox = (SIZE - tw) // 2
oy = (SIZE - th) // 2
img.paste(white, (ox, oy), whale_s)

img.save(OUT, "PNG")
print("saved", OUT, img.size)
