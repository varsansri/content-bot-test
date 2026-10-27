"""Makes the background picture (free AI) and draws the brand frame, text and logo on it."""
import base64
import io
import os
import random
import urllib.parse

import requests
from PIL import Image, ImageDraw, ImageFont, ImageOps

W, H = 1080, 1350  # Instagram 4:5 portrait (the default)
SIZES = {"4:5": (1080, 1350), "1:1": (1080, 1080), "9:16": (1080, 1920)}
SHAPE_WORDS = {"4:5": "Vertical portrait composition", "1:1": "Square composition", "9:16": "Tall vertical 9:16 composition"}
HERE = os.path.dirname(os.path.abspath(__file__))


# ---------- background picture ----------

def generate_background(prompt, brand, aspect="4:5"):
    """Return a PIL image. Tries Cloudflare (free tier), then Pollinations if it has a token.

    Pollinations without a token adds its own watermark and makes small pictures, so it is skipped.
    """
    style = brand.get("image_style", "")
    avoid = brand.get("image_avoid", "text, letters, words, watermark, logo")
    full_prompt = f"{prompt}. Style: {style}. {SHAPE_WORDS.get(aspect, SHAPE_WORDS['4:5'])}. No {avoid}."[:2000]

    errors = []
    if os.getenv("CLOUDFLARE_ACCOUNT_ID") and os.getenv("CLOUDFLARE_API_TOKEN"):
        try:
            return _cloudflare(full_prompt)
        except Exception as e:  # fall through to the next free provider
            errors.append(f"Cloudflare: {e}")
    if os.getenv("POLLINATIONS_TOKEN"):
        try:
            return _pollinations(full_prompt)
        except Exception as e:
            errors.append(f"Pollinations: {e}")
    if not errors:
        errors.append("no picture service set up: add the CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN secrets in GitHub")
    raise RuntimeError("Could not make a picture. " + " | ".join(errors))


def _cloudflare(prompt):
    url = (
        f"https://api.cloudflare.com/client/v4/accounts/{os.environ['CLOUDFLARE_ACCOUNT_ID']}"
        "/ai/run/@cf/black-forest-labs/flux-1-schnell"
    )
    r = requests.post(
        url,
        headers={"Authorization": f"Bearer {os.environ['CLOUDFLARE_API_TOKEN']}"},
        json={"prompt": prompt, "steps": 8},
        timeout=120,
    )
    data = r.json()
    if not r.ok or not data.get("success"):
        raise RuntimeError(str(data.get("errors") or r.text[:300]))
    return Image.open(io.BytesIO(base64.b64decode(data["result"]["image"]))).convert("RGB")


