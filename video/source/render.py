import json, math, os, sys, random, subprocess
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance, ImageChops

HERE = os.path.dirname(os.path.abspath(__file__))
FD = os.path.join(HERE, '..', 'fonts')
W, H, FPS = 1080, 1920, 30
DUR = 59.0
N = int(DUR * FPS)
GOLD_L, GOLD_M, GOLD_D = (252, 234, 170), (214, 175, 72), (140, 100, 30)
TL = json.load(open(os.path.join(HERE, 'timeline.json')))

def clamp(x, a=0.0, b=1.0): return max(a, min(b, x))
def sm(x): x = clamp(x); return x * x * (3 - 2 * x)
def eout(x): x = clamp(x); return 1 - (1 - x) ** 3
def back(x):
    x = clamp(x); c1 = 1.9; c3 = c1 + 1
    return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2
def ramp(t, a, b): return sm((t - a) / (b - a)) if b > a else float(t >= a)

_fc = {}
def font(name, size):
    k = (name, size)
    if k not in _fc:
        _fc[k] = ImageFont.truetype(os.path.join(FD, name), size, layout_engine=ImageFont.Layout.RAQM)
    return _fc[k]

def text_mask(txt, f, pad=40):
    d = ImageDraw.Draw(Image.new('L', (8, 8)))
    b = d.textbbox((0, 0), txt, font=f, direction='rtl', language='ar')
    m = Image.new('L', (b[2] - b[0] + 2 * pad, b[3] - b[1] + 2 * pad), 0)
    ImageDraw.Draw(m).text((pad - b[0], pad - b[1]), txt, fill=255, font=f, direction='rtl', language='ar')
    return m

def gradient(w, h, cols):
    y = np.linspace(0, 1, h)[:, None]
    stops = np.linspace(0, 1, len(cols))
    out = np.zeros((h, 1, 3))
    for c in range(3):
        out[:, :, c] = np.interp(y, stops, [k[c] for k in cols])
    return Image.fromarray(np.repeat(out, w, axis=1).astype(np.uint8), 'RGB')

GOLD_STOPS = [(255, 246, 200), (240, 205, 110), (200, 150, 50), (245, 215, 130), (160, 115, 35)]

def colorize(mask, kind='gold', glow=0.55, shadow=True, glow_r=14):
    w, h = mask.size
    if kind == 'gold':
        fill = gradient(w, h, GOLD_STOPS)
    else:
        fill = Image.new('RGB', (w, h), kind)
    out = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    if shadow:
        sh = mask.filter(ImageFilter.GaussianBlur(6)).point(lambda v: int(v * 0.85))
        s = Image.new('RGBA', (w, h), (0, 0, 0, 0)); s.putalpha(sh)
        out = Image.alpha_composite(out, ImageChops.offset(s, 0, 5))
    if glow > 0:
        g = mask.filter(ImageFilter.GaussianBlur(glow_r)).point(lambda v: int(min(255, v * glow * 1.6)))
        gl = Image.new('RGBA', (w, h), (230, 180, 70, 0)); gl.putalpha(g)
        out = Image.alpha_composite(out, gl)
    t = fill.convert('RGBA'); t.putalpha(mask)
    return Image.alpha_composite(out, t)

_tc = {}
def text(txt, fname='Tajawal-800.ttf', size=80, kind='gold', glow=0.55, shadow=True):
    k = (txt, fname, size, kind, glow, shadow)
    if k not in _tc:
        _tc[k] = colorize(text_mask(txt, font(fname, size)), kind, glow, shadow)
    return _tc[k]

def paste(base, im, cx, cy, scale=1.0, alpha=1.0, rot=0.0):
    if alpha <= 0.003 or scale <= 0.01: return
    if rot: im = im.rotate(rot, resample=Image.BICUBIC, expand=True)
    if abs(scale - 1) > 1e-3:
        im = im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))), Image.BILINEAR)
    if alpha < 0.999:
        a = im.getchannel('A').point(lambda v: int(v * alpha)); im = im.copy(); im.putalpha(a)
    x, y = int(round(cx - im.width / 2)), int(round(cy - im.height / 2))
    sx0, sy0 = max(0, -x), max(0, -y)
    sx1, sy1 = min(im.width, W - x), min(im.height, H - y)
    if sx1 <= sx0 or sy1 <= sy0: return
    if (sx0, sy0, sx1, sy1) != (0, 0, im.width, im.height):
        im = im.crop((sx0, sy0, sx1, sy1))
    base.alpha_composite(im, (x + sx0, y + sy0))

# ---------------- sources ----------------
def load_src(name, crop=None):
    im = Image.open(os.path.join(HERE, name)).convert('RGB')
    if crop: im = im.crop(crop)
    im = im.resize((im.width * 2, im.height * 2), Image.LANCZOS)
    im = im.filter(ImageFilter.UnsharpMask(radius=2, percent=60, threshold=2))
    im = ImageEnhance.Contrast(im).enhance(1.08)
    return im

SRC = {}
def src(k):
    if k not in SRC:
        if k == 'A': SRC[k] = load_src('imgA.jpg')
        elif k == 'B': SRC[k] = load_src('imgB.jpg')
        elif k == 'C': SRC[k] = load_src('imgC.jpg')
        elif k == 'D': SRC[k] = load_src('imgD.jpg', (0, 0, 1024, 890))
        elif k == 'Bblur':
            b = load_src('imgB.jpg').filter(ImageFilter.GaussianBlur(18))
            SRC[k] = ImageEnhance.Brightness(b).enhance(0.45)
        elif k == 'Cblur':
            b = load_src('imgC.jpg').filter(ImageFilter.GaussianBlur(22))
            SRC[k] = ImageEnhance.Brightness(b).enhance(0.35)
        elif k == 'Dblur':
            b = load_src('imgD.jpg', (0, 0, 1024, 890)).filter(ImageFilter.GaussianBlur(10))
            SRC[k] = ImageEnhance.Brightness(b).enhance(0.42)
    return SRC[k]

