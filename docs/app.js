// Mi Media Content Lab website. Talks to the GitHub repo through /api/gh (the Cloudflare worker
// adds the token): reads drafts from the "drafts" branch, starts the "bot" workflow for every
// action, and edits brand.json / the logo on the main branch.

const $ = (sel, el = document) => el.querySelector(sel);

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: keep in memory only */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
};

let repoInfo = null;
let brand = null;
let brandSha = null;
let pending = store.get("pending", {}); // id -> { action, sha, at, error?, runUrl? }
let hidden = store.get("hidden", []); // failed drafts the owner chose to hide
const draftCache = {}; // draft.json blob sha -> draft
const imgCache = {}; // post.jpg blob sha -> object URL
let shown = []; // [{ draft, draftSha, imgSha }]
let pollTimer = null;
let editing = null;
let filter = store.get("filter", "review");
let count = 1;
let aspect = store.get("aspect", "4:5");
let logoChoice = store.get("logo", ""); // a file from brand.logos, "none", or "" for the default
const logoUrls = {}; // file -> object URL

// ---------- GitHub API ----------

async function gh(path, { method = "GET", body, accept, raw } = {}) {
  const res = await fetch(`/api/gh${path}`, {
    method,
    cache: "no-store",
    headers: {
      Accept: accept || "application/vnd.github+json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).message || msg; } catch { /* not JSON */ }
    const err = new Error(res.status === 401 ? "Please log in again." : `GitHub said: ${msg} (${res.status})`);
    err.status = res.status;
    throw err;
  }
  if (raw) return res;
  return res.status === 204 ? null : res.json();
}

const blob = (sha) => gh(`/git/blobs/${sha}`, { accept: "application/vnd.github.raw+json", raw: true });

function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const textToB64 = (text) => bytesToB64(new TextEncoder().encode(text));
const b64ToText = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

async function fileSha(path, ref) {
  try { return (await gh(`/contents/${path}?ref=${ref}`)).sha; } catch (e) { if (e.status === 404) return null; throw e; }
}

async function putFile(path, b64, message, branch, sha) {
  return gh(`/contents/${path}`, { method: "PUT", body: { message, content: b64, branch, ...(sha ? { sha } : {}) } });
}

async function ensureDraftsBranch() {
  try {
    await gh("/git/ref/heads/drafts");
  } catch (e) {
    if (e.status !== 404) throw e;
    const tree = await gh("/git/trees", {
      method: "POST",
      body: { tree: [{ path: "README.md", mode: "100644", type: "blob", content: "Drafts made by the content bot.\n" }] },
    });
    const commit = await gh("/git/commits", { method: "POST", body: { message: "Start drafts", tree: tree.sha, parents: [] } });
    await gh("/git/refs", { method: "POST", body: { ref: "refs/heads/drafts", sha: commit.sha } });
  }
}

async function dispatch(action, id, extra = {}) {
  const inputs = { action, id };
  for (const [k, v] of Object.entries(extra)) if (v) inputs[k] = v;
  await gh("/actions/workflows/bot.yml/dispatches", { method: "POST", body: { ref: repoInfo.default_branch, inputs } });
  const current = shown.find((s) => s.draft.id === id);
  pending[id] = { action, sha: current ? current.draftSha : null, at: Date.now(), aspect: extra.aspect };
  store.set("pending", pending);
  renderList();
  poll(5000);
}

// ---------- drafts ----------

const idTime = (id) => (id.match(/(\d{8}-\d{4,6})/) || ["", ""])[1].padEnd(15, "0");

async function loadDrafts() {
  let tree;
  try {
    tree = await gh("/git/trees/drafts?recursive=1");
  } catch (e) {
    if (e.status === 404 || e.status === 409) return [];
    throw e;
  }
  const files = {};
  for (const t of tree.tree) {
    const m = t.path.match(/^drafts\/([^/]+)\/(draft\.json|post\.jpg)$/);
    if (m) (files[m[1]] ||= {})[m[2]] = t.sha;
  }
  const ids = Object.keys(files).filter((id) => files[id]["draft.json"])
    .sort((a, b) => idTime(b).localeCompare(idTime(a))).slice(0, 30);
  await Promise.all(ids.map(async (id) => {
    const sha = files[id]["draft.json"];
    if (!draftCache[sha]) draftCache[sha] = JSON.parse(await (await blob(sha)).text());
    const img = files[id]["post.jpg"];
    if (img && !imgCache[img]) imgCache[img] = URL.createObjectURL(await (await blob(img)).blob());
  }));
  return ids.map((id) => ({ draft: draftCache[files[id]["draft.json"]], draftSha: files[id]["draft.json"], imgSha: files[id]["post.jpg"] }));
}

async function checkRuns() {
  const old = Object.entries(pending).filter(([, p]) => !p.error && Date.now() - p.at > 25000);
  if (!old.length) return;
  const runs = (await gh("/actions/runs?event=workflow_dispatch&per_page=30")).workflow_runs;
  for (const [id, p] of old) {
    const run = runs.find((r) => r.display_title === `${p.action} ${id}`);
    if (run && run.status === "completed") {
      if (run.conclusion === "success") delete pending[id];
      else { p.error = `The run ${run.conclusion}.`; p.runUrl = run.html_url; }
    } else if (Date.now() - p.at > 10 * 60000) {
      p.error = "This is taking too long.";
      p.runUrl = `${repoInfo.html_url}/actions`;
    }
  }
}

async function refresh() {
  try {
    shown = await loadDrafts();
    for (const s of shown) {
      const p = pending[s.draft.id];
      if (p && p.sha !== s.draftSha) delete pending[s.draft.id];
    }
    await checkRuns();
    store.set("pending", pending);
    renderList();
  } catch (e) {
    if (e.status === 401) return showLogin(e.message);
    toast(e.message);
  }
}

function poll(delay) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    await refresh();
    const busy = Object.values(pending).some((p) => !p.error) || shown.some((s) => s.draft.status === "queued");
    poll(busy ? 6000 : 60000);
  }, delay);
}

