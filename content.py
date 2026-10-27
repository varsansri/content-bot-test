"""Writes the post text (headline, caption, hashtags, picture idea) with Claude."""
import base64
import json

MODEL = "claude-opus-5-5"

POST_SCHEMA = {
    "type": "object",
    "properties": {
        "topic": {"type": "string"},
        "headline": {"type": "string"},
        "subtext": {"type": "string"},
        "caption": {"type": "string"},
        "hashtags": {"type": "array", "items": {"type": "string"}},
        "image_prompt": {"type": "string"},
    },
    "required": ["topic", "headline", "subtext", "caption", "hashtags", "image_prompt"],
    "additionalProperties": False,
}

_client = None


def _get_client():
    global _client
    if _client is None:
        import anthropic  # only needed when Claude writes (the PC helper uses Antigravity)
        _client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY
    return _client


def _system_prompt(brand):
    examples = "\n\n".join(f"- {c}" for c in brand.get("example_captions", []))
    return f"""You write Instagram posts for the brand "{brand['brand_name']}" ({brand.get('instagram_handle', '')}).

About the account: {brand.get('about', '')}
Voice: {brand.get('voice', '')}
Write in: {brand.get('language', 'English')}

Every post is one picture (4:5) with a short headline printed on it, plus a caption.

Rules for each field:
- topic: the subject of this post in a few words.
- headline: printed big on the picture. At most 8 words. Punchy, no hashtags, no emojis.
- subtext: one short line printed under the headline (at most 14 words), or "" if not needed.
- caption: the Instagram caption. Hook in the first line, then useful content, then a call to action. Line breaks are fine. Do NOT put hashtags in the caption. Under 1500 characters.
- hashtags: {brand.get('hashtag_count', 8)} relevant hashtags, each starting with #. Mix popular and niche.
- image_prompt: a description for an AI image generator of the BACKGROUND picture only. Visual scene, no words. Never ask for text, letters, logos or watermarks in the picture. The style is added automatically, so describe only the scene.

Example captions in the brand's voice:
{examples or '- (none given)'}"""


def write_post(brand, topic=None, recent_headlines=(), photo_bytes=None, photo_mime="image/jpeg"):
    """Return a dict with topic, headline, subtext, caption, hashtags, image_prompt."""
    if topic:
        ask = f"Write a post about: {topic}"
    else:
        topics = "\n".join(f"- {t}" for t in brand.get("topics", []))
        ask = f"Pick a fresh angle from one of these topics and write a post:\n{topics}"
    if recent_headlines:
        ask += "\n\nDo not repeat these recent headlines or their ideas:\n" + "\n".join(
            f"- {h}" for h in recent_headlines
        )

    content = []
    if photo_bytes:
        content.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": photo_mime,
                "data": base64.standard_b64encode(photo_bytes).decode(),
            },
        })
        ask += "\n\nThe attached photo will be the picture of this post. Write about it. image_prompt can be \"\"."
    content.append({"type": "text", "text": ask})

    response = _get_client().beta.messages.create(
        model=MODEL,
        max_tokens=8000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        output_config={
            "effort": "medium",
            "format": {"type": "json_schema", "schema": POST_SCHEMA},
        },
        system=_system_prompt(brand),
        messages=[{"role": "user", "content": content}],
    )
    if response.stop_reason == "refusal":
        raise RuntimeError("Claude declined this topic. Try a different one.")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("Claude's answer was cut off. Try again.")
    text = next(b.text for b in response.content if b.type == "text")
    post = json.loads(text)

    always = brand.get("always_hashtags", [])
    tags = [t if t.startswith("#") else "#" + t for t in post["hashtags"]]
    post["hashtags"] = list(dict.fromkeys(always + tags))[:30]  # Instagram allows 30
    return post


def full_caption(post):
    caption = post["caption"].strip()
    if post.get("hashtags"):
        caption += "\n\n" + " ".join(post["hashtags"])
    return caption[:2200]  # Instagram caption limit
