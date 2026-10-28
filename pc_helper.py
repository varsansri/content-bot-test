"""PC helper: the brain. Takes jobs from the website, has Antigravity (agy) write and draw them, sends them back.

    python pc_helper.py          -> keeps running; asks the website for a job every 20 seconds
    python pc_helper.py --once   -> does one job if there is one, then stops

Everything else (projects, memory, assets, posts) lives on the website, so nothing piles up here:
each job's files are deleted after upload. The helper and Antigravity run at low priority.
Setup: ~/.mi-media-lab/config.json with {"url": "...", "token": "..."} (made by ~/labbrain.sh).
"""
import ctypes
import glob
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.request
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import content
import images

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(os.path.expanduser("~"), ".mi-media-lab", "config.json")
BRAIN = os.path.join(os.path.expanduser("~"), ".gemini", "antigravity-cli", "brain")
WORK = os.path.join(tempfile.gettempdir(), "mi-media-lab-agy")
CHECK_EVERY = 20  # seconds between job checks
HEARTBEAT_EVERY = 120  # seconds between storage reports
LOW_PRIORITY = 0x00004000  # Windows BELOW_NORMAL_PRIORITY_CLASS
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
PICTURE_TYPES = (".png", ".jpg", ".jpeg", ".webp")
SHAPES = {"4:5": "Tall portrait picture, 4:5 shape (like 1080x1350)",
          "1:1": "Square picture, 1:1 shape (like 1080x1080)",
          "9:16": "Tall phone-screen picture, 9:16 shape (like 1080x1920)"}

cfg = {}


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


# ---------- website ----------

