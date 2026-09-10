"""Compose Chrome Web Store marquee poster (1400x560) into logos/target.jpeg."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent
WIN = Path(r"C:\Windows\Fonts")


def load_font(candidates, size):
    for path in candidates:
        try:
            return ImageFont.truetype(str(path), size)
        except OSError:
            continue
    return ImageFont.load_default()


def rounded_shadow(img, radius=18, shadow=18):
    img = img.convert("RGBA")
    mask = Image.new("L", img.size, 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle((0, 0, img.size[0] - 1, img.size[1] - 1), radius=radius, fill=255)
    rounded = Image.new("RGBA", img.size, (0, 0, 0, 0))
    rounded.paste(img, (0, 0))
    rounded.putalpha(mask)

    pad = shadow * 2
    out = Image.new("RGBA", (img.size[0] + pad, img.size[1] + pad), (0, 0, 0, 0))
    sh = Image.new("RGBA", out.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    sd.rounded_rectangle(
        (shadow, shadow + 4, shadow + img.size[0], shadow + 4 + img.size[1]),
        radius=radius,
        fill=(0, 0, 0, 120),
    )
    sh = sh.filter(ImageFilter.GaussianBlur(10))
    out = Image.alpha_composite(out, sh)
    out.paste(rounded, (shadow, shadow), rounded)
    return out


def rotate_keep(img, angle):
    return img.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)


def main():
    target = ROOT / "target.jpeg"
    backup = ROOT / "target-old.jpeg"
    if not backup.exists():
        Image.open(target).save(backup, "JPEG", quality=92)
        print("backed up to", backup)
    else:
        print("keeping existing backup", backup)

    ss = Image.open(ROOT / "quranlens_ss.png").convert("RGBA")
    idle = ss.crop((27, 30, 623, 604))
    result = ss.crop((655, 30, 1253, 604))
    print("crops:", idle.size, result.size)

    W, H = 1400, 560
    canvas = Image.new("RGB", (W, H), (10, 22, 18))
    draw = ImageDraw.Draw(canvas)

    for y in range(H):
        t = y / (H - 1)
        r = int(10 + (8 - 10) * t)
        g = int(26 + (40 - 26) * t)
        b = int(21 + (32 - 21) * t)
        draw.line([(0, y), (W, y)], fill=(r, g, b))

    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    gdraw.ellipse((900, -120, 1500, 380), fill=(16, 185, 129, 40))
    gdraw.ellipse((-80, 300, 420, 700), fill=(5, 120, 90, 28))
    gdraw.ellipse((600, 400, 1100, 700), fill=(52, 211, 153, 18))
    glow = glow.filter(ImageFilter.GaussianBlur(60))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), glow).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    sheen = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(sheen)
    sdraw.polygon([(780, 0), (W, 0), (W, H), (620, H)], fill=(6, 40, 32, 90))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), sheen).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    sans_title = load_font([WIN / "segoeuib.ttf", WIN / "arialbd.ttf"], 28)
    headline = load_font([WIN / "segoeuib.ttf", WIN / "arialbd.ttf"], 34)
    feat_title = load_font([WIN / "segoeuib.ttf", WIN / "arialbd.ttf"], 14)
    feat_desc = load_font([WIN / "segoeui.ttf", WIN / "arial.ttf"], 12)
    tag_font = load_font([WIN / "segoeuib.ttf", WIN / "arialbd.ttf"], 11)
    cta_small = load_font([WIN / "segoeui.ttf", WIN / "arial.ttf"], 10)
    cta_big = load_font([WIN / "segoeuib.ttf", WIN / "arialbd.ttf"], 14)

    cream = (254, 253, 248)
    muted = (200, 210, 205)
    emerald = (52, 211, 153)
    emerald_dim = (16, 185, 129)

    icon = Image.open(ROOT / "quranlens_icon.png").convert("RGBA").resize(
        (48, 48), Image.Resampling.LANCZOS
    )
    canvas_rgba = canvas.convert("RGBA")
    canvas_rgba.paste(icon, (48, 36), icon)
    canvas = canvas_rgba.convert("RGB")
    draw = ImageDraw.Draw(canvas)

    draw.text((108, 38), "Quran", font=sans_title, fill=cream)
    q_box = draw.textbbox((108, 38), "Quran", font=sans_title)
    draw.text((q_box[2] + 1, 38), "Lens", font=sans_title, fill=emerald)
    draw.text((108, 72), "QURAN RECITATION DETECTOR", font=tag_font, fill=emerald_dim)

    hx, hy = 48, 112
    draw.text((hx, hy), "Know Which", font=headline, fill=cream)
    draw.text((hx, hy + 38), "Surah & Ayah", font=headline, fill=emerald)
    draw.text((hx, hy + 76), "in Seconds", font=headline, fill=cream)

    features = [
        ("Real-time Detection", "Overlay on YouTube watch pages"),
        ("Accurate Results", "Surah & Ayah matched from captions"),
        ("Local Verse Matching", "Full corpus, on-device — no cloud AI"),
        ("Easy to Use", "Open, analyze, discover — no setup"),
    ]
    fy = 242
    for title, desc in features:
        draw.ellipse((52, fy + 2, 64, fy + 14), outline=emerald, width=2)
        draw.text((76, fy - 2), title, font=feat_title, fill=cream)
        draw.text((76, fy + 16), desc, font=feat_desc, fill=muted)
        fy += 40

    badge = Image.new("RGBA", (220, 48), (0, 0, 0, 0))
    bd = ImageDraw.Draw(badge)
    bd.rounded_rectangle(
        (0, 0, 219, 47),
        radius=24,
        fill=(8, 14, 12, 230),
        outline=(52, 211, 153, 80),
        width=1,
    )
    cx, cy, cr = 28, 24, 12
    bd.ellipse((cx - cr, cy - cr, cx + cr, cy + cr), fill=(66, 133, 244))
    bd.pieslice((cx - cr, cy - cr, cx + cr, cy + cr), 0, 90, fill=(234, 67, 53))
    bd.pieslice((cx - cr, cy - cr, cx + cr, cy + cr), 90, 180, fill=(251, 188, 5))
    bd.pieslice((cx - cr, cy - cr, cx + cr, cy + cr), 180, 270, fill=(52, 168, 83))
    bd.ellipse((cx - 5, cy - 5, cx + 5, cy + 5), fill=(255, 255, 255))
    bd.ellipse((cx - 3, cy - 3, cx + 3, cy + 3), fill=(66, 133, 244))
    bd.text((50, 8), "Get it on", font=cta_small, fill=muted)
    bd.text((50, 22), "Google Chrome", font=cta_big, fill=cream)
    canvas_rgba = canvas.convert("RGBA")
    canvas_rgba.paste(badge, (48, 440), badge)
    canvas = canvas_rgba.convert("RGB")
    draw = ImageDraw.Draw(canvas)
    draw.text((290, 456), "YOUR QURAN COMPANION", font=tag_font, fill=muted)

    # Result panel dominant; idle slightly smaller behind it
    result_h = 420
    idle_h = 360
    result_r = result.resize(
        (int(result.width * (result_h / result.height)), result_h),
        Image.Resampling.LANCZOS,
    )
    idle_r = idle.resize(
        (int(idle.width * (idle_h / idle.height)), idle_h),
        Image.Resampling.LANCZOS,
    )

    idle_rot = rotate_keep(rounded_shadow(idle_r, radius=16), -3)
    result_rot = rotate_keep(rounded_shadow(result_r, radius=16), 3)

    base = canvas.convert("RGBA")
    base.paste(idle_rot, (640, 85), idle_rot)
    base.paste(result_rot, (880, 55), result_rot)

    vignette = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    vd = ImageDraw.Draw(vignette)
    for i in range(40):
        a = int(40 * (1 - i / 40))
        vd.rectangle((W - 1 - i, 0, W - i, H), fill=(0, 0, 0, a))
    base = Image.alpha_composite(base, vignette)

    final = base.convert("RGB")
    final.save(target, "JPEG", quality=92, optimize=True)
    print("wrote", target, final.size)


if __name__ == "__main__":
    main()