def _pollinations(prompt):
    url = "https://image.pollinations.ai/prompt/" + urllib.parse.quote(prompt)
    params = {"width": W, "height": H, "nologo": "true", "seed": random.randint(1, 10**9)}
    headers = {}
    if os.getenv("POLLINATIONS_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['POLLINATIONS_TOKEN']}"
    r = requests.get(url, params=params, headers=headers, timeout=180)
    if not r.ok or not r.headers.get("content-type", "").startswith("image/"):
        raise RuntimeError(f"HTTP {r.status_code} {r.text[:200]}")
    return Image.open(io.BytesIO(r.content)).convert("RGB")


# ---------- brand frame ----------

def _font(path, size):
    try:
        return ImageFont.truetype(os.path.join(HERE, path), size)
    except OSError:
        return ImageFont.load_default(size)


def _hex(color, alpha=255):
    color = color.lstrip("#")
    return tuple(int(color[i:i + 2], 16) for i in (0, 2, 4)) + (alpha,)


def _wrap(draw, text, font, max_width):
    lines, line = [], ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if draw.textlength(trial, font=font) <= max_width or not line:
            line = trial
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def _fit_text(draw, text, font_path, max_width, max_height, start, smallest):
    """Largest font size where the wrapped text fits the box."""
    for size in range(start, smallest - 1, -4):
        font = _font(font_path, size)
        lines = _wrap(draw, text, font, max_width)
        line_h = int(size * 1.15)
        if line_h * len(lines) <= max_height:
            return font, lines, line_h
    font = _font(font_path, smallest)
    return font, _wrap(draw, text, font, max_width), int(smallest * 1.15)


def compose(background, headline, subtext, brand, aspect="4:5"):
    """Return JPEG bytes: background + dark fade + headline + subtext + logo + handle."""
    W, H = SIZES.get(aspect, SIZES["4:5"])
    colors = brand.get("colors", {})
    fonts = brand.get("fonts", {})
    pad = 72

    img = ImageOps.fit(background.convert("RGB"), (W, H), Image.LANCZOS)
    if brand.get("black_and_white"):
        img = ImageOps.grayscale(img).convert("RGB")
    img = img.convert("RGBA")

    # Fade from clear (top) to the overlay colour (bottom) so the text is always readable.
    strength = float(brand.get("overlay_strength", 0.75))
    overlay_rgb = _hex(colors.get("overlay", "#000000"))[:3]
    fade = Image.new("L", (1, H))
    start = int(H * 0.35)
    for y in range(H):
        t = 0 if y < start else (y - start) / (H - start)
        fade.putpixel((0, y), int(255 * strength * min(1, t * 1.4)))
    shade = Image.new("RGBA", (W, H), overlay_rgb + (0,))
    shade.putalpha(fade.resize((W, H)))
    img = Image.alpha_composite(img, shade)

    draw = ImageDraw.Draw(img)
    text_color = _hex(colors.get("text", "#FFFFFF"))
    accent = _hex(colors.get("accent", "#FFC107"))
    max_w = W - 2 * pad

    # Brand handle at the very bottom.
    handle = brand.get("instagram_handle", "")
    handle_font = _font(fonts.get("body", ""), 30)
    bottom = H - pad - (230 if aspect == "9:16" else 0)  # stories: keep clear of Instagram's reply bar
    if handle:
        draw.text((pad, bottom), handle, font=handle_font, fill=text_color, anchor="ls")
        bottom -= 70

    # Subtext above the handle.
    if subtext:
        sub_font, sub_lines, sub_lh = _fit_text(draw, subtext, fonts.get("body", ""), max_w, 120, 40, 28)
        for line in reversed(sub_lines):
            draw.text((pad, bottom), line, font=sub_font, fill=text_color, anchor="ls")
            bottom -= sub_lh
        bottom -= 40

    # Headline above the subtext, as big as fits.
    head_font, head_lines, head_lh = _fit_text(draw, headline, fonts.get("headline", ""), max_w, min(420, int(H * 0.31)), 104, 52)
    for line in reversed(head_lines):
        draw.text((pad, bottom), line, font=head_font, fill=text_color, anchor="ls")
        bottom -= head_lh

    # Accent bar above the headline.
    bar_y = bottom - 10
    draw.rectangle([pad, bar_y - 10, pad + 120, bar_y], fill=accent)

    # Logo, same place and size on every post.
    logo_cfg = brand.get("logo", {})
    logo_path = os.path.join(HERE, logo_cfg.get("file", "assets/logo.png"))
    if os.path.exists(logo_path):
        logo = Image.open(logo_path).convert("RGBA")
        lw = int(logo_cfg.get("width", 180))
        logo = logo.resize((lw, int(logo.height * lw / logo.width)), Image.LANCZOS)
        margin = 56 + (150 if aspect == "9:16" else 0)  # stories: below Instagram's top bar
        pos = logo_cfg.get("position", "top-left")
        x = margin if "left" in pos else W - logo.width - margin
        y = margin if "top" in pos else H - logo.height - margin
        img.alpha_composite(logo, (x, y))

    out = io.BytesIO()
    img.convert("RGB").save(out, "JPEG", quality=92)
    return out.getvalue()