def call(path, data=None, files=None, raw=False, timeout=60):
    headers = {"Authorization": f"Bearer {cfg['token']}", "User-Agent": "mi-media-lab-helper"}
    body = None
    if files is not None:
        boundary = uuid.uuid4().hex
        parts = []
        for name, value in (data or {}).items():
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
        for name, blob in files.items():
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{name}.jpg"\r\n'
                         f'Content-Type: image/jpeg\r\n\r\n'.encode() + blob + b"\r\n")
        body = b"".join(parts) + f"--{boundary}--\r\n".encode()
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    elif data is not None:
        body = json.dumps(data).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(cfg["url"].rstrip("/") + path, data=body, headers=headers, method="POST" if body is not None else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as res:
        out = res.read()
    return out if raw else json.loads(out or b"{}")


def folder_bytes(path):
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def heartbeat(job=""):
    disk = shutil.disk_usage(os.path.expanduser("~"))
    try:
        call("/api/agent/heartbeat", {"helper_bytes": folder_bytes(WORK), "antigravity_bytes": folder_bytes(BRAIN),
                                      "disk_free": disk.free, "disk_total": disk.total, "job": job})
    except Exception as e:
        log(f"could not reach the website: {e}")


# ---------- Antigravity ----------

def agy(prompt, folder, timeout=300):
    """One Antigravity prompt in its own folder. accept-edits lets it save files without asking yes/no."""
    out = subprocess.run(
        ["agy", "-p", prompt, "--mode", "accept-edits", "--print-timeout", f"{timeout - 20}s"],
        cwd=folder, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
        creationflags=LOW_PRIORITY if os.name == "nt" else 0,
    )
    text = ANSI.sub("", (out.stdout or "") + (out.stderr or ""))
    if out.returncode:
        raise RuntimeError("Antigravity failed: " + text.strip()[-300:])
    return text


def brand_for(project, assets, job):
    """The brief in the shape content.py and images.py expect, with this post's logo."""
    brief = dict(project["brief"])
    brief.setdefault("brand_name", project["name"])
    brief.setdefault("fonts", {"headline": "fonts/Poppins-Bold.ttf", "body": "fonts/Poppins-Regular.ttf"})
    logos = [a for a in assets if a["kind"] == "logo"]
    choice = job.get("logo_id") or brief.get("default_logo") or (logos[0]["id"] if logos else "none")
    logo = next((a for a in logos if a["id"] == choice), None)
    brief["logo"] = {"position": brief.get("logo_position", "top-left"), "file": "assets/no-logo.png", "width": 180}  # missing = no logo
    if logo:
        brief["logo"]["width"] = int(logo["settings"].get("width") or 180)
        if logo["settings"].get("handle"):
            brief["instagram_handle"] = logo["settings"]["handle"]
    return brief, logo


def memory_text(memory, tz):
    """The project's memory as dated lines, highlighted hints first, so the brain finds what matters fast."""
    def line(m):
        when = datetime.fromisoformat(m["created"].replace("Z", "+00:00")).astimezone(tz).strftime("%d %b %Y %H:%M")
        return f"- [{when}] {m['note']}"
    parts = []
    if memory.get("hints"):
        parts.append("KEY HINTS AND RULES (highlighted; always follow these first):\n" + "\n".join(line(m) for m in memory["hints"]))
    if memory.get("lessons"):
        parts.append("Lessons and the owner's feedback (newest last):\n" + "\n".join(f"{line(m)}{' (feedback)' if m['kind'] == 'feedback' else ''}" for m in memory["lessons"]))
    if memory.get("log"):
        parts.append("Your recent work log (what you made, when):\n" + "\n".join(line(m) for m in memory["log"]))
    return "\n\n".join(parts)


def write_text(brand, job, folder, memory, recent, references, photo_file):
    if job.get("topic"):
        ask = f"Write a post about: {job['topic']}"
    else:
        ask = "Pick a fresh angle from one of these topics and write a post:\n" + "\n".join(f"- {t}" for t in brand.get("topics", []))
    if recent:
        ask += "\n\nDo not repeat these recent headlines or their ideas:\n" + "\n".join(f"- {h}" for h in recent)
    tz = ZoneInfo(brand.get("timezone") or "Asia/Kolkata")
    remembered = memory_text(memory, tz)
    if remembered:
        ask += "\n\nYOUR MEMORY OF THIS PROJECT:\n" + remembered
    ask += f"\n\nNow is {datetime.now(tz).strftime('%A %d %b %Y %H:%M')}."
    if references:
        ask += "\n\nReference files in the current folder (look at them for style and facts):\n" + "\n".join(f"- {n}: {note}" for n, note in references)
    if photo_file:
        ask += f"\n\nLook at {photo_file} in the current folder: it will be the picture of this post. Write about it. image_prompt can be \"\"."
    ask += "\n\nYou may search the web for current facts or trends if it helps. Do not create or change any files."
    prompt = (content._system_prompt(brand) + "\n\n" + ask +
              "\n\nReply with ONLY one JSON object with exactly these keys: topic, headline, subtext, caption, hashtags (a list), "
              "image_prompt, learned (a list of 0-2 short NEW lessons about what this owner likes, taken from the feedback above; "
              "[] if nothing new), hint (ONE short new rule worth highlighting so the next post comes out right, for example a "
              "picture style the owner keeps approving; \"\" unless it is new, important and not already in your key hints). No other text.")
    reply = agy(prompt, folder)
    start, end = reply.find("{"), reply.rfind("}")
    if start < 0 or end < start:
        raise RuntimeError("Antigravity did not send the post text. Reply: " + reply.strip()[-200:])
    post = json.loads(reply[start:end + 1])
    if not post.get("headline") or not post.get("caption"):
        raise RuntimeError("Antigravity's text is missing the headline or caption.")
    tags = [t if t.startswith("#") else "#" + t for t in post.get("hashtags") or []]
    seen = {}
    for t in brand.get("always_hashtags", []) + tags:
        seen.setdefault(t.lower(), t)  # one of each, whatever the capitals
    post["hashtags"] = list(seen.values())[:30]
    post["learned"] = [str(x) for x in post.get("learned") or []][:2]
    post["hint"] = str(post.get("hint") or "").strip()[:300]
    return post


def make_picture(prompt, brand, aspect, folder, references):
    from PIL import Image
    style = brand.get("image_style", "")
    avoid = brand.get("image_avoid", "text, letters, words, watermark, logo")
    refs = ""
    if references:
        refs = "\nUse these reference files in the current folder for style: " + ", ".join(n for n, _ in references) + "."
    since = time.time() - 1
    agy("Use your image generator to create ONE picture and save it in the current folder as background.png.\n"
        f"Picture: {prompt}. Style: {style}.{refs}\n"
        f"{SHAPES.get(aspect, SHAPES['4:5'])}. Leave the bottom third calm, text goes there later. "
        f"Absolutely no {avoid}. Do not ask questions, just make it.", folder)
    # Antigravity's image helper can finish a little after agy returns; wait up to 3 more minutes.
    for _ in range(36):
        pics = [p for root in (BRAIN, folder) for p in glob.glob(os.path.join(root, "**", "*"), recursive=True)
                if p.lower().endswith(PICTURE_TYPES) and os.path.getmtime(p) > since and not os.path.basename(p).startswith("ref-")]
        if pics:
            time.sleep(2)  # let the file finish writing
            newest = max(pics, key=os.path.getmtime)
            img = Image.open(newest).convert("RGB")
            for p in pics:  # keep the PC clean: Antigravity's copies are no longer needed
                if p.startswith(BRAIN):
                    try:
                        os.remove(p)
                    except OSError:
                        pass
            return img
        time.sleep(5)
    raise RuntimeError("Antigravity did not make a picture. Check that agy is signed in.")


# ---------- one job ----------

def save(path, key):
    with open(path, "wb") as f:
        f.write(call(f"/api/agent/file/{key}", raw=True))
    return path


def jpeg(img):
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=92)
    return buf.getvalue()


