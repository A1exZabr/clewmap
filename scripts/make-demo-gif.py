#!/usr/bin/env python3
"""GIF для README из кадров настоящего VS Code: курсор едет к элементу, кликает, кадр сменяется.

Кадры снимает сценарий `gif` в packages/vscode/src/test/demo.ts (по одному на шаг), сюда они приходят
файлами <шаг>.jpg. Курсор и клики дорисовываются здесь: записать экран напрямую нельзя, а так движение
одинаковое при каждой пересборке.

    python3 scripts/make-demo-gif.py <папка с кадрами> docs/media/clewmap-demo.gif
"""
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFont

SRC_W = 1389  # ширина исходного кадра; координаты ниже — в этой системе
W = 1100  # ширина GIF
FPS = 25
CORAL = (255, 107, 74)
BAR = 46

# Сцены: (кадр, подпись, действия). Действия:
#   ('move', x, y, сек)  — курсор плавно едет в точку
#   ('click',)           — нажатие с кольцом
#   ('show', кадр)       — сменить кадр под курсором
#   ('wait', сек)        — пауза
SCENES = [
    ('start', 'Every function gets a one-line summary, its steps and layer stripes', [
        ('wait', 1.4),
    ]),
    ('start', 'Hover a call: summary, layer, callers and callees, straight from the graph', [
        ('move', 238, 216, 0.9), ('wait', 0.35), ('show', 'hover'), ('wait', 2.18),
    ]),
    ('hover', 'Click a lens to see who calls the function', [
        ('move', 552, 164, 0.7), ('show', 'start'), ('wait', 0.25), ('click',), ('show', 'callers'), ('wait', 1.4),
    ]),
    ('start', 'Click the summary: the neighbors graph opens beside the code', [
        ('move', 300, 164, 0.7), ('wait', 0.25), ('click',), ('show', 'graph'), ('wait', 1.72),
    ]),
    ('graph', 'Click a node to jump to that function', [
        ('move', 512, 326, 0.9), ('wait', 0.25), ('click',), ('show', 'pricing'), ('wait', 1.25),
    ]),
    ('pricing', 'Edit it: Clewmap marks the function as ahead of the graph', [
        ('move', 961, 540, 0.9), ('wait', 0.2), ('click',), ('show', 'caret'), ('wait', 0.5),
        ('show', 'typing'), ('wait', 0.35), ('show', 'typed'), ('wait', 0.7), ('show', 'edited'), ('wait', 1.56),
    ]),
    ('edited', 'Commit as usual', [
        ('move', 25, 140, 0.9), ('wait', 0.2), ('click',), ('show', 'scm'), ('wait', 0.5),
        ('move', 300, 110, 0.6), ('wait', 0.1), ('click',), ('show', 'msg11'), ('wait', 0.3), ('show', 'msg23'),
        ('wait', 0.3), ('show', 'msg36'), ('wait', 0.5), ('move', 342, 144, 0.5), ('wait', 0.2), ('click',),
        ('show', 'committed'), ('wait', 1.4),
    ]),
    ('committed', 'The pre-commit hook updated the graph in the same commit', [
        ('move', 25, 268, 0.8), ('wait', 0.2), ('click',), ('show', 'panel'), ('wait', 1.09),
    ]),
    ('panel', 'Impact: what the commit touches, up to three callers away', [
        ('move', 225, 121, 0.7), ('wait', 0.2), ('click',), ('show', 'impact'), ('wait', 2.18),
    ]),
    ('impact', 'The new summary is already in the hover, with the commit that changed it', [
        ('move', 762, 401, 0.9), ('wait', 0.35), ('show', 'summary'), ('wait', 2.65),
    ]),
]
START = (1150, 700)  # откуда курсор въезжает в первом кадре
# Полоса у правого края, где в кадр попадает настоящий указатель мыши (I-beam): его стираем.
POINTER_STRIP = (1375, 60, 1389, 840)

K = W / SRC_W
FONT = ImageFont.truetype('/System/Library/Fonts/SFNS.ttf', 22)