// ---------- rendering ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STATUS = { draft: "Ready to review", posted: "Posted", skipped: "Skipped", failed: "Failed", working: "Working", queued: "Being made" };
const RATIO = { "4:5": "4 / 5", "1:1": "1 / 1", "9:16": "9 / 16" };
const SIZE_NAME = { "4:5": "Portrait", "1:1": "Square", "9:16": "Story" };
const inReview = (d) => !["posted", "skipped"].includes(d.status);
const ACTION_TEXT = { new: "Making the post…", post: "Posting to Instagram…", picture: "Making a new picture…", text: "Writing new text…", caption: "Saving the caption…", skip: "Skipping…" };

function fullCaption(d) {
  return d.caption + (d.hashtags && d.hashtags.length ? "\n\n" + d.hashtags.join(" ") : "");
}

function when(d) {
  const t = d.posted || d.updated || d.created;
  return t ? new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
}

function renderList() {
  const list = $("#list");
  const all = shown.filter((s) => !hidden.includes(s.draft.id));
  // Posts being made that have not reached GitHub yet.
  for (const [id, p] of Object.entries(pending)) {
    if (p.action === "new" && !all.some((s) => s.draft.id === id)) all.unshift({ draft: { id, status: "working", aspect: p.aspect }, ghost: true });
  }
  const counts = { review: all.filter((s) => inReview(s.draft)).length, posted: all.filter((s) => s.draft.status === "posted").length, all: all.length };
  document.querySelectorAll("#filters button").forEach((b) => {
    b.classList.toggle("on", b.dataset.filter === filter);
    b.querySelector("span").textContent = counts[b.dataset.filter] ? `(${counts[b.dataset.filter]})` : "";
  });
  const items = all.filter((s) => filter === "all" || (filter === "posted" ? s.draft.status === "posted" : inReview(s.draft)));
  $("#empty").hidden = items.length > 0;
  $("#empty").textContent = filter === "review" ? "Nothing to review. Make some posts above." : "Nothing here yet.";
  list.innerHTML = items.map(cardHtml).join("");
}