def do_job(task):
    from PIL import Image
    job, project, assets = task["job"], task["project"], task["assets"]
    folder = os.path.join(WORK, job["id"])
    shutil.rmtree(folder, ignore_errors=True)
    os.makedirs(folder)
    try:
        brand, logo = brand_for(project, assets, job)
        if logo:
            brand["logo"]["file"] = save(os.path.join(folder, "logo.png"), logo["file_key"])
        references = []
        for a in [a for a in assets if a["kind"] == "reference" and a["bytes"] < 8_000_000][:4]:
            ext = os.path.splitext(a["name"])[1] or ".png"
            name = f"ref-{len(references) + 1}{ext}"
            save(os.path.join(folder, name), a["file_key"])
            references.append((name, a["note"] or a["name"]))
        photo_file = ""
        if job.get("photo_id"):
            photo = next((a for a in assets if a["id"] == job["photo_id"]), None)
            if photo:
                photo_file = "ref-photo.jpg"
                save(os.path.join(folder, photo_file), photo["file_key"])

        text_job = job["job"] in ("new", "text")
        post = dict(job)
        if text_job:
            post.update(write_text(brand, job, folder, task["memory"], task["recent_headlines"], references, photo_file))
        if photo_file:
            background = Image.open(os.path.join(folder, photo_file)).convert("RGB")
        elif job["job"] == "text" and job.get("background_key"):
            background = Image.open(save(os.path.join(folder, "old-background.jpg"), job["background_key"])).convert("RGB")
        else:
            background = make_picture(post.get("image_prompt") or post.get("headline", ""), brand, job["aspect"], folder, references)
        post_jpg = images.compose(background, post["headline"], post.get("subtext", ""), brand, job["aspect"])
        data = {k: post.get(k) for k in ("headline", "subtext", "caption", "hashtags", "image_prompt", "learned", "hint")}
        call(f"/api/agent/result/{job['id']}", {"data": json.dumps(data)}, {"post": post_jpg, "background": jpeg(background)}, timeout=120)
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def work_once():
    task = call("/api/agent/next", {})
    if not task.get("job"):
        return False
    job = task["job"]
    log(f"{task['project']['name']}: {job['job']} {job['id']}")
    heartbeat(job["id"])
    try:
        do_job(task)
        log(f"{job['id']}: done")
    except Exception as e:
        traceback.print_exc()
        try:
            call(f"/api/agent/result/{job['id']}", {"data": json.dumps({"error": str(e)})}, {})
        except Exception:
            pass
        log(f"{job['id']}: failed: {e}")
    heartbeat()
    return True


def main():
    global cfg
    with open(CONFIG, encoding="utf-8") as f:
        cfg = json.load(f)
    os.makedirs(WORK, exist_ok=True)
    if os.name == "nt":
        ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), LOW_PRIORITY)
        # one helper at a time: two would grab the same jobs
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateMutexW(None, False, "MiMediaContentLabHelper")
        if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
            log("The helper is already running. Closing this copy.")
            return
    if "--once" in sys.argv:
        work_once()
        return
    log("Mi Media Content Lab brain is running. Keep this window open. Ctrl+C stops it.")
    last_beat = 0
    while True:
        try:
            if time.time() - last_beat > HEARTBEAT_EVERY:
                heartbeat()
                last_beat = time.time()
            if work_once():
                last_beat = time.time()
                continue  # more jobs may be waiting
        except Exception as e:
            log(f"problem: {e}")
        time.sleep(CHECK_EVERY)


if __name__ == "__main__":
    main()