def arrow(scale=1.0):
    """Курсор-стрелка как в macOS: белая с чёрной обводкой и мягкой тенью."""
    ss = 4
    pts = [(0, 0), (0, 16.5), (4, 12.6), (6.8, 19), (9.3, 18), (6.6, 11.7), (12, 11.7)]
    s = 1.25 * scale * ss
    size = int(26 * ss * scale) + 8
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    o = 3 * ss
    d.polygon([(x * s + o + 2 * ss, y * s + o + 2 * ss) for x, y in pts], fill=(0, 0, 0, 70))
    d.polygon([(x * s + o, y * s + o) for x, y in pts], fill=(255, 255, 255, 255), outline=(0, 0, 0, 255), width=int(1.3 * ss))
    return im.resize((size // ss, size // ss), Image.LANCZOS), o / ss


CURSOR, CUR_OFF = arrow(1.3)
CURSOR_DOWN, CUR_OFF_DOWN = arrow(1.15)


def scrub_pointer(im):
    """Стереть светло-серый указатель мыши в полосе у правого края; цветные метки линейки не трогать."""
    x0, y0, x1, y1 = POINTER_STRIP
    px = im.load()
    rows = [
        y for y in range(y0, y1)
        if any(min(px[x, y]) > 120 and max(px[x, y]) - min(px[x, y]) < 40 for x in range(x0, x1))
    ]
    d = ImageDraw.Draw(im)
    for y in rows:
        d.line([(x0, y - 2), (x1, y - 2)], fill=px[x0 - 6, y])
        for dy in range(-2, 3):
            d.line([(x0, y + dy), (x1, y + dy)], fill=px[x0 - 6, min(max(y + dy, 0), im.height - 1)])


def load(folder, name):
    im = Image.open(os.path.join(folder, f'{name}.jpg')).convert('RGB')
    scrub_pointer(im)
    return im.resize((W, round(im.height * W / im.width)), Image.LANCZOS)


def caption_bar(im, text):
    out = Image.new('RGB', (W, im.height + BAR), (16, 17, 20))
    out.paste(im, (0, 0))
    d = ImageDraw.Draw(out)
    tw = d.textlength(text, font=FONT)
    x = (W - tw) / 2
    d.ellipse([x - 22, im.height + 18, x - 12, im.height + 28], fill=CORAL)
    d.text((x, im.height + 11), text, font=FONT, fill=(228, 228, 231))
    return out


def compose(base, pos, down=False, ring=None):
    im = base.copy()
    if ring is not None:
        r, a = ring
        layer = Image.new('RGBA', im.size, (0, 0, 0, 0))
        ImageDraw.Draw(layer).ellipse(
            [pos[0] - r, pos[1] - r, pos[0] + r, pos[1] + r], outline=CORAL + (int(255 * a),), width=4
        )
        layer2 = Image.new('RGBA', im.size, (0, 0, 0, 0))
        ImageDraw.Draw(layer2).ellipse(
            [pos[0] - r * 0.55, pos[1] - r * 0.55, pos[0] + r * 0.55, pos[1] + r * 0.55], fill=CORAL + (int(70 * a),)
        )
        im = Image.alpha_composite(Image.alpha_composite(im.convert('RGBA'), layer2), layer).convert('RGB')
    cur, off = (CURSOR_DOWN, CUR_OFF_DOWN) if down else (CURSOR, CUR_OFF)
    im.paste(cur, (round(pos[0] - off), round(pos[1] - off)), cur)
    return im


def ease(t):
    return 0.5 - 0.5 * math.cos(math.pi * t)


def main():
    folder, out = sys.argv[1], sys.argv[2]
    cache = {}

    def frame(name, text):
        key = (name, text)
        if key not in cache:
            cache[key] = caption_bar(load(folder, name), text)
        return cache[key]

    frames, durations = [], []

    def emit(im, ms):
        if frames and durations and im.tobytes() == frames[-1].tobytes():
            durations[-1] += ms
        else:
            frames.append(im)
            durations.append(ms)

    pos = (START[0] * K, START[1] * K)
    step = round(1000 / FPS)
    for name, text, actions in SCENES:
        bg = name
        for a in actions:
            base = frame(bg, text)
            if a[0] == 'wait':
                emit(compose(base, pos), int(a[1] * 1000))
            elif a[0] == 'show':
                bg = a[1]
            elif a[0] == 'move':
                target = (a[1] * K, a[2] * K)
                n = max(2, round(a[3] * FPS))
                # Лёгкая дуга, как у руки, а не по линейке.
                mx, my = (pos[0] + target[0]) / 2, (pos[1] + target[1]) / 2
                dx, dy = target[0] - pos[0], target[1] - pos[1]
                bend = 0.12
                cx, cy = mx - dy * bend, my + dx * bend
                for i in range(1, n + 1):
                    t = ease(i / n)
                    x = (1 - t) ** 2 * pos[0] + 2 * (1 - t) * t * cx + t * t * target[0]
                    y = (1 - t) ** 2 * pos[1] + 2 * (1 - t) * t * cy + t * t * target[1]
                    emit(compose(base, (x, y)), step)
                pos = target
            elif a[0] == 'click':
                emit(compose(base, pos, down=True), step * 2)
                for i in range(7):
                    t = (i + 1) / 7
                    emit(compose(base, pos, down=i < 1, ring=(8 + 22 * t, 1 - t * 0.85)), step)
        # переход к следующей сцене без склейки: следующая начнётся с того же кадра
    # общая палитра: все фоновые кадры + цвета курсора и кольца
    sheet_items = list(cache.values())
    sheet = Image.new('RGB', (W, sheet_items[0].height * len(sheet_items) + 40))
    for i, im in enumerate(sheet_items):
        sheet.paste(im, (0, i * im.height))
    d = ImageDraw.Draw(sheet)
    for i, c in enumerate([(255, 255, 255), (0, 0, 0), CORAL, (120, 60, 50), (60, 40, 36)]):
        d.rectangle([i * 40, sheet.height - 40, i * 40 + 39, sheet.height], fill=c)
    pal = sheet.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    q = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in frames]
    q[0].save(out, save_all=True, append_images=q[1:], duration=durations, loop=0, optimize=True, disposal=1)
    print(out, os.path.getsize(out) // 1024, 'KB', len(frames), 'frames', round(sum(durations) / 1000, 1), 's')


if __name__ == '__main__':
    main()