function cardHtml({ draft: d, imgSha, ghost }) {
  const p = pending[d.id];
  const queued = d.status === "queued" && !(p && !p.error);
  const busy = (p && !p.error) || queued;
  const status = queued ? "queued" : busy ? "working" : d.status;
  const img = imgSha && imgCache[imgSha];
  const busyText = queued
    ? `${d.pc_started ? "Your PC is making it now…" : "Waiting for your PC…"}<br><span class="muted small">${d.pc_started ? "about 2 minutes" : "the PC helper must be running"}</span>`
    : busy ? `${esc(ACTION_TEXT[p.action] || "Working…")}<br><span class="muted small">about a minute</span>` : "";
  const ratio = RATIO[d.aspect] || RATIO["4:5"];
  let html = `<article class="card" data-id="${esc(d.id)}">
    <div class="pic" style="aspect-ratio: ${ratio}">${img ? `<img src="${img}" alt="${esc(d.headline)}">` : ""}
      ${busyText ? `<div class="busy">${busyText}</div>` : ""}
    </div><div class="body">
    <span class="chip ${status}">${STATUS[status] || esc(status)}</span><span class="when">${esc(SIZE_NAME[d.aspect] || "Portrait")} · ${esc(when(d))}</span>`;
  if (p && p.error) html += `<div class="err">${esc(p.error)} <a href="${esc(p.runUrl)}" target="_blank" rel="noopener">See what happened</a></div>`;
  if (d.error) html += `<div class="err">${esc(d.error)}</div>`;
  if (ghost) return html + `</div></article>`;

  if (editing === d.id) {
    html += `<textarea class="edit-box" rows="10">${esc(fullCaption(d))}</textarea>
      <div class="actions"><button class="primary" data-act="save-caption">Save caption</button><button data-act="cancel-edit">Cancel</button></div>`;
  } else if (d.caption) {
    html += `<div class="caption">${esc(d.caption)}</div>`;
    if (d.hashtags && d.hashtags.length) html += `<div class="tags">${esc(d.hashtags.join(" "))}</div>`;
  }
  if (d.status === "posted" && d.permalink) html += `<p><a href="${esc(d.permalink)}" target="_blank" rel="noopener">Open on Instagram</a></p>`;
  if (img && d.caption && !busy && editing !== d.id && d.status !== "failed") {
    html += `<div class="actions">
      <a class="btn" href="${img}" download="${esc(d.id)}.jpg">⬇ Download picture</a>
      <button data-act="copy">📋 Copy caption</button>
    </div>`;
  }
  if (d.status === "draft" && !busy && editing !== d.id) {
    html += `<div class="actions">
      <button class="primary" data-act="post">Post to Instagram</button>
      ${d.own_photo ? "" : `<button data-act="picture">🖼 New picture</button>`}
      <button data-act="text">✍️ New words</button>
      <button data-act="edit">✏️ Edit caption</button>
      <button class="danger" data-act="skip">🗑 Remove</button>
    </div>`;
  }
  if (d.status === "failed" && !busy) html += `<div class="actions"><button data-act="retry">Try again</button><button data-act="dismiss">Hide</button></div>`;
  if (p && p.error) html += `<div class="actions"><button data-act="dismiss">OK</button></div>`;
  return html + `</div></article>`;
}

async function onCardClick(e) {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.closest(".card").dataset.id;
  const act = btn.dataset.act;
  const item = shown.find((s) => s.draft.id === id);
  btn.disabled = true;
  try {
    if (act === "edit") { editing = id; renderList(); return; }
    if (act === "copy") {
      await navigator.clipboard.writeText(fullCaption(item.draft));
      toast("Caption copied.");
      btn.disabled = false;
      return;
    }
    if (act === "cancel-edit") { editing = null; renderList(); return; }
    if (act === "dismiss") {
      if (pending[id]) delete pending[id];
      else hidden = [...hidden, id].slice(-200);
      store.set("pending", pending);
      store.set("hidden", hidden);
      renderList();
      return;
    }
    if (act === "save-caption") {
      const text = btn.closest(".card").querySelector(".edit-box").value.trim();
      if (text.length > 2200) { toast("Instagram allows 2,200 characters at most."); btn.disabled = false; return; }
      editing = null;
      await dispatch("caption", id, { caption: text });
      return;
    }
    if (act === "post" && !confirmPost()) { btn.disabled = false; return; }
    if (act === "retry") { await makePost(item ? item.draft.topic : "", null, item && item.draft.aspect); return; }
    await dispatch(act, id);
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
  }
}