def kb(k, cx, cy, ch):
    """crop source (original coords) centered cx,cy with crop height ch -> W x H"""
    im = src(k); s = 2
    cw = ch * W / H
    box = ((cx - cw / 2) * s, (cy - ch / 2) * s, (cx + cw / 2) * s, (cy + ch / 2) * s)
    return im.transform((W, H), Image.EXTENT, box, Image.BILINEAR).convert('RGBA')

def lerp(a, b, x): return a + (b - a) * x
def lerp3(p, q, x): return tuple(lerp(a, b, x) for a, b in zip(p, q))

# ---------------- overlays ----------------
def make_vignette(strength=0.75):
    yy, xx = np.mgrid[0:H, 0:W]
    d = np.sqrt(((xx - W / 2) / (W * 0.62)) ** 2 + ((yy - H / 2) / (H * 0.58)) ** 2)
    a = np.clip((d - 0.55) / 0.7, 0, 1) ** 1.6 * 255 * strength
    v = np.zeros((H, W, 4), np.uint8); v[..., 3] = a.astype(np.uint8)
    return Image.fromarray(v, 'RGBA')

def make_grad_band(top=True, h=700, maxa=220):
    a = np.linspace(maxa, 0, h) if top else np.linspace(0, maxa, h)
    v = np.zeros((H, W, 4), np.uint8)
    if top: v[:h, :, 3] = a[:, None]
    else: v[H - h:, :, 3] = a[:, None]
    return Image.fromarray(v, 'RGBA')

VIG = make_vignette()
TOPB = make_grad_band(True, 760, 215)
BOTB = make_grad_band(False, 900, 235)

def dark(alpha):
    return Image.new('RGBA', (W, H), (0, 0, 0, int(255 * clamp(alpha))))

def glow_spot(r, col):
    s = r * 2
    yy, xx = np.mgrid[0:s, 0:s]
    d = np.sqrt((xx - r) ** 2 + (yy - r) ** 2) / r
    a = np.clip(1 - d, 0, 1) ** 2.2 * 255
    v = np.zeros((s, s, 4), np.uint8); v[..., :3] = col; v[..., 3] = a
    return Image.fromarray(v, 'RGBA')

RED = glow_spot(360, (255, 30, 40)); BLUE = glow_spot(360, (30, 90, 255))
WARM = glow_spot(500, (255, 190, 90)); WHITE = glow_spot(260, (255, 250, 235))

def add_light(base, spot, cx, cy, a, scale=1.0):
    if a <= 0.01: return
    lay = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    paste(lay, spot, cx, cy, scale, a)
    arr = np.asarray(base).astype(np.int16)
    la = np.asarray(lay).astype(np.int16)
    add = (la[..., :3] * la[..., 3:4]) // 255
    arr[..., :3] = np.clip(arr[..., :3] + add, 0, 255)
    base.paste(Image.fromarray(arr.astype(np.uint8), 'RGBA'))

rng = random.Random(7)
PARTS = [(rng.random() * W, rng.random() * H, rng.uniform(1.5, 4.5), rng.uniform(8, 30), rng.random() * 6.28) for _ in range(70)]
def particles(base, t, a=1.0):
    lay = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(lay)
    for (x, y, r, sp, ph) in PARTS:
        yy = (y - t * sp) % H; xx = x + math.sin(t * 0.6 + ph) * 20
        al = int(a * 255 * (0.35 + 0.65 * (0.5 + 0.5 * math.sin(t * 2 + ph))) * 0.7)
        d.ellipse((xx - r, yy - r, xx + r, yy + r), fill=(250, 215, 130, al))
    lay = lay.filter(ImageFilter.GaussianBlur(1.2))
    base.alpha_composite(lay)

# ---------------- icons ----------------
S2 = 2
def outline_of(mask, w):
    big = mask.filter(ImageFilter.MaxFilter(w * 2 + 1))
    return ImageChops.subtract(big, mask)

def finish_icon(m, size):
    m = m.resize((size, size), Image.LANCZOS)
    pad = 40
    mm = Image.new('L', (size + 2 * pad, size + 2 * pad), 0); mm.paste(m, (pad, pad))
    return colorize(mm, 'gold', glow=0.7, shadow=True, glow_r=12)

