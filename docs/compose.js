// Draws the brand frame on a background in the browser, the same design as images.py compose():
// background + fade to the overlay colour + headline + subtext + handle + accent bar + logo. Returns a JPEG Blob.

const POST_SIZES = { "4:5": [1080, 1350], "1:1": [1080, 1080], "9:16": [1080, 1920] };
const fontFamilies = {};

// Brief fonts are repo paths like fonts/Poppins-Bold.ttf; the site serves the same files from /fonts/.
function brandFont(path, fallback) {
  const file = String(path || fallback).split("/").pop();
  if (!fontFamilies[file]) {
    const family = "lab-" + file.replace(/\W/g, "");
    fontFamilies[file] = new FontFace(family, `url(/fonts/${encodeURIComponent(file)})`).load()
      .then((face) => { document.fonts.add(face); return `"${family}"`; })
      .catch(() => "sans-serif");
  }
  return fontFamilies[file];
}

function loadPicture(url) {
  const img = new Image();
  img.src = url;
  return img.decode().then(() => img);
}

function hexRgb(color) {
  const c = String(color).replace("#", "");
  return [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) || 0);
}

function wrapText(ctx, text, maxWidth) {
  const lines = [];
  let line = "";
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const trial = line ? `${line} ${word}` : word;
    if (ctx.measureText(trial).width <= maxWidth || !line) line = trial;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

// Largest font size where the wrapped text fits the box; leaves ctx.font set to it.
function fitText(ctx, text, family, maxWidth, maxHeight, start, smallest) {
  for (let size = start; size >= smallest; size -= 4) {
    ctx.font = `${size}px ${family}`;
    const lines = wrapText(ctx, text, maxWidth);
    const lineH = Math.floor(size * 1.15);
    if (lineH * lines.length <= maxHeight) return { lines, lineH };
  }
  ctx.font = `${smallest}px ${family}`;
  return { lines: wrapText(ctx, text, maxWidth), lineH: Math.floor(smallest * 1.15) };
}

// job: { aspect, headline, subtext, background_key, brand: { logo, colors, fonts, overlay_strength, black_and_white, instagram_handle } }
async function composePost(job) {
  const [W, H] = POST_SIZES[job.aspect] || POST_SIZES["4:5"];
  const brand = job.brand || {};
  const colors = brand.colors || {};
  const fonts = brand.fonts || {};
  const pad = 72;
  const [bg, logo, headFont, bodyFont] = await Promise.all([
    loadPicture(`/api/file/${job.background_key}`),
    brand.logo ? loadPicture(brand.logo.url) : null,
    brandFont(fonts.headline, "Poppins-Bold.ttf"),
    brandFont(fonts.body, "Poppins-Regular.ttf"),
  ]);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";

  // Fill the frame, cropping the middle (like ImageOps.fit).
  const scale = Math.max(W / bg.naturalWidth, H / bg.naturalHeight);
  const sw = W / scale;
  const sh = H / scale;
  ctx.drawImage(bg, (bg.naturalWidth - sw) / 2, (bg.naturalHeight - sh) / 2, sw, sh, 0, 0, W, H);
  if (brand.black_and_white) {
    const px = ctx.getImageData(0, 0, W, H);
    const d = px.data;
    for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    ctx.putImageData(px, 0, 0);
  }

  // Fade from clear (top third) to the overlay colour (bottom) so the text is always readable.
  const strength = Number(brand.overlay_strength ?? 0.75);
  const [r, g, b] = hexRgb(colors.overlay || "#000000");
  const start = Math.floor(H * 0.35);
  const fade = ctx.createLinearGradient(0, start, 0, start + (H - start) / 1.4);
  fade.addColorStop(0, `rgba(${r},${g},${b},0)`);
  fade.addColorStop(1, `rgba(${r},${g},${b},${strength})`);
  ctx.fillStyle = fade;
  ctx.fillRect(0, start, W, H - start);

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = colors.text || "#FFFFFF";
  const maxW = W - 2 * pad;
  let bottom = H - pad - (job.aspect === "9:16" ? 230 : 0); // stories: keep clear of Instagram's reply bar

  // Brand handle at the very bottom.
  if (brand.instagram_handle) {
    ctx.font = `30px ${bodyFont}`;
    ctx.fillText(brand.instagram_handle, pad, bottom);
    bottom -= 70;
  }

  // Subtext above the handle.
  if (job.subtext) {
    const sub = fitText(ctx, job.subtext, bodyFont, maxW, 120, 40, 28);
    for (const line of sub.lines.reverse()) {
      ctx.fillText(line, pad, bottom);
      bottom -= sub.lineH;
    }
    bottom -= 40;
  }

  // Headline above the subtext, as big as fits.
  const head = fitText(ctx, job.headline || "", headFont, maxW, Math.min(420, Math.floor(H * 0.31)), 104, 52);
  for (const line of head.lines.reverse()) {
    ctx.fillText(line, pad, bottom);
    bottom -= head.lineH;
  }

  // Accent bar above the headline.
  ctx.fillStyle = colors.accent || "#FFC107";
  ctx.fillRect(pad, bottom - 20, 121, 11);

  // Logo, same place and size on every post.
  if (logo) {
    const lw = Number(brand.logo.width) || 180;
    const lh = Math.round(logo.naturalHeight * lw / logo.naturalWidth);
    const margin = 56 + (job.aspect === "9:16" ? 150 : 0); // stories: below Instagram's top bar
    const pos = brand.logo.position || "top-left";
    ctx.drawImage(logo, pos.includes("left") ? margin : W - lw - margin, pos.includes("top") ? margin : H - lh - margin, lw, lh);
  }

  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("the browser could not save the picture"))), "image/jpeg", 0.92));
}