function confirmPost() {
  // A second tap within 4 seconds confirms, so nothing goes live by accident.
  const now = Date.now();
  if (confirmPost.armed && now - confirmPost.armed < 4000) { confirmPost.armed = 0; return true; }
  confirmPost.armed = now;
  toast("Tap Post again to confirm.");
  return false;
}

// ---------- making posts ----------

function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `p-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

async function photoToJpegB64(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  const out = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
  return bytesToB64(new Uint8Array(await out.arrayBuffer()));
}

async function makePost(topic, photoFile, size = aspect) {
  const id = newId();
  let photo = "";
  if (photoFile) {
    toast("Uploading your photo…");
    photo = `uploads/${id}.jpg`;
    await putFile(photo, await photoToJpegB64(photoFile), `photo for ${id}`, "drafts");
  }
  await dispatch("new", id, { topic, photo, aspect: size || "4:5", logo: currentLogo() });
}

async function onNewPost() {
  const btn = $("#new-go");
  btn.disabled = true;
  const photo = $("#new-photo").files[0];
  const n = photo ? 1 : count;
  try {
    for (let i = 0; i < n; i++) {
      btn.textContent = n > 1 ? `Starting ${i + 1} of ${n}…` : "Starting…";
      await makePost($("#new-topic").value.trim(), photo);
    }
    toast(n > 1 ? `Started ${n} posts. They appear below as they are made.` : "Started. The post appears below when it is made.");
    $("#new-topic").value = "";
    $("#new-photo").value = "";
    filter = "review";
    store.set("filter", filter);
    renderList();
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    renderCreate();
  }
}

function renderCreate() {
  const photo = $("#new-photo").files[0];
  const n = photo ? 1 : count;
  $("#count").textContent = n;
  $("#count-minus").disabled = !!photo || count <= 1;
  $("#count-plus").disabled = !!photo || count >= 10;
  document.querySelectorAll("#sizes .size").forEach((b) => b.classList.toggle("on", b.dataset.aspect === aspect));
  $("#new-go").textContent = `Make ${n} ${SIZE_NAME[aspect].toLowerCase()} post${n > 1 ? "s" : ""}`;
  renderLogoPick();
}

// ---------- logos ----------

const logos = () => (brand && brand.logos) || [];
const defaultLogo = () => (brand && brand.logo && brand.logo.file) || "";

function currentLogo() {
  if (logoChoice === "none") return "none";
  return logos().some((l) => l.file === logoChoice) ? logoChoice : defaultLogo();
}

function logoImg(file) {
  if (!logoUrls[file]) {
    logoUrls[file] = gh(`/contents/${file}?ref=${repoInfo.default_branch}`, { accept: "application/vnd.github.raw+json", raw: true })
      .then((r) => r.blob()).then((b) => URL.createObjectURL(b)).catch(() => "");
  }
  return logoUrls[file];
}

// Fills <img data-logo="file"> tags once their pictures arrive.
function fillLogoImgs(root) {
  root.querySelectorAll("img[data-logo]").forEach(async (img) => { img.src = await logoImg(img.dataset.logo); });
}

function renderLogoPick() {
  const box = $("#logo-pick");
  if (!box || !brand) return;
  const cur = currentLogo();
  box.innerHTML = logos().map((l) => `<button type="button" class="logo-tile ${l.file === cur ? "on" : ""}" data-file="${esc(l.file)}">
      <span class="logo-pic"><img data-logo="${esc(l.file)}" alt=""></span><small>${esc(l.name)}</small></button>`).join("") +
    `<button type="button" class="logo-tile ${cur === "none" ? "on" : ""}" data-file="none"><span class="logo-pic none">–</span><small>No logo</small></button>`;
  fillLogoImgs(box);
}

function renderLogoList() {
  const def = defaultLogo();
  $("#logo-list").innerHTML = logos().map((l, i) => `<div class="logo-item" data-i="${i}">
      <span class="logo-pic"><img data-logo="${esc(l.file)}" alt=""></span>
      <div class="logo-fields">
        <b>${esc(l.name)}</b> ${l.file === def ? `<span class="chip posted">Default</span>` : ""}
        <label>Handle on the picture <input data-k="handle" value="${esc(l.handle || "")}" placeholder="${esc(brand.instagram_handle || "@yourbrand")}"></label>
        <label>Width in pixels <input data-k="width" type="number" min="40" max="900" value="${esc(l.width || 180)}"></label>
        <div class="row">
          ${l.file === def ? "" : `<button type="button" data-logo-act="default">Make default</button>`}
          <button type="button" class="danger" data-logo-act="remove">Remove</button>
        </div>
      </div></div>`).join("") || `<p class="muted">No logos yet. Add one below.</p>`;
  fillLogoImgs($("#logo-list"));
}

function readLogoFields() {
  document.querySelectorAll("#logo-list .logo-item").forEach((row) => {
    const l = brand.logos[row.dataset.i];
    l.handle = row.querySelector('[data-k="handle"]').value.trim();
    l.width = Number(row.querySelector('[data-k="width"]').value) || 180;
  });
}

async function onLogoListClick(e) {
  const btn = e.target.closest("button[data-logo-act]");
  if (!btn) return;
  const i = Number(btn.closest(".logo-item").dataset.i);
  btn.disabled = true;
  try {
    readLogoFields();
    const picked = brand.logos[i];
    await loadBrand(); // start from the latest version
    brand.logos = brand.logos || [];
    const j = brand.logos.findIndex((l) => l.file === picked.file);
    if (j < 0) throw new Error("That logo was already removed.");
    if (btn.dataset.logoAct === "default") {
      brand.logo = { ...(brand.logo || {}), file: picked.file, width: picked.width };
      await saveBrand(`Default logo: ${picked.name}`);
      toast(`${picked.name} is now the default logo.`);
    } else {
      if (brand.logos.length === 1) throw new Error("Keep at least one logo. Add another one first.");
      brand.logos.splice(j, 1);
      if (brand.logo && brand.logo.file === picked.file) brand.logo = { ...brand.logo, file: brand.logos[0].file, width: brand.logos[0].width };
      await saveBrand(`Remove logo: ${picked.name}`);
      toast(`${picked.name} removed.`);
    }
    renderLogoList();
    renderLogoPick();
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
  }
}

async function onLogoAdd() {
  const btn = $("#logo-add");
  const name = $("#logo-name").value.trim();
  const file = $("#logo-file").files[0];
  if (!name || !file) { toast("Give the logo a name and pick a PNG file."); return; }
  btn.disabled = true;
  try {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "logo";
    const path = `assets/logos/${slug}-${Date.now().toString(36)}.png`;
    await putFile(path, bytesToB64(new Uint8Array(await file.arrayBuffer())), `Add logo: ${name}`, repoInfo.default_branch);
    await loadBrand();
    brand.logos = [...(brand.logos || []), { name, file: path, width: 180, handle: $("#logo-handle").value.trim() }];
    await saveBrand(`Add logo: ${name}`);
    logoUrls[path] = Promise.resolve(URL.createObjectURL(file));
    $("#logo-name").value = "";
    $("#logo-handle").value = "";
    $("#logo-file").value = "";
    renderLogoList();
    renderLogoPick();
    toast(`${name} added. Pick it when you make posts.`);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- brand ----------

const FIELDS = [
  "About the brand",
  ["brand_name", "Brand name", "text"],
  ["instagram_handle", "Instagram handle (shown on every picture)", "text"],
  ["about", "What the account is about", "area"],
  "Captions",
  ["voice", "How the captions should sound", "area"],
  ["language", "Language", "text"],
  ["topics", "Topics for scheduled posts (one per line)", "lines"],
  ["example_captions", "Example captions you like (blank line between them)", "blocks"],
  ["always_hashtags", "Hashtags on every post", "tags"],
  ["hashtag_count", "How many extra hashtags", "number"],
  "Picture look",
  ["image_style", "Picture style (added to every AI picture)", "area"],
  ["black_and_white", "Make every picture black and white", "bool"],
  ["colors.text", "Text colour", "color"],
  ["colors.accent", "Accent bar colour", "color"],
  ["colors.overlay", "Shade colour behind text", "color"],
  ["overlay_strength", "Shade strength (0 to 1)", "decimal"],
  ["logo.position", "Logo position", "select:top-left,top-right,bottom-left,bottom-right"],
  "Daily schedule",
  ["post_times", "Daily posting times, 24-hour (e.g. 10:00, 19:00)", "csv"],
  ["timezone", "Timezone (e.g. Asia/Kolkata)", "text"],
];

const getPath = (obj, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
function setPath(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  keys.reduce((o, k) => (o[k] ||= {}), obj)[last] = value;
}

function fieldHtml(field, i) {
  if (typeof field === "string") return `<h3>${esc(field)}</h3>`;
  const [key, label, type] = field;
  const v = getPath(brand, key);
  const name = `f${i}`;
  if (type === "area") return `<label>${label}<textarea name="${name}" rows="3">${esc(v)}</textarea></label>`;
  if (type === "lines") return `<label>${label}<textarea name="${name}" rows="5">${esc((v || []).join("\n"))}</textarea></label>`;
  if (type === "blocks") return `<label>${label}<textarea name="${name}" rows="8">${esc((v || []).join("\n\n"))}</textarea></label>`;
  if (type === "tags") return `<label>${label}<input name="${name}" value="${esc((v || []).join(" "))}"></label>`;
  if (type === "csv") return `<label>${label}<input name="${name}" value="${esc((v || []).join(", "))}"></label>`;
  if (type === "bool") return `<label class="check"><input type="checkbox" name="${name}" ${v ? "checked" : ""}>${label}</label>`;
  if (type === "color") return `<label>${label}<input type="color" name="${name}" value="${esc(v || "#ffffff")}"></label>`;
  if (type === "number") return `<label>${label}<input type="number" name="${name}" value="${esc(v)}" min="0"></label>`;
  if (type === "decimal") return `<label>${label}<input type="number" name="${name}" value="${esc(v)}" min="0" max="1" step="0.05"></label>`;
  if (type.startsWith("select:")) {
    const opts = type.slice(7).split(",").map((o) => `<option ${o === v ? "selected" : ""}>${o}</option>`).join("");
    return `<label>${label}<select name="${name}">${opts}</select></label>`;
  }
  return `<label>${label}<input name="${name}" value="${esc(v)}"></label>`;
}

