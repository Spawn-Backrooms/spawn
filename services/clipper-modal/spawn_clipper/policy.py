"""Admission rules for one isolated OpenShorts job and one source import.

The GPU process may download a single HTTPS object SPAWN already stored.
It must not ingest a video-platform URL, publish anywhere, or load the
OpenShorts commercial cloud/ tree.

URL ingest is a separate CPU function (``importer.py``). It accepts an
owner-supplied public HTTPS link, fetches it with a pinned yt-dlp limited to
the platform extractors below (or a direct file download), and writes one
MP4 to a SPAWN-signed upload URL. It never publishes and never uses cookies.
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import math
import os
import re
from pathlib import Path
from urllib.parse import urlparse

PIN_PATH = Path(__file__).resolve().parents[1] / "OPENSHORTS_PIN"
OPENSHORTS_COMMIT = PIN_PATH.read_text(encoding="utf-8").strip()
MAX_SOURCE_BYTES = 128 * 1024 * 1024
MAX_DURATION_MS = 30 * 60 * 1000
MAX_CLIP_MS = 60_000
MAX_CLIPS = 4
MAX_REQUEST_BYTES = 65_536
MAX_RENDER_REQUEST_BYTES = 262_144
MAX_CAPTION_WORDS = 256
MAX_CAPTION_WORD_TEXT = 64
# Keep aligned with creatorCaptionStyle in the shared Worker/frontend schema.
# A chosen style is a complete snapshot, never a partial patch to render defaults.
DEFAULT_CAPTION_STYLE = {
    "enabled": True, "font": "sans", "font_size": 80,
    "text_color": "#FFFFFF", "highlight_color": "#4CFFA9", "outline_color": "#000000",
    "outline_width": 5, "shadow": 2, "x_pct": 50, "y_pct": 56.25,
    "words_per_group": 3, "uppercase": True, "animation": "pop", "animation_ms": 80,
}
SIGNATURE_SKEW_SECONDS = 300
SUGGESTION_VERSION = "spawn-clip-suggestion-v1"

_JOB_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$")
_HEX64 = re.compile(r"^[a-f0-9]{64}$")
_COMMIT = re.compile(r"^[a-f0-9]{40}$")
# Hosts that mean "download someone else's video" rather than a signed object.
_PLATFORM_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "youtu.be",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
    "tiktok.com",
    "www.tiktok.com",
    "vm.tiktok.com",
    "instagram.com",
    "www.instagram.com",
    "twitter.com",
    "www.twitter.com",
    "x.com",
    "www.x.com",
    "vimeo.com",
    "www.vimeo.com",
    "twitch.tv",
    "www.twitch.tv",
    "clips.twitch.tv",
    "facebook.com",
    "www.facebook.com",
    "fb.watch",
}


class PolicyError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def assert_core_checkout(root: str | os.PathLike[str]) -> None:
    path = Path(root)
    if (path / "cloud").exists() or (path / "requirements-billing.txt").exists():
        raise PolicyError("OPENSHORTS_CLOUD_PRESENT")


def canonical_message(timestamp: str, method: str, path: str, body: bytes) -> bytes:
    return f"{timestamp}.{method.upper()}.{path}.".encode("utf-8") + body


def sign_request(secret: str, timestamp: str, method: str, path: str, body: bytes) -> str:
    return hmac.new(
        secret.encode("utf-8"),
        canonical_message(timestamp, method, path, body),
        hashlib.sha256,
    ).hexdigest()


def verify_request(
    secret: str,
    timestamp: str | None,
    signature: str | None,
    method: str,
    path: str,
    body: bytes,
    now: float,
) -> bool:
    # Header values are attacker-controlled. str.isdigit() also accepts unicode
    # digits such as '²' that int() cannot parse, and compare_digest() rejects
    # non-ASCII str operands with TypeError. Validate the wire form first so a
    # malformed header is a clean rejection, not a 500 in the API worker.
    if (
        not secret
        or not timestamp
        or not signature
        or not timestamp.isascii()
        or not timestamp.isdigit()
    ):
        return False
    try:
        signed_at = int(timestamp)
    except ValueError:
        return False
    if abs(signed_at - int(now)) > SIGNATURE_SKEW_SECONDS:
        return False
    candidate = signature.strip().lower()
    if not candidate.isascii():
        return False
    expected = sign_request(secret, timestamp, method, path, body)
    return hmac.compare_digest(expected, candidate)


def _parse_url(url: str, code: str):
    try:
        return urlparse(url)
    except ValueError as error:
        raise PolicyError(code) from error


def assert_direct_source_url(url: str) -> None:
    parsed = _parse_url(url, "URL_INGEST_DISABLED")
    host = (parsed.hostname or "").lower().rstrip(".")
    if (
        parsed.scheme != "https"
        or parsed.username
        or parsed.password
        or not host
        or host in _PLATFORM_HOSTS
        or host.endswith(".youtube.com")
        or host.endswith(".tiktok.com")
    ):
        raise PolicyError("URL_INGEST_DISABLED")


MAX_IMPORT_URL_LENGTH = 2048
# Raw download cap in private scratch before the file is fitted to MAX_SOURCE_BYTES.
MAX_IMPORT_DOWNLOAD_BYTES = 1024 * 1024 * 1024
_IMPORT_JOB_ID = re.compile(r"^srcimport_[A-Za-z0-9_-]{1,150}$")
# Host -> yt-dlp extractor names (matched case-insensitively and in full).
# No generic extractor: any other host is treated as a direct file download.
_IMPORT_PLATFORMS: dict[str, tuple[str, tuple[str, ...]]] = {}
for _host in ("youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"):
    _IMPORT_PLATFORMS[_host] = ("youtube", ("youtube",))
for _host in ("twitch.tv", "www.twitch.tv", "m.twitch.tv"):
    _IMPORT_PLATFORMS[_host] = ("twitch", ("twitch:vod", "twitch:clips"))
_IMPORT_PLATFORMS["clips.twitch.tv"] = ("twitch", ("twitch:clips",))
for _host in ("x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com", "mobile.x.com"):
    _IMPORT_PLATFORMS[_host] = ("x", ("twitter",))
for _host in ("vimeo.com", "www.vimeo.com", "player.vimeo.com"):
    _IMPORT_PLATFORMS[_host] = ("vimeo", ("vimeo",))
for _host in ("tiktok.com", "www.tiktok.com", "m.tiktok.com"):
    _IMPORT_PLATFORMS[_host] = ("tiktok", ("tiktok",))
_IMPORT_PLATFORMS["vm.tiktok.com"] = ("tiktok", ("vm.tiktok", "tiktok"))
_IMPORT_PLATFORMS["vt.tiktok.com"] = ("tiktok", ("vm.tiktok", "tiktok"))
_BLOCKED_SUFFIXES = (".localhost", ".local", ".internal", ".lan", ".home", ".corp", ".intranet", ".arpa")
_HOST_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")


def _is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host.strip("[]"))
        return True
    except ValueError:
        pass
    # Integer, hex and short dotted forms that resolvers treat as IPv4.
    return bool(re.fullmatch(r"(0x[0-9a-f]+|[0-9]+)(\.(0x[0-9a-f]+|[0-9]+)){0,3}", host))


def assert_public_import_host(host: str) -> None:
    """Refuse hosts that name this machine, a private network, or a bare IP address."""
    if (
        not host
        or len(host) > 253
        or host in ("localhost", "metadata", "metadata.google.internal")
        or host.endswith(_BLOCKED_SUFFIXES)
        or _is_ip_literal(host)
        or "." not in host
        or not all(_HOST_LABEL.fullmatch(label) for label in host.split("."))
    ):
        raise PolicyError("IMPORT_URL_PRIVATE")


def assert_public_addresses(addresses: list[str]) -> None:
    """Every resolved address must be globally routable. One private answer refuses the host."""
    if not addresses:
        raise PolicyError("IMPORT_FETCH_FAILED")
    for raw in addresses:
        try:
            address = ipaddress.ip_address(raw.split("%", 1)[0])
        except ValueError as error:
            raise PolicyError("IMPORT_URL_PRIVATE") from error
        mapped = getattr(address, "ipv4_mapped", None)
        if mapped is not None:
            address = mapped
        if (
            not address.is_global
            or address.is_multicast
            or address.is_reserved
            or address.is_loopback
            or address.is_link_local
            or address.is_private
            or address.is_unspecified
        ):
            raise PolicyError("IMPORT_URL_PRIVATE")


def classify_import_url(url: str) -> tuple[str, str, tuple[str, ...]]:
    """Return (kind, platform, extractors). kind is "platform" or "direct"."""
    if not isinstance(url, str) or not url or len(url) > MAX_IMPORT_URL_LENGTH:
        raise PolicyError("IMPORT_URL_INVALID")
    if any(ord(char) <= 0x20 or ord(char) == 0x7F for char in url):
        raise PolicyError("IMPORT_URL_INVALID")
    parsed = _parse_url(url, "IMPORT_URL_INVALID")
    if parsed.scheme != "https":
        raise PolicyError("IMPORT_URL_INVALID")
    if parsed.username or parsed.password or "@" in parsed.netloc:
        raise PolicyError("IMPORT_URL_INVALID")
    try:
        port = parsed.port
    except ValueError as error:
        raise PolicyError("IMPORT_URL_INVALID") from error
    if port not in (None, 443):
        raise PolicyError("IMPORT_URL_INVALID")
    host = (parsed.hostname or "").lower()
    if host.endswith("."):
        host = host[:-1]
    assert_public_import_host(host)
    platform = _IMPORT_PLATFORMS.get(host)
    if platform:
        return "platform", platform[0], platform[1]
    return "direct", "direct", ()


def parse_import_request(raw: bytes) -> dict:
    """An import names one public link and one signed upload URL. Nothing is published."""
    if len(raw) > MAX_REQUEST_BYTES:
        raise PolicyError("REQUEST_TOO_LARGE")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise PolicyError("REQUEST_INVALID") from error
    if not isinstance(payload, dict) or set(payload) != {
        "job_id",
        "source_url",
        "put_url",
        "max_bytes",
        "max_duration_ms",
    }:
        raise PolicyError("REQUEST_INVALID")
    job_id = payload.get("job_id")
    if not isinstance(job_id, str) or not _IMPORT_JOB_ID.fullmatch(job_id):
        raise PolicyError("REQUEST_INVALID")
    put = payload.get("put_url")
    if not isinstance(put, str):
        raise PolicyError("REQUEST_INVALID")
    assert_direct_source_url(put)
    classify_import_url(payload.get("source_url"))
    size = payload.get("max_bytes")
    duration = payload.get("max_duration_ms")
    if (
        not isinstance(size, int)
        or isinstance(size, bool)
        or not isinstance(duration, int)
        or isinstance(duration, bool)
        or not 1 <= size <= MAX_SOURCE_BYTES
        or not 1 <= duration <= MAX_DURATION_MS
    ):
        raise PolicyError("REQUEST_INVALID")
    return payload


def parse_job_request(raw: bytes) -> dict:
    if len(raw) > MAX_REQUEST_BYTES:
        raise PolicyError("REQUEST_TOO_LARGE")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise PolicyError("REQUEST_INVALID") from error
    if not isinstance(payload, dict):
        raise PolicyError("REQUEST_INVALID")
    job_id = payload.get("job_id")
    if not isinstance(job_id, str) or not _JOB_ID.fullmatch(job_id):
        raise PolicyError("REQUEST_INVALID")
    for field in ("source_get_url", "suggestion_put_url"):
        value = payload.get(field)
        if not isinstance(value, str):
            raise PolicyError("REQUEST_INVALID")
        assert_direct_source_url(value)
    render = payload.get("render_clips")
    urls = payload.get("clip_put_urls")
    if render is not False and render is not True:
        raise PolicyError("REQUEST_INVALID")
    if not isinstance(urls, list) or any(not isinstance(item, str) for item in urls):
        raise PolicyError("REQUEST_INVALID")
    for item in urls:
        assert_direct_source_url(item)
    max_clips = payload.get("max_clips")
    if type(max_clips) is not int or not 1 <= max_clips <= MAX_CLIPS:
        raise PolicyError("REQUEST_INVALID")
    if render and len(urls) != max_clips:
        raise PolicyError("REQUEST_INVALID")
    if not render and urls:
        raise PolicyError("REQUEST_INVALID")
    if payload.get("aspect") not in ("9:16", "16:9"):
        raise PolicyError("REQUEST_INVALID")
    sha = payload.get("source_sha256")
    if not isinstance(sha, str) or not _HEX64.fullmatch(sha):
        raise PolicyError("REQUEST_INVALID")
    size = payload.get("source_bytes")
    duration = payload.get("duration_ms")
    if (
        type(size) is not int
        or type(duration) is not int
        or not 1 <= size <= MAX_SOURCE_BYTES
        or not 1 <= duration <= MAX_DURATION_MS
    ):
        raise PolicyError("REQUEST_INVALID")
    commit = payload.get("openshorts_commit")
    if commit != OPENSHORTS_COMMIT or not isinstance(commit, str) or not _COMMIT.fullmatch(commit):
        raise PolicyError("REQUEST_INVALID")
    return payload


def refuse_publish_environment(env: dict[str, str] | None = None) -> None:
    current = env if env is not None else dict(os.environ)
    billing = current.get("BILLING_ENABLED", "")
    if billing not in ("", "0", "false"):
        raise PolicyError("BILLING_DISABLED")
    for name in ("UPLOAD_POST_API_KEY", "FAL_KEY", "ELEVENLABS_API_KEY"):
        if current.get(name):
            raise PolicyError("SOCIAL_PUBLISH_DISABLED")


def windows_from_transcript(
    segments: list[dict],
    duration_ms: int,
    max_clips: int,
) -> list[dict]:
    """Group speech into reviewable ranges when no moment-picker model is configured.

    This is not a virality score. OpenShorts still supplies the transcript.
    """
    clips: list[dict] = []
    start = None
    last_end = None
    texts: list[str] = []
    def append_usable(window_start: int, speech_end: int) -> None:
        clip = _window(window_start, speech_end, texts, duration_ms)
        if clip["out_ms"] - clip["in_ms"] >= 1000:
            clips.append(clip)

    for segment in segments:
        try:
            seg_start = int(segment.get("start_ms"))
            seg_end = int(segment.get("end_ms"))
        except (TypeError, ValueError):
            continue
        text = str(segment.get("text") or "").strip()
        if seg_end <= seg_start or seg_start < 0 or seg_end > duration_ms or not text:
            continue
        if start is None:
            start = seg_start
        if seg_end - start > 45_000 and last_end is not None:
            # End at the last speech, not at the next segment's start:
            # the gap between bursts is silence, not a moment worth clipping.
            append_usable(start, last_end)
            texts = []
            start = seg_start
            last_end = None
            if len(clips) >= max_clips:
                break
        texts.append(text)
        last_end = seg_end if last_end is None else max(last_end, seg_end)
        if last_end - start >= 15_000:
            append_usable(start, last_end)
            texts = []
            start = None
            last_end = None
            if len(clips) >= max_clips:
                break
    if start is not None and last_end is not None and len(clips) < max_clips:
        append_usable(start, last_end)
    return clips[:max_clips]


def _window(start: int, end: int, texts: list[str], duration_ms: int) -> dict:
    end = min(end, duration_ms, start + MAX_CLIP_MS)
    caption = " ".join(texts).strip()[:240]
    return {
        "in_ms": start,
        "out_ms": end,
        "captions": [{"start_ms": start, "end_ms": end, "text": caption}] if caption else [],
        "title": None,
    }


def moment_picker(env: dict[str, str] | None = None) -> tuple[str, bool]:
    current = env if env is not None else dict(os.environ)
    if current.get("GEMINI_API_KEY"):
        return "gemini", True
    base = current.get("LLM_BASE_URL", "")
    if base:
        host = (urlparse(base).hostname or "").lower()
        leaves = host not in ("localhost", "127.0.0.1", "::1")
        return "local_llm", leaves
    return "transcript_windows_no_llm", False


def parse_render_request(raw: bytes) -> dict:
    """A render names the clips SPAWN already chose. It does not pick moments or publish."""
    if len(raw) > MAX_RENDER_REQUEST_BYTES:
        raise PolicyError("REQUEST_TOO_LARGE")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise PolicyError("REQUEST_INVALID") from error
    if not isinstance(payload, dict):
        raise PolicyError("REQUEST_INVALID")
    job_id = payload.get("job_id")
    if not isinstance(job_id, str) or not _JOB_ID.fullmatch(job_id):
        raise PolicyError("REQUEST_INVALID")
    source = payload.get("source_get_url")
    if not isinstance(source, str):
        raise PolicyError("REQUEST_INVALID")
    assert_direct_source_url(source)
    sha = payload.get("source_sha256")
    size = payload.get("source_bytes")
    duration = payload.get("duration_ms")
    if (
        type(sha) is not str
        or not _HEX64.fullmatch(sha)
        or type(size) is not int
        or type(duration) is not int
        or not 1 <= size <= MAX_SOURCE_BYTES
        or not 1 <= duration <= MAX_DURATION_MS
        or payload.get("openshorts_commit") != OPENSHORTS_COMMIT
    ):
        raise PolicyError("REQUEST_INVALID")
    clips = payload.get("clips")
    if not isinstance(clips, list) or not 1 <= len(clips) <= MAX_CLIPS:
        raise PolicyError("REQUEST_INVALID")
    for clip in clips:
        if not isinstance(clip, dict):
            raise PolicyError("REQUEST_INVALID")
        put = clip.get("put_url")
        if not isinstance(put, str):
            raise PolicyError("REQUEST_INVALID")
        assert_direct_source_url(put)
        start = clip.get("in_ms")
        end = clip.get("out_ms")
        if (
            type(start) is not int
            or type(end) is not int
            or start < 0
            or end - start < 1000
            or end - start > MAX_CLIP_MS
            or end > duration
            or clip.get("aspect") != "9:16"
        ):
            raise PolicyError("REQUEST_INVALID")
        if clip.get("framing", "manual") not in ("auto", "contain", "manual"):
            raise PolicyError("REQUEST_INVALID")
        if "caption_words" in clip:
            validate_caption_words(clip["caption_words"], end - start)
        if "caption_style" in clip:
            clip["caption_style"] = validate_caption_style(clip["caption_style"])
    return payload


def validate_caption_style(style: object) -> dict:
    """No arbitrary font paths, ASS fragments, CSS, or unbounded layout values."""
    if not isinstance(style, dict) or set(style) != set(DEFAULT_CAPTION_STYLE):
        raise PolicyError("REQUEST_INVALID")
    for key in ("enabled", "uppercase"):
        if type(style[key]) is not bool:
            raise PolicyError("REQUEST_INVALID")
    for key, allowed in (("font", ("sans", "condensed", "mono")),
                         ("animation", ("none", "pop", "fade", "rise"))):
        if style[key] not in allowed:
            raise PolicyError("REQUEST_INVALID")
    for key, low, high in (("font_size", 40, 112), ("outline_width", 0, 10),
                           ("shadow", 0, 6), ("words_per_group", 1, 4),
                           ("animation_ms", 80, 400)):
        if type(style[key]) is not int or not low <= style[key] <= high:
            raise PolicyError("REQUEST_INVALID")
    for key in ("x_pct", "y_pct"):
        if type(style[key]) not in (int, float) or not 10 <= style[key] <= 90 or not math.isfinite(style[key]):
            raise PolicyError("REQUEST_INVALID")
    normalized = dict(style)
    for key in ("text_color", "highlight_color", "outline_color"):
        if not isinstance(style[key], str) or not re.fullmatch(r"#[0-9A-Fa-f]{6}", style[key]):
            raise PolicyError("REQUEST_INVALID")
        normalized[key] = style[key].upper()
    return normalized


def validate_caption_words(words: object, duration_ms: int) -> None:
    """Word intervals are relative to the selected clip and cannot overlap."""
    if not isinstance(words, list) or not 1 <= len(words) <= MAX_CAPTION_WORDS:
        raise PolicyError("REQUEST_INVALID")
    previous_end = 0
    for word in words:
        if not isinstance(word, dict) or set(word) != {"from_ms", "to_ms", "text"}:
            raise PolicyError("REQUEST_INVALID")
        start, end, text = word["from_ms"], word["to_ms"], word["text"]
        if (
            type(start) is not int
            or type(end) is not int
            or not previous_end <= start < end <= duration_ms
            or not isinstance(text, str)
            or not text.strip()
            or len(text) > MAX_CAPTION_WORD_TEXT
        ):
            raise PolicyError("REQUEST_INVALID")
        previous_end = end


def suggestion_document(
    job: dict,
    transcript: dict,
    clips: list[dict],
    *,
    moment: str,
    audio_left_infra: bool,
    frame: dict | None,
) -> dict:
    return {
        "version": SUGGESTION_VERSION,
        "job_id": job["job_id"],
        "openshorts_commit": OPENSHORTS_COMMIT,
        "moment_picker": moment,
        "audio_left_infra": audio_left_infra,
        "render_clips": bool(job.get("render_clips")),
        "duration_ms": job["duration_ms"],
        "frame": frame,
        "transcript": transcript,
        "clips": clips,
    }