def draw_scale(d, cx, top, sz, w, tilt=0.0):
    # sz = overall height
    d.line((cx, top + sz * 0.08, cx, top + sz * 0.88), fill=255, width=w)
    d.ellipse((cx - sz * 0.05, top, cx + sz * 0.05, top + sz * 0.1), fill=255)
    d.polygon([(cx - sz * 0.25, top + sz), (cx + sz * 0.25, top + sz), (cx + sz * 0.1, top + sz * 0.88), (cx - sz * 0.1, top + sz * 0.88)], fill=255)
    bl = sz * 0.42; by = top + sz * 0.18
    dy = math.tan(tilt) * bl
    l = (cx - bl, by + dy); r = (cx + bl, by - dy)
    d.line((l, r), fill=255, width=w)
    for (px, py) in (l, r):
        pw = sz * 0.17; ph = sz * 0.36
        d.line((px, py, px - pw, py + ph), fill=255, width=max(2, w // 2))
        d.line((px, py, px + pw, py + ph), fill=255, width=max(2, w // 2))
        d.chord((px - pw - sz * 0.03, py + ph - sz * 0.12, px + pw + sz * 0.03, py + ph + sz * 0.12), 0, 180, fill=255)

def icon_scale(size=420, tilt=0.0):
    c = size * S2; m = Image.new('L', (c, c), 0); d = ImageDraw.Draw(m)
    draw_scale(d, c / 2, c * 0.06, c * 0.88, int(c * 0.035), tilt)
    return finish_icon(m, size)

def icon_car(size=420):
    c = size * S2; m = Image.new('L', (c, c), 0); d = ImageDraw.Draw(m)
    k = c / 400
    body = Image.new('L', (c, c), 0); bd = ImageDraw.Draw(body)
    bd.rounded_rectangle((20 * k, 190 * k, 380 * k, 255 * k), radius=28 * k, fill=255)
    bd.polygon([(70 * k, 200 * k), (125 * k, 135 * k), (265 * k, 132 * k), (330 * k, 200 * k)], fill=255)
    for wx in (105, 295):
        bd.ellipse(((wx - 38) * k, (220 - 38) * k, (wx + 38) * k, (220 + 38) * k), fill=255)
    ol = outline_of(body, int(9 * k))
    m.paste(ol, (0, 0))
    for wx in (105, 295):
        d.ellipse(((wx - 22) * k, (220 - 22) * k, (wx + 22) * k, (220 + 22) * k), outline=255, width=int(9 * k))
    # windows
    d.polygon([(110 * k, 195 * k), (140 * k, 152 * k), (195 * k, 150 * k), (195 * k, 195 * k)], outline=255, width=int(7 * k))
    d.polygon([(210 * k, 195 * k), (210 * k, 150 * k), (258 * k, 150 * k), (300 * k, 195 * k)], outline=255, width=int(7 * k))
    d.rectangle((345 * k, 205 * k, 372 * k, 215 * k), fill=255)
    return finish_icon(m, size)

def icon_brain(size=320):
    c = size * S2; m = Image.new('L', (c, c), 0); k = c / 600
    sh = Image.new('L', (c, c), 0); d = ImageDraw.Draw(sh)
    for (x, y, r) in [(205, 265, 115), (330, 215, 125), (425, 290, 105), (255, 375, 105), (385, 385, 100), (300, 300, 120)]:
        d.ellipse(((x - r) * k, (y - r) * k, (x + r) * k, (y + r) * k), fill=255)
    d.rounded_rectangle((300 * k, 420 * k, 360 * k, 530 * k), radius=20 * k, fill=255)
    m.paste(outline_of(sh, int(10 * k)), (0, 0))
    d2 = ImageDraw.Draw(m); w = int(11 * k)
    d2.arc((260 * k, 120 * k, 360 * k, 470 * k), 280, 80, fill=255, width=w)
    d2.arc((150 * k, 200 * k, 280 * k, 330 * k), 200, 340, fill=255, width=w)
    d2.arc((360 * k, 210 * k, 480 * k, 330 * k), 190, 330, fill=255, width=w)
    d2.arc((190 * k, 330 * k, 300 * k, 430 * k), 160, 300, fill=255, width=w)
    d2.arc((370 * k, 320 * k, 470 * k, 420 * k), 230, 20, fill=255, width=w)
    return finish_icon(m, size)

def icon_hand(size=320):
    c = size * S2; m = Image.new('L', (c, c), 0); k = c / 600
    sh = Image.new('L', (c, c), 0); d = ImageDraw.Draw(sh)
    d.rounded_rectangle((185 * k, 270 * k, 425 * k, 500 * k), radius=70 * k, fill=255)
    for (x, top) in [(190, 130), (250, 95), (310, 105), (370, 145)]:
        d.rounded_rectangle((x * k, top * k, (x + 52) * k, 320 * k), radius=26 * k, fill=255)
    d.line((205 * k, 430 * k, 105 * k, 315 * k), fill=255, width=int(58 * k))
    d.ellipse((76 * k, 286 * k, 134 * k, 344 * k), fill=255)
    d.rounded_rectangle((215 * k, 495 * k, 395 * k, 560 * k), radius=12 * k, fill=255)
    m.paste(outline_of(sh, int(10 * k)), (0, 0))
    d2 = ImageDraw.Draw(m)
    # evidence tag in palm
    d2.rounded_rectangle((250 * k, 330 * k, 360 * k, 430 * k), radius=12 * k, outline=255, width=int(9 * k))
    d2.line((250 * k, 355 * k, 360 * k, 355 * k), fill=255, width=int(9 * k))
    return finish_icon(m, size)

def icon_doc(size=320):
    c = size * S2; m = Image.new('L', (c, c), 0); k = c / 600; d = ImageDraw.Draw(m); w = int(11 * k)
    d.polygon([(150 * k, 70 * k), (380 * k, 70 * k), (450 * k, 140 * k), (450 * k, 530 * k), (150 * k, 530 * k)], outline=255, width=w)
    d.line((380 * k, 70 * k, 380 * k, 140 * k, 450 * k, 140 * k), fill=255, width=w)
    for i, y in enumerate((180, 230, 280)):
        d.line((195 * k, y * k, (405 if i else 340) * k, y * k), fill=255, width=int(9 * k))
    draw_scale(d, 300 * k, 320 * k, 175 * k, int(8 * k), 0.0)
    return finish_icon(m, size)

def medallion(icon, size=300):
    c = size * S2; m = Image.new('L', (c, c), 0); d = ImageDraw.Draw(m)
    d.ellipse((10, 10, c - 10, c - 10), outline=255, width=int(c * 0.022))
    d.ellipse((c * 0.07, c * 0.07, c * 0.93, c * 0.93), outline=255, width=int(c * 0.006))
    ring = finish_icon(m, size)
    bg = Image.new('RGBA', ring.size, (0, 0, 0, 0))
    ImageDraw.Draw(bg).ellipse((50, 50, ring.width - 50, ring.height - 50), fill=(18, 14, 8, 230))
    out = Image.alpha_composite(bg, ring)
    ic = icon.resize((int(size * 0.78), int(size * 0.78)), Image.LANCZOS)
    out.alpha_composite(ic, ((out.width - ic.width) // 2, (out.height - ic.height) // 2))
    return out

def bag_img(size=200):
    c = size * 2; im = Image.new('RGBA', (c, c), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.rounded_rectangle((c * .15, c * .12, c * .85, c * .9), radius=c * .06, fill=(225, 232, 240, 150), outline=(255, 255, 255, 235), width=8)
    d.rectangle((c * .15, c * .12, c * .85, c * .2), fill=(220, 40, 40, 200))
    d.line((c * .15, c * .2, c * .85, c * .2), fill=(255, 255, 255, 220), width=5)
    pw = Image.new('RGBA', (c, c), (0, 0, 0, 0)); pd = ImageDraw.Draw(pw)
    pd.chord((c * .18, c * .45, c * .82, c * 1.05), 180, 360, fill=(250, 250, 248, 255))
    pd.rectangle((c * .18, c * .74, c * .82, c * .87), fill=(250, 250, 248, 255))
    pw = pw.filter(ImageFilter.GaussianBlur(3))
    im = Image.alpha_composite(im, pw)
    d = ImageDraw.Draw(im)
    d.line((c * .25, c * .28, c * .3, c * .8), fill=(255, 255, 255, 150), width=8)
    return im.resize((size, size), Image.LANCZOS)

def folder_frame(p, size=640):
    """p: 0 open .. 1 closed"""
    w, h = size, int(size * 0.78)
    im = Image.new('RGBA', (int(w * 2.2), h + 80), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    hx = im.width // 2 - w // 2; top = 40  # hinge at left edge of back panel
    # back panel
    d.rounded_rectangle((hx, top, hx + w, top + h), radius=18, fill=(40, 30, 18, 255), outline=(214, 175, 72, 255), width=5)
    d.rounded_rectangle((hx + w * 0.55, top - 28, hx + w * 0.92, top + 10), radius=10, fill=(40, 30, 18, 255), outline=(214, 175, 72, 255), width=5)
    # papers
    for i in range(3):
        o = i * 10
        d.rectangle((hx + 40 + o, top + 30 + o, hx + w - 50 + o, top + h - 30 + o), fill=(236 - i * 12, 228 - i * 12, 210 - i * 12, 255))
    for j in range(7):
        y = top + 90 + j * 52
        d.line((hx + 90, y, hx + w - 90, y), fill=(150, 140, 120, 255), width=6)
    ang = math.pi * (1 - p)
    cs = math.cos(ang)
    xe = hx + w * cs
    persp = math.sin(ang) * 40
    if abs(cs) > 0.02:
        poly = [(hx, top), (xe, top - persp), (xe, top + h + persp), (hx, top + h)]
        col = (58, 42, 22, 255) if cs > 0 else (85, 65, 38, 255)
        shade = int(30 * (1 - abs(cs)))
        col = (col[0] - shade, col[1] - shade, col[2] - shade, 255)
        d.polygon(poly, fill=col, outline=(214, 175, 72, 255), width=5)
        if cs > 0.6:
            a = (cs - 0.6) / 0.4
            inner = [(hx + 18 * cs, top + 18), (xe - 18 * cs, top - persp + 18), (xe - 18 * cs, top + h + persp - 18), (hx + 18 * cs, top + h - 18)]
            d.polygon(inner, outline=(214, 175, 72, int(255 * a)), width=3)
    return im, (hx + w / 2, top + h / 2)

# --------------- subtitles -----------------
SUPPRESS = {4, 5, 10, 11, 12}
def chunks_for(line):
    txt = line['text'].replace('!', '').replace(':', '')
    parts = []
    for seg in txt.replace('،', '،|').split('|'):
        seg = seg.strip()
        if not seg: continue
        words = seg.split()
        if len(seg) > 34:
            cur = []
            for wd in words:
                if len(' '.join(cur + [wd])) > 30 and cur:
                    parts.append(' '.join(cur)); cur = []
                cur.append(wd)
            if cur:
                if len(' '.join(cur)) < 10 and parts: parts[-1] += ' ' + ' '.join(cur)
                else: parts.append(' '.join(cur))
        else:
            parts.append(seg)
    # merge very short chunks
    merged = []
    for p in parts:
        if merged and (len(p) < 9 or len(merged[-1]) < 9) and len(merged[-1]) + len(p) < 36:
            merged[-1] += ' ' + p
        else: merged.append(p)
    weights = [len(p) + (6 if p.endswith('،') else 0) for p in merged]
    tot = sum(weights); t = line['start']; dur = line['stop'] - line['start']
    out = []
    for p, wgt in zip(merged, weights):
        e = t + dur * wgt / tot
        out.append([p, t, e]); t = e
    return out

SUBS = []
for i, l in enumerate(TL):
    if i in SUPPRESS: continue
    cs = chunks_for(l)
    for j, c in enumerate(cs):
        if j == len(cs) - 1:
            nxt = TL[i + 1]['start'] if i + 1 < len(TL) else c[2] + 0.3
            c[2] = min(nxt, c[2] + 0.35)
    SUBS.extend(cs)

_sc = {}
def sub_img(txt):
    if txt not in _sc:
        f = font('Tajawal-700.ttf', 62)
        m = text_mask(txt, f, pad=12)
        t = colorize(m, (255, 255, 255), glow=0, shadow=True)
        bw, bh = t.width + 70, t.height + 30
        box = Image.new('RGBA', (bw, bh), (0, 0, 0, 0)); bd = ImageDraw.Draw(box)
        bd.rounded_rectangle((0, 0, bw - 1, bh - 1), radius=26, fill=(8, 6, 4, 170), outline=(214, 175, 72, 200), width=3)
        box.alpha_composite(t, ((bw - t.width) // 2, (bh - t.height) // 2 + 2))
        _sc[txt] = box
    return _sc[txt]

def draw_subs(base, t):
    for (txt, a, b) in SUBS:
        if a - 0.05 <= t < b:
            al = min(ramp(t, a - 0.05, a + 0.12), 1 - ramp(t, b - 0.12, b))
            pop = 0.94 + 0.06 * eout((t - a + 0.05) / 0.25)
            paste(base, sub_img(txt), W / 2, 1450, pop, al)

# ---------------- scenes ----------------
def lightbar(base, t, pts, a=1.0, sc=0.8):
    ph = (t * 3.2) % 1.0
    r = 1.0 if ph < 0.5 else 0.15; b = 0.15 if ph < 0.5 else 1.0
    flick = 0.85 + 0.15 * math.sin(t * 40)
    for (x, y, col) in pts:
        add_light(base, RED if col == 'r' else BLUE, x, y, a * flick * (r if col == 'r' else b), sc)

def scene1(t):
    # checkpoint (cartoon image D)  0 - 7.2
    p = t / 7.2
    ch = lerp(890, 700, sm(p)); cx = lerp(560, 560, p); cy = lerp(445, 420, sm(p))
    f = kb('D', cx, cy, ch)
    # map image light positions -> screen
    def m(px, py):
        cw = ch * W / H
        return ((px - (cx - cw / 2)) / cw * W, (py - (cy - ch / 2)) / ch * H)
    lb = [(*m(615, 205), 'b'), (*m(745, 210), 'r')]
    lightbar(f, t, lb, 0.75, 0.75)
    ph = (t * 3.2) % 1.0
    add_light(f, RED if ph < 0.5 else BLUE, 0 if ph < 0.5 else W, H * 0.3, 0.35, 2.4)
    f.alpha_composite(TOPB); f.alpha_composite(BOTB); f.alpha_composite(VIG)
    # title
    a = min(ramp(t, 0.15, 0.7), 1 - ramp(t, 3.9, 4.5))
    if a > 0:
        tag = text('توعية قانونية', 'Tajawal-700.ttf', 44, (20, 14, 6), 0, False)
        pill = Image.new('RGBA', (tag.width + 10, tag.height - 30), (0, 0, 0, 0))
        ImageDraw.Draw(pill).rounded_rectangle((0, 0, pill.width - 1, pill.height - 1), radius=pill.height // 2, fill=GOLD_M)
        pill.alpha_composite(tag, (5, -15))
        paste(f, pill, W / 2, 230, 1, a)
        paste(f, text('هل وجود مخدرات في سيارتك', 'Tajawal-800.ttf', 78), W / 2, 345 + 30 * (1 - eout((t - 0.2) / 0.6)), 1, a)
        paste(f, text('يعني إدانتك؟', 'Tajawal-800.ttf', 118), W / 2, 470 + 40 * (1 - eout((t - 0.35) / 0.6)), back((t - 0.35) / 0.6) * 0.15 + 0.85 if t < 1 else 1, a)
    return f

def scene2(t):
    # search (image A) 6.9 - 17.2 ; t local from 0
    T = t + 6.9
    # camera: start on officer, pan along beam to seat, push-in to bag
    if T < 10.2:
        p = sm((T - 6.9) / 3.3)
        cx, cy, ch = lerp(300, 470, p), lerp(380, 420, p), lerp(740, 640, p)
    else:
        p = eout((T - 10.2) / 1.6)
        cx, cy, ch = lerp(470, 540, p), lerp(420, 455, p), lerp(640, 330, p)
    if T > 12.3:
        cx += math.sin(T * 1.3) * 3
    f = kb('A', cx, cy, ch)
    cw = ch * W / H
    def m(px, py): return ((px - (cx - cw / 2)) / cw * W, (py - (cy - ch / 2)) / ch * H)
    sc = 740 / ch
    lightbar(f, T, [(*m(60, 210), 'b'), (*m(20, 212), 'r'), (*m(860, 185), 'r'), (*m(990, 185), 'b')], 0.6, 0.55 * sc)
    # bag discovery
    if T > 9.3:
        ba = ramp(T, 9.3, 10.0)
        bx, by = m(540, 470)
        add_light(f, WHITE, bx, by, 0.55 * ba, 0.9 * sc)
        bimg = bag_img(int(95 * sc))
        shd = Image.new('RGBA', bimg.size, (0, 0, 0, 0)); shd.putalpha(bimg.getchannel('A').filter(ImageFilter.GaussianBlur(8)))
        paste(f, shd, bx + 8, by + 10, 1, ba * 0.8, rot=-12)
        paste(f, bimg, bx, by, 1, ba, rot=-12)
        if T > 10.6:
            ring = ramp(T, 10.6, 11.4)
            rr = int(90 * sc)
            r = Image.new('RGBA', (rr * 2 + 20, rr * 2 + 20), (0, 0, 0, 0))
            ImageDraw.Draw(r).ellipse((10, 10, rr * 2 + 10, rr * 2 + 10), outline=GOLD_M + (255,), width=6)
            paste(f, r, bx, by, 0.8 + 0.2 * eout(ring), ring * (1 - ramp(T, 12.2, 12.6)))
    f.alpha_composite(TOPB); f.alpha_composite(BOTB); f.alpha_composite(VIG)
    if T > 9.6 and T < 12.4:
        a = min(ramp(T, 9.7, 10.1), 1 - ramp(T, 12.0, 12.4))
        paste(f, text('مادة مخدرة داخل السيارة', 'Tajawal-800.ttf', 70), W / 2, 330, 1, a)
    # dramatic question
    if T > 12.3:
        da = ramp(T, 12.3, 12.9)
        f.alpha_composite(dark(0.62 * da))
        qp = (T - 12.45) / 0.5
        if qp > 0:
            q = text('؟', 'Tajawal-800.ttf', 520, 'gold', 0.9)
            pulse = 1 + 0.03 * math.sin(T * 5)
            paste(f, q, W / 2, 820, back(qp) * pulse, clamp(qp * 2))
        if T > 12.4:
            paste(f, text('هنا السؤال المهم', 'Tajawal-700.ttf', 60, (255, 255, 255), 0, True), W / 2, 380, 1, ramp(T, 12.4, 12.8))
        if T > 14.1:
            p = (T - 14.1) / 0.5
            paste(f, text('هل تُدان لمجرد أن', 'Tajawal-800.ttf', 84), W / 2, 1180 + 30 * (1 - eout(p)), 1, clamp(p * 1.5))
            p2 = (T - 14.6) / 0.5
            paste(f, text('السيارة باسمك؟', 'Tajawal-800.ttf', 104), W / 2, 1310 + 30 * (1 - eout(p2)), 1, clamp(p2 * 1.5))
    return f

def legal_bg(t, key='Bblur', drift=0.0):
    im = src(key)
    ow, oh = im.width / 2, im.height / 2
    ch = oh * (0.95 - 0.05 * drift)
    return kb(key, ow / 2 + math.sin(t * 0.2) * 20, oh / 2, ch)

CAR = None; SCALE = {}; Q = None
def scene3(t):
    global CAR
    T = t + 16.9
    f = legal_bg(T, 'Bblur', clamp((T - 16.9) / 10))
    particles(f, T, 0.8)
    f.alpha_composite(VIG)
    if T < 19.2:
        a = min(ramp(T, 16.95, 17.3), 1 - ramp(T, 18.9, 19.25))
        paste(f, text('الجواب', 'Tajawal-700.ttf', 70, (255, 255, 255), 0, True), W / 2, 700, 1, a)
        p = (T - 17.35) / 0.55
        paste(f, text('مو بالضرورة', 'Tajawal-800.ttf', 150, 'gold', 0.9), W / 2, 880, back(p) if p < 1 else 1, a * clamp(p * 2))
        # gold underline
        lw = int(620 * eout((T - 17.7) / 0.6))
        if lw > 4:
            ln = Image.new('RGBA', (lw, 8), GOLD_M + (255,)); paste(f, ln, W / 2, 1000, 1, a)
    else:
        if CAR is None: CAR = icon_car(440)
        tilt = 0.18 * math.sin(T * 1.6)
        key = round(tilt, 2)
        if key not in SCALE: SCALE[key] = icon_scale(400, key)
        a_out = 1 - ramp(T, 26.9, 27.3)
        pc = eout((T - 19.3) / 0.8)
        paste(f, CAR, W - 260 + 300 * (1 - pc), 760, 1, clamp((T - 19.3) * 3) * a_out)
        ps = eout((T - 19.8) / 0.8)
        paste(f, SCALE[key], 260 - 300 * (1 - ps), 740, 1, clamp((T - 19.8) * 3) * a_out)
        qp = (T - 20.4) / 0.5
        if qp > 0:
            paste(f, text('؟', 'Tajawal-800.ttf', 260, 'gold', 0.9), W / 2, 740, back(qp) * (1 + 0.04 * math.sin(T * 4)), clamp(qp * 2) * a_out)
        paste(f, text('وجود المادة في السيارة', 'Tajawal-700.ttf', 62, (255, 255, 255), 0, True), W / 2, 420, 1, ramp(T, 19.4, 19.9) * a_out)
        if T > 21.0:
            p = (T - 21.6) / 0.5
            paste(f, text('لا يعني تلقائيًا', 'Tajawal-800.ttf', 66, 'gold', 0.5), W / 2, 1060, 1, ramp(T, 21.5, 22.0) * a_out)
            paste(f, text('ثبوت الحيازة الجنائية', 'Tajawal-800.ttf', 86, 'gold', 0.7), W / 2, 1170 + 25 * (1 - eout(p)), 1, ramp(T, 22.0, 22.5) * a_out)
    return f

MEDS = None
def scene4(t):
    global MEDS
    T = t + 27.0
    if MEDS is None:
        MEDS = [medallion(icon_hand(300), 250), medallion(icon_brain(300), 250), medallion(icon_doc(300), 250)]
    f = legal_bg(T, 'Cblur')
    particles(f, T, 0.7)
    f.alpha_composite(VIG)
    a_out = 1 - ramp(T, 35.1, 35.45)
    hp = (T - 27.2) / 0.6
    paste(f, text('ما الذي يُنظر فيه؟', 'Tajawal-800.ttf', 76), W / 2, 300 + 20 * (1 - eout(hp)), 1, clamp(hp * 1.5) * a_out)
    paste(f, text('الأدلة والقرائن بحسب ظروف القضية', 'Tajawal-500.ttf', 44, (235, 225, 200), 0, True), W / 2, 395, 1, ramp(T, 27.6, 28.2) * a_out)
    items = [(30.2, 'الحيازة', 'صلتك بالمادة'), (31.9, 'العلم', 'علمك بوجودها'), (33.6, 'القصد الجنائي', 'توافر القصد الجنائي')]
    for i, (st, lab, sub) in enumerate(items):
        y = 610 + i * 300
        p = (T - st) / 0.55
        if p <= 0: continue
        al = clamp(p * 2) * a_out
        # connector line
        mx = W - 230
        paste(f, MEDS[i], mx + 120 * (1 - eout(p)), y, back(p) * 0.9 if p < 1 else 0.9, al)
        lp = (T - st - 0.15) / 0.5
        tx = W - 420
        lab_im = text(lab, 'Tajawal-800.ttf', 86)
        paste(f, lab_im, tx - lab_im.width / 2 + 60 - 40 * (1 - eout(lp)), y - 30, 1, clamp(lp * 2) * a_out)
        sub_im = text(sub, 'Tajawal-500.ttf', 44, (230, 222, 205), 0, True)
        paste(f, sub_im, tx - sub_im.width / 2 + 60 - 40 * (1 - eout(lp)), y + 55, 1, clamp(lp * 2) * a_out)
        # active highlight
        act = 1.0 if (i == 2 and T > st) or (st <= T < items[i + 1][0] if i < 2 else False) else 0.0
        if act:
            add_light(f, WARM, mx, y, 0.18, 0.5)
    return f

def card(lines, w=880):
    t1 = text(lines[0], 'Tajawal-500.ttf', 46, (230, 222, 205), 0, False)
    t2 = text(lines[1], 'Tajawal-800.ttf', 70, 'gold', 0.4, False)
    h = 210
    c = Image.new('RGBA', (w, h), (0, 0, 0, 0)); d = ImageDraw.Draw(c)
    d.rounded_rectangle((0, 0, w - 1, h - 1), radius=28, fill=(12, 9, 5, 215), outline=GOLD_M + (255,), width=3)
    d.rectangle((w - 14, 30, w - 8, h - 30), fill=GOLD_M + (255,))
    c.alpha_composite(t1, (w - 60 - t1.width + 40, 8))
    c.alpha_composite(t2, (w - 60 - t2.width + 40, 70))
    return c

_cards = {}
def scene4b(t):
    T = t + 35.1
    p = clamp((T - 35.1) / 6.5)
    f = kb('D', lerp(560, 610, p), lerp(400, 380, p), lerp(620, 470, sm(p)))
    f.alpha_composite(dark(0.45)); f.alpha_composite(TOPB); f.alpha_composite(BOTB); f.alpha_composite(VIG)
    items = [(35.4, ('السيارة', 'ملكك')), (37.1, ('لكن المادة', 'تخص شخصًا آخر')), (39.4, ('وأنت', 'لا علم لك بوجودها'))]
    for i, (st, ln) in enumerate(items):
        if ln not in _cards: _cards[ln] = card(ln)
        q = (T - st) / 0.5
        if q <= 0: continue
        paste(f, _cards[ln], W / 2 + 150 * (1 - eout(q)), 330 + i * 250, 1, clamp(q * 2) * (1 - ramp(T, 41.3, 41.65)))
    return f

def scene5a(t):
    T = t + 41.3
    p = clamp((T - 41.3) / 6.5)
    f = kb('C', 512, lerp(560, 520, p), lerp(1000, 760, sm(p)))
    f.alpha_composite(TOPB); f.alpha_composite(BOTB); f.alpha_composite(VIG)
    add_light(f, WARM, W / 2, 950, 0.12 + 0.05 * math.sin(T * 2), 1.2)
    particles(f, T, 0.5)
    pan = Image.new('RGBA', (900, 380), (0, 0, 0, 0))
    ImageDraw.Draw(pan).rounded_rectangle((0, 0, 899, 379), radius=30, fill=(8, 6, 4, 200), outline=GOLD_M + (200,), width=3)
    paste(f, pan, W / 2, 390, 1, ramp(T, 41.4, 41.9))
    hp = (T - 41.7) / 0.6
    paste(f, text('دور الدفاع', 'Tajawal-800.ttf', 110, 'gold', 0.8), W / 2, 300 + 25 * (1 - eout(hp)), 1, clamp(hp * 1.5))
    for i, (st, s) in enumerate([(43.6, 'مناقشة الأدلة'), (45.4, 'مدى الصلة بالمضبوطات')]):
        q = (T - st) / 0.5
        if q > 0:
            im = text('◆  ' + s if False else s, 'Tajawal-700.ttf', 58, (255, 255, 255), 0, True)
            paste(f, im, W / 2, 450 + i * 85 + 15 * (1 - eout(q)), 1, clamp(q * 2))
    return f

def scene5b(t):
    T = t + 47.5
    f = legal_bg(T, 'Bblur')
    f.alpha_composite(dark(0.3))
    particles(f, T, 0.8)
    f.alpha_composite(VIG)
    paste(f, text('وتذكّر دائمًا', 'Tajawal-700.ttf', 66, (255, 255, 255), 0, True), W / 2, 330, 1, min(ramp(T, 47.8, 48.2), 1 - ramp(T, 52.7, 53.1)))
    # folder closes 47.9 - 49.0, then shrinks up
    cp = sm((T - 47.9) / 1.0)
    fim, _ = folder_frame(cp, 560)
    fy = 780; fs = 1.0
    if T > 49.2:
        k = eout((T - 49.2) / 0.6); fy = lerp(780, 610, k); fs = lerp(1.0, 0.55, k)
    if cp > 0.99:
        lab = text('ملف القضية', 'Tajawal-800.ttf', 52)
        fim = fim.copy(); fim.alpha_composite(lab, (fim.width // 2 - lab.width // 2, 40 + int(560 * 0.78) // 2 - lab.height // 2))
    paste(f, fim, W / 2, fy, fs, ramp(T, 47.5, 47.9) * (1 - ramp(T, 52.7, 53.1)))
    a_out = 1 - ramp(T, 52.75, 53.15)
    p1 = (T - 49.45) / 0.5
    if p1 > 0:
        paste(f, text('الاشتباه شيء', 'Tajawal-800.ttf', 104, (255, 255, 255), 0.0, True), W / 2, 960 + 25 * (1 - eout(p1)), 1, clamp(p1 * 2) * a_out)
    p2 = (T - 50.75) / 0.55
    if p2 > 0:
        paste(f, text('وثبوت الإدانة', 'Tajawal-800.ttf', 116, 'gold', 0.9), W / 2, 1110 + 25 * (1 - eout(p2)), back(p2) if p2 < 1 else 1, clamp(p2 * 2) * a_out)
        paste(f, text('شيء آخر', 'Tajawal-800.ttf', 116, 'gold', 0.9), W / 2, 1250 + 25 * (1 - eout(p2 - 0.3)), 1, clamp((p2 - 0.3) * 2) * a_out)
    return f

EMB = None
def scene6(t):
    global EMB
    T = t + 52.9
    if EMB is None:
        EMB = medallion(icon_scale(300, 0.0), 330)
    f = Image.new('RGBA', (W, H), (6, 5, 4, 255))
    add_light(f, WARM, W / 2, 760, 0.22, 1.6)
    particles(f, T, 0.9)
    f.alpha_composite(VIG)
    ep = (T - 53.1) / 0.8
    paste(f, EMB, W / 2, 600, (0.7 + 0.3 * back(ep)) if ep < 1 else 1, clamp(ep * 1.5))
    # gold lines
    lw = int(700 * eout((T - 53.6) / 0.8))
    if lw > 4:
        paste(f, Image.new('RGBA', (lw, 4), GOLD_M + (255,)), W / 2, 830, 1, 1)
        paste(f, Image.new('RGBA', (lw, 4), GOLD_M + (255,)), W / 2, 1250, 1, 1)
    n1 = (T - 53.3) / 0.6
    paste(f, text('مكتب المحامي', 'Tajawal-700.ttf', 64, (240, 232, 215), 0, True), W / 2, 920, 1, clamp(n1 * 2))
    n2 = (T - 53.8) / 0.7
    name = text('محمد إبراهيم الشهراني', 'Amiri-700.ttf', 104, 'gold', 0.8)
    paste(f, name, W / 2, 1050 + 20 * (1 - eout(n2)), 1, clamp(n2 * 2))
    n3 = (T - 55.6) / 0.6
    paste(f, text('للمحاماة والاستشارات القانونية', 'Tajawal-700.ttf', 58, 'gold', 0.3), W / 2, 1180, 1, clamp(n3 * 2))
    n4 = (T - 57.0) / 0.6
    paste(f, text('محتوى توعوي عام ولا يُغني عن الاستشارة القانونية', 'Tajawal-500.ttf', 34, (170, 160, 140), 0, False), W / 2, 1380, 1, clamp(n4 * 2))
    # shimmer sweep
    sp = (T - 55.0) / 1.2
    if 0 < sp < 1:
        add_light(f, WHITE, lerp(-100, W + 100, sp), 1050, 0.25, 0.8)
    return f

SCENES = [(0.0, 7.2, scene1), (6.9, 17.2, scene2), (16.9, 27.3, scene3), (27.0, 35.45, scene4),
          (35.1, 41.65, scene4b), (41.3, 47.8, scene5a), (47.5, 53.2, scene5b), (52.9, 59.01, scene6)]
FLASH = [16.95, 27.05]

NOISE = None
def frame(i):
    global NOISE
    if NOISE is None:
        r = np.random.default_rng(3)
        NOISE = [r.normal(0, 7, (H // 2, W // 2, 1)).astype(np.int16) for _ in range(6)]
    t = i / FPS
    act = [(a, b, fn) for (a, b, fn) in SCENES if a <= t < b]
    imgs = []
    for (a, b, fn) in act:
        imgs.append((fn(t - a), a, b))
    if len(imgs) == 1:
        out = imgs[0][0]
    else:
        (i1, a1, b1), (i2, a2, b2) = imgs[0], imgs[1]
        x = sm((t - a2) / (b1 - a2))
        # zoom-blend transition
        z = 1 + 0.06 * x
        i1 = i1.resize((int(W * z), int(H * z)), Image.BILINEAR).crop((int((W * z - W) / 2), int((H * z - H) / 2), int((W * z - W) / 2) + W, int((H * z - H) / 2) + H))
        out = Image.blend(i1, i2, x)
    draw_subs(out, t)
    arr = np.asarray(out.convert('RGB')).astype(np.int16)
    for fl in FLASH:
        if fl - 0.05 < t < fl + 0.45:
            k = 1 - clamp((t - fl) / 0.45)
            arr = arr + np.array([255, 215, 140]) * 0.55 * k
    if t < 0.4: arr = arr * (t / 0.4)
    n = NOISE[i % 6]
    n = np.repeat(np.repeat(n, 2, 0), 2, 1)
    arr = np.clip(arr + n, 0, 255).astype(np.uint8)
    return arr.tobytes()

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'still':
        for ts in sys.argv[2:]:
            i = int(float(ts) * FPS)
            Image.frombytes('RGB', (W, H), frame(i)).save(os.path.join(HERE, f'still_{ts}.jpg'), quality=85)
        sys.exit()
    from multiprocessing import Pool
    out = os.path.join(HERE, 'video_noaudio.mp4')
    p = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                          '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', out], stdin=subprocess.PIPE)
    with Pool(4) as pool:
        for k, b in enumerate(pool.imap(frame, range(N), chunksize=8)):
            p.stdin.write(b)
            if k % 150 == 0: print(k, flush=True)
    p.stdin.close(); p.wait()
    print('done')