function readField(field, i) {
  if (typeof field === "string") return undefined;
  const type = field[2];
  const el = $(`#brand-form [name="f${i}"]`);
  const raw = type === "bool" ? el.checked : el.value;
  if (type === "lines") return raw.split("\n").map((s) => s.trim()).filter(Boolean);
  if (type === "blocks") return raw.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  if (type === "tags") return raw.split(/[\s,]+/).filter(Boolean).map((t) => (t.startsWith("#") ? t : "#" + t));
  if (type === "csv") {
    const times = raw.split(",").map((s) => s.trim()).filter(Boolean);
    const bad = times.find((t) => !/^([01]?\d|2[0-3]):[0-5]\d$/.test(t));
    if (bad) throw new Error(`"${bad}" is not a time like 19:00`);
    return times;
  }
  if (type === "number" || type === "decimal") return Number(raw);
  return raw;
}

async function loadBrand() {
  const file = await gh(`/contents/brand.json?ref=${repoInfo.default_branch}`);
  brand = JSON.parse(b64ToText(file.content));
  brandSha = file.sha;
  renderSchedule();
  renderLogoPick();
}

async function saveBrand(message) {
  const res = await putFile("brand.json", textToB64(JSON.stringify(brand, null, 2) + "\n"), message, repoInfo.default_branch, brandSha);
  brandSha = res.content.sha;
  renderSchedule();
}

