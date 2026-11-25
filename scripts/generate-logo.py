# Логотип Clewmap: буква C из нити в несколько витков, конец уходит к узлу.
# python3 scripts/generate-logo.py  → docs/media/logo.svg, logo-line.svg, logo-line-small.svg
import os
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'docs', 'media'))
import math
def mark(cx, cy, radii, node_off=(174, 62), end_gap=0.0):
    A = 42
    pt = lambda r, d: (cx + r*math.cos(math.radians(d)), cy + r*math.sin(math.radians(d)))
    p = lambda xy: f"{xy[0]:.1f} {xy[1]:.1f}"
    # Последний виток всегда идёт против часовой и кончается внизу справа, у узла.
    # При чётном числе витков намотка начинается снизу, а не сверху.
    flip = len(radii) % 2 == 0
    segs = []
    cur = pt(radii[0], A if flip else -A); segs.append(f"M {p(cur)}")
    for i, r in enumerate(radii):
        ccw = (i % 2 == 0) != flip
        end_deg = A if ccw else -A
        end = pt(r, end_deg)
        segs.append(f"A {r:.1f} {r:.1f} 0 1 {0 if ccw else 1} {p(end)}")
        if i + 1 < len(radii):
            nr = radii[i+1]; u = (r - nr)/2
            nxt = pt(nr, end_deg)
            segs.append(f"A {u:.1f} {u:.1f} 0 0 {0 if ccw else 1} {p(nxt)}")
        cur = end
    node = (cx + node_off[0], cy + node_off[1])
    # хвост от конца последнего витка к узлу; конец хвоста — на краю кольца (end_gap)
    c1 = (cur[0] + 40, cur[1] + 28)
    c2 = (node[0] - 32, node[1] + 28)
    dx, dy = node[0] - c2[0], node[1] - c2[1]; L = math.hypot(dx, dy)
    tip = (node[0] - dx / L * end_gap, node[1] - dy / L * end_gap)
    segs.append(f"C {p(c1)}, {p(c2)}, {p(tip)}")
    return " ".join(segs), node

# Центр: кольцо C на x=250, рамка знака (с толщиной линии слева и узлом справа) ≈ 70…445, середина ≈ 257.
CX, CY = 250, 256
path, node = mark(CX, CY, [168, 126, 84])
open('logo.svg','w').write(f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FAF7F0"/><stop offset="1" stop-color="#EDE7DA"/></linearGradient>
<linearGradient id="th" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#26262B"/><stop offset="1" stop-color="#3D3D45"/></linearGradient>
<radialGradient id="gl"><stop offset="0" stop-color="#FF6B4A" stop-opacity=".5"/><stop offset="1" stop-color="#FF6B4A" stop-opacity="0"/></radialGradient>
</defs>
<rect width="512" height="512" rx="112" fill="url(#bg)"/>
<path d="{path}" fill="none" stroke="url(#th)" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="{node[0]:.1f}" cy="{node[1]:.1f}" r="54" fill="url(#gl)"/>
<circle cx="{node[0]:.1f}" cy="{node[1]:.1f}" r="21" fill="#FF6B4A"/>
</svg>
''')
def line(color, width, ring, radii, name, size=512, node_off=(174, 62)):
    lp, ln = mark(CX, CY, radii, node_off, end_gap=ring)
    open(name,'w').write(f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="48 48 416 416" width="{size}" height="{size}" fill="none" stroke="{color}" stroke-linecap="round" stroke-linejoin="round">
<path d="{lp}" stroke-width="{width}"/>
<circle cx="{ln[0]:.1f}" cy="{ln[1]:.1f}" r="{ring}" stroke-width="{width}"/>
</svg>
''')
line('currentColor', 16, 22, [168, 126, 84], 'logo-line.svg')
# Мелкий размер (значок VS Code, фавикон): два витка, линия толще
line('currentColor', 34, 26, [164, 96], 'logo-line-small.svg', 24, node_off=(170, 60))
