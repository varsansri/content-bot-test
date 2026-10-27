"""Posts a picture to Instagram (Instagram API with Instagram Login)."""
import base64
import os
import time

import requests

API_VERSION = os.getenv("IG_API_VERSION", "v23.0")
GRAPH = f"https://graph.instagram.com/{API_VERSION}"


class InstagramError(RuntimeError):
    pass


def _check(r):
    data = r.json()
    if "error" in data:
        err = data["error"]
        raise InstagramError(f"{err.get('message')} (code {err.get('code')})")
    return data


def whoami(token):
    """Return (user_id, username) for the token's Instagram account."""
    data = _check(requests.get(f"{GRAPH}/me", params={"fields": "user_id,username", "access_token": token}, timeout=30))
    return data["user_id"], data["username"]


def refresh_token(token):
    """Extend a long-lived token by another 60 days. Returns the new token."""
    r = requests.get(
        "https://graph.instagram.com/refresh_access_token",
        params={"grant_type": "ig_refresh_token", "access_token": token},
        timeout=30,
    )
    return _check(r)["access_token"]


def upload_public(jpeg_bytes):
    """Instagram fetches the picture from a public link, so host it on ImgBB for a day."""
    r = requests.post(
        "https://api.imgbb.com/1/upload",
        params={"key": os.environ["IMGBB_API_KEY"], "expiration": 86400},
        data={"image": base64.b64encode(jpeg_bytes).decode()},
        timeout=60,
    )
    data = r.json()
    if not data.get("success"):
        raise RuntimeError(f"Image upload failed: {data.get('error') or r.text[:200]}")
    return data["data"]["url"]


def publish(token, jpeg_bytes, caption, story=False):
    """Post the picture (to the feed, or as a story for 9:16). Returns the post's link."""
    user_id, _ = whoami(token)
    image_url = upload_public(jpeg_bytes)

    container = _check(requests.post(
        f"{GRAPH}/{user_id}/media",
        data={"image_url": image_url, "access_token": token,
              **({"media_type": "STORIES"} if story else {"caption": caption})},
        timeout=60,
    ))["id"]

    # Wait until Instagram has fetched the picture.
    for _ in range(30):
        status = _check(requests.get(
            f"{GRAPH}/{container}", params={"fields": "status_code", "access_token": token}, timeout=30
        )).get("status_code")
        if status == "FINISHED":
            break
        if status in ("ERROR", "EXPIRED"):
            raise InstagramError(f"Instagram could not process the picture ({status}).")
        time.sleep(2)

    media_id = _check(requests.post(
        f"{GRAPH}/{user_id}/media_publish",
        data={"creation_id": container, "access_token": token},
        timeout=60,
    ))["id"]

    try:
        return _check(requests.get(
            f"{GRAPH}/{media_id}", params={"fields": "permalink", "access_token": token}, timeout=30
        )).get("permalink", "")
    except Exception:
        return ""