function renderBrand() {
  $("#brand-form").innerHTML = FIELDS.map(fieldHtml).join("");
  renderLogoList();
}

async function onBrandSave() {
  const btn = $("#brand-save");
  btn.disabled = true;
  try {
    const values = FIELDS.map(readField);
    readLogoFields();
    const logoEdits = Object.fromEntries(logos().map((l) => [l.file, { handle: l.handle, width: l.width }]));
    await loadBrand(); // start from the latest version
    FIELDS.forEach((field, i) => { if (typeof field !== "string") setPath(brand, field[0], values[i]); });
    for (const l of logos()) Object.assign(l, logoEdits[l.file] || {});
    const def = logos().find((l) => l.file === defaultLogo());
    if (def) brand.logo.width = def.width;
    await saveBrand("Update brand settings");
    toast("Saved. New posts use the new look.");
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}

function renderSchedule() {
  const times = (brand.post_times || []).join(", ");
  $("#schedule-text").textContent = times ? `A new post every day at ${times} (${brand.timezone || "UTC"})` : "No daily posts";
  $("#auto-toggle").checked = !!brand.auto_post;
}

async function onAutoToggle(e) {
  const on = e.target.checked;
  e.target.disabled = true;
  try {
    await loadBrand();
    brand.auto_post = on;
    await saveBrand(on ? "Turn auto-post on" : "Turn auto-post off");
    toast(on ? "Auto-post ON: scheduled posts go live without asking." : "Auto-post OFF: scheduled posts wait for you.");
  } catch (err) {
    e.target.checked = !on;
    toast(err.message);
  } finally {
    e.target.disabled = false;
  }
}

// ---------- log in + navigation ----------

function showTab(name) {
  for (const id of ["posts", "brand", "setup"]) $(`#${id}`).hidden = id !== name;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === name));
  if (name === "brand" && brand) renderBrand();
}

async function connect() {
  $("#cfg-status").textContent = "Loading…";
  repoInfo = await gh("");
  if (!repoInfo.permissions || !repoInfo.permissions.push) throw new Error("The bot's GitHub key cannot change the repository.");
  await ensureDraftsBranch();
  await loadBrand();
  $("#tabs").hidden = false;
  $("#cfg-status").textContent = "";
  showTab("posts");
  await refresh();
  poll(Object.values(pending).some((p) => !p.error) ? 6000 : 60000);
}

function showLogin(message = "") {
  clearTimeout(pollTimer);
  repoInfo = null;
  $("#tabs").hidden = true;
  showTab("setup");
  $("#cfg-status").textContent = message;
}

async function onLogin(e) {
  e.preventDefault();
  const btn = $("#login-go");
  btn.disabled = true;
  $("#cfg-status").textContent = "Checking…";
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: $("#login-pass").value }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Could not log in.");
    $("#login-pass").value = "";
    await connect();
  } catch (err) {
    $("#cfg-status").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

async function onLogout() {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  store.remove("pending");
  location.reload();
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

function init() {
  $("#setup").addEventListener("submit", onLogin);
  $("#logout").addEventListener("click", onLogout);
  $("#new-go").addEventListener("click", onNewPost);
  $("#count-minus").addEventListener("click", () => { count = Math.max(1, count - 1); renderCreate(); });
  $("#count-plus").addEventListener("click", () => { count = Math.min(10, count + 1); renderCreate(); });
  $("#new-photo").addEventListener("change", renderCreate);
  $("#sizes").addEventListener("click", (e) => {
    const b = e.target.closest(".size");
    if (!b) return;
    aspect = b.dataset.aspect;
    store.set("aspect", aspect);
    renderCreate();
  });
  $("#filters").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-filter]");
    if (!b) return;
    filter = b.dataset.filter;
    store.set("filter", filter);
    renderList();
  });
  renderCreate();
  $("#list").addEventListener("click", onCardClick);
  $("#brand-save").addEventListener("click", onBrandSave);
  $("#logo-add").addEventListener("click", onLogoAdd);
  $("#logo-list").addEventListener("click", onLogoListClick);
  $("#logo-pick").addEventListener("click", (e) => {
    const b = e.target.closest(".logo-tile");
    if (!b) return;
    logoChoice = b.dataset.file;
    store.set("logo", logoChoice);
    renderLogoPick();
  });
  $("#auto-toggle").addEventListener("change", onAutoToggle);
  document.querySelectorAll(".tab[data-tab]").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
  document.addEventListener("visibilitychange", () => { if (!document.hidden && repoInfo) poll(0); });

  store.remove("cfg"); // old GitHub token from the first version of the site
  connect().catch((e) => showLogin(e.status === 401 ? "" : e.message));
}

init();
