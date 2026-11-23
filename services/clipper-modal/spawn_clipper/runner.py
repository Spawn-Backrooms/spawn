"""Run one OpenShorts clip-generator job in a fresh directory and exit.

URL ingest, social publishing, dubbing, and the commercial cloud/ tree are
refused. Rendering a vertical MP4 happens only when the request asks for it.
SPAWN does not ask for it.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse

import httpx

from spawn_clipper.policy import (
    DEFAULT_CAPTION_STYLE,
    OPENSHORTS_COMMIT,
    MAX_CAPTION_WORDS,
    MAX_CAPTION_WORD_TEXT,
    PolicyError,
    assert_core_checkout,
    assert_direct_source_url,
    refuse_publish_environment,
    suggestion_document,
    validate_caption_style,
    validate_caption_words,
    windows_from_transcript,
)

CORE_ROOT = os.environ.get("OPENSHORTS_ROOT", "/opt/openshorts")


def run_job(job: dict) -> dict:
    refuse_publish_environment()
    if os.path.isdir(CORE_ROOT):
        assert_core_checkout(CORE_ROOT)
    work = tempfile.mkdtemp(prefix=f"spawn-clip-{job['job_id']}-")
    try:
        source = Path(work) / "source"
        _download(job["source_get_url"], source, job["source_bytes"], job["source_sha256"])
        _block_url_ingest()
        transcript, frame, _picked = _openshorts(source, job)
        clips = windows_from_transcript(
            transcript.get("segments") or [],
            int(job["duration_ms"]),
            int(job["max_clips"]),
        )
        moment, audio_left = "transcript_windows_no_llm", False
        for clip in clips:
            clip["aspect"] = job["aspect"]
            clip["captions"] = _captions_between(transcript, clip["in_ms"], clip["out_ms"])
            clip.setdefault("crop", _center_crop(frame, job["aspect"]))
            clip.setdefault("face_track", None)
        _attach_face_tracks(source, clips, frame)
        if job.get("render_clips"):
            _render(source, clips, job, work)
        else:
            for clip in clips:
                clip["rendered_object"] = None
        document = suggestion_document(
            job,
            transcript,
            clips,
            moment=moment,
            audio_left_infra=audio_left,
            frame=frame,
        )
        body = _canonical_bytes(document)
        _put(job["suggestion_put_url"], body, "application/json")
        return {
            "state": "succeeded",
            "suggestion_sha256": hashlib.sha256(body).hexdigest(),
            "openshorts_commit": OPENSHORTS_COMMIT,
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _canonical_bytes(document: dict) -> bytes:
    import json

    return json.dumps(document, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _download(url: str, dest: Path, expected_bytes: int, expected_sha: str) -> None:
    assert_direct_source_url(url)
    digest = hashlib.sha256()
    count = 0
    with httpx.stream("GET", url, follow_redirects=False, timeout=120.0) as response:
        if response.status_code != 200:
            raise PolicyError("SOURCE_FETCH_FAILED")
        with dest.open("wb") as handle:
            for chunk in response.iter_bytes():
                count += len(chunk)
                if count > expected_bytes:
                    raise PolicyError("SOURCE_TOO_LARGE")
                digest.update(chunk)
                handle.write(chunk)
    if count != expected_bytes or digest.hexdigest() != expected_sha:
        raise PolicyError("SOURCE_DIGEST_MISMATCH")


def _put(url: str, body: bytes, content_type: str) -> None:
    assert_direct_source_url(url)
    response = httpx.put(
        url,
        content=body,
        headers={"content-type": content_type},
        follow_redirects=False,
        timeout=120.0,
    )
    if response.status_code not in (200, 201, 204):
        raise PolicyError("SUGGESTION_UPLOAD_FAILED")


def _block_url_ingest() -> None:
    try:
        import yt_dlp
    except ImportError:
        return

    def blocked(*_args, **_kwargs):
        raise PolicyError("URL_INGEST_DISABLED")

    yt_dlp.YoutubeDL = blocked


def _openshorts(source: Path, job: dict):
    """Transcribe with OpenShorts and optionally let its moment picker choose clips."""
    if CORE_ROOT not in sys.path:
        sys.path.insert(0, CORE_ROOT)
    os.environ.setdefault("BILLING_ENABLED", "0")
    os.environ.setdefault("ENABLE_URL_INGEST", "0")
    import main  # OpenShorts MIT core, pinned in the image.

    _block_url_ingest()
    main.download_youtube_video = _blocked
    if hasattr(main, "_download_youtube_video"):
        main._download_youtube_video = _blocked
    transcript_raw = main.transcribe_video(str(source))
    transcript = _transcript(transcript_raw, int(job["duration_ms"]))
    frame = _frame(source)
    # Moment picking stays on SPAWN's OpenRouter call. This process does not
    # receive a Gemini or OpenRouter key.
    return transcript, frame, None


def _blocked(*_args, **_kwargs):
    raise PolicyError("URL_INGEST_DISABLED")


def _transcript(raw: dict, duration_ms: int) -> dict:
    segments = []
    for segment in ((raw or {}).get("segments") or [])[:512]:
        if not isinstance(segment, dict):
            continue
        try:
            start = int(round(float(segment.get("start", 0)) * 1000))
            end = int(round(float(segment.get("end", 0)) * 1000))
        except (TypeError, ValueError, OverflowError):
            continue
        text = str(segment.get("text") or "").strip()
        if text and 0 <= start < end <= duration_ms:
            normalized = {"start_ms": start, "end_ms": end, "text": text[:500]}
            words = _transcript_words(segment.get("words"), start, end)
            if words:
                normalized["words"] = words
            segments.append(normalized)
    language = str((raw or {}).get("language") or "unknown")[:32]
    return {"language": language, "segments": segments[:512]}


def _transcript_words(raw: object, start: int, end: int) -> list[dict]:
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_CAPTION_WORDS:
        return []
    words = []
    previous_end = start
    for word in raw:
        if not isinstance(word, dict) or not isinstance(word.get("word"), str):
            return []
        try:
            word_start = int(round(float(word["start"]) * 1000))
            word_end = int(round(float(word["end"]) * 1000))
        except (KeyError, TypeError, ValueError, OverflowError):
            return []
        text = word["word"].strip()
        if not text or len(text) > MAX_CAPTION_WORD_TEXT or not previous_end <= word_start < word_end <= end:
            return []
        words.append({"start_ms": word_start, "end_ms": word_end, "text": text})
        previous_end = word_end
    return words


def _frame(source: Path) -> dict | None:
    try:
        import cv2
    except ImportError:
        return None
    capture = cv2.VideoCapture(str(source))
    try:
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    finally:
        capture.release()
    if width <= 0 or height <= 0:
        return None
    return {"width": width, "height": height}


def _from_shorts(shorts: list, transcript: dict, job: dict, frame: dict | None) -> list[dict]:
    clips = []
    duration = int(job["duration_ms"])
    for short in shorts[: int(job["max_clips"])]:
        try:
            start = int(round(float(short.get("start", 0)) * 1000))
            end = int(round(float(short.get("end", 0)) * 1000))
        except (TypeError, ValueError):
            continue
        end = min(end, start + 60_000, duration)
        if start < 0 or end <= start:
            continue
        title = short.get("title") or short.get("hook")
        clips.append(
            {
                "in_ms": start,
                "out_ms": end,
                "title": str(title)[:120] if title else None,
                "captions": _captions_between(transcript, start, end),
                "crop": _center_crop(frame, job["aspect"]),
                "face_track": None,
            }
        )
    return clips


def _captions_between(transcript: dict, start: int, end: int) -> list[dict]:
    captions = []
    for segment in transcript.get("segments") or []:
        if segment["end_ms"] <= start or segment["start_ms"] >= end:
            continue
        captions.append(
            {
                "start_ms": max(segment["start_ms"], start),
                "end_ms": min(segment["end_ms"], end),
                "text": segment["text"],
            }
        )
        if len(captions) >= 32:
            break
    return captions


def _attach_face_tracks(source: Path, clips: list[dict], frame: dict | None) -> None:
    """Best-effort MediaPipe sample. A missing model does not fail the suggestion."""
    if not frame:
        return
    try:
        import cv2
        import main
    except ImportError:
        return
    capture = cv2.VideoCapture(str(source))
    try:
        fps = capture.get(cv2.CAP_PROP_FPS) or 30
        width = frame["width"]
        height = frame["height"]
        for clip in clips:
            midpoint = (clip["in_ms"] + clip["out_ms"]) / 2000
            capture.set(cv2.CAP_PROP_POS_FRAMES, int(midpoint * fps))
            ok, image = capture.read()
            if not ok:
                continue
            candidates = main.detect_face_candidates(image) or []
            if not candidates:
                continue
            box = max(candidates, key=lambda item: item.get("score") or 0)["box"]
            x, y, w, h = box
            track = {
                "t_ms": int((clip["in_ms"] + clip["out_ms"]) / 2),
                "x": max(0, min(1, x / width)),
                "y": max(0, min(1, y / height)),
                "width": max(0, min(1, w / width)),
                "height": max(0, min(1, h / height)),
            }
            clip["face_track"] = [track]
            if clip["aspect"] == "9:16":
                clip["crop"] = _crop_around(track, width / height)
    except Exception:
        return
    finally:
        capture.release()


def _crop_around(face: dict, frame_aspect: float) -> dict:
    norm_w = min(1.0, (9 / 16) / frame_aspect)
    center = face["x"] + face["width"] / 2
    x = min(max(0.0, center - norm_w / 2), 1 - norm_w)
    return {"x": x, "y": 0, "width": norm_w, "height": 1}


def _center_crop(frame: dict | None, aspect: str) -> dict | None:
    if aspect != "9:16" or not frame:
        return {"x": 0, "y": 0, "width": 1, "height": 1} if aspect == "16:9" else None
    ratio = frame["width"] / frame["height"]
    width = min(1.0, (9 / 16) / ratio)
    return {"x": (1 - width) / 2, "y": 0, "width": width, "height": 1}


def _render(source: Path, clips: list[dict], job: dict, work: str) -> None:
    """Optional vertical renders. SPAWN leaves render_clips false."""
    if CORE_ROOT not in sys.path:
        sys.path.insert(0, CORE_ROOT)
    import main

    urls = job.get("clip_put_urls") or []
    for index, clip in enumerate(clips):
        cut = Path(work) / f"cut-{index}.mp4"
        rendered = Path(work) / f"vertical-{index}.mp4"
        start = clip["in_ms"] / 1000
        end = clip["out_ms"] / 1000
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-ss",
                f"{start:.3f}",
                "-to",
                f"{end:.3f}",
                "-i",
                str(source),
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-c:a",
                "aac",
                str(cut),
            ],
            check=True,
            capture_output=True,
        )
        aspect = 9 / 16 if job["aspect"] == "9:16" else 16 / 9
        main.process_video_to_vertical(str(cut), str(rendered), aspect_ratio=aspect, watermark=False)
        body = rendered.read_bytes()
        if len(body) > 64 * 1024 * 1024:
            raise PolicyError("RENDER_TOO_LARGE")
        _put(urls[index], body, "video/mp4")
        clip["rendered_object"] = {"bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()}


def host_of(url: str) -> str:
    return (urlparse(url).hostname or "").lower()


def render_chosen(job: dict, on_clip=None) -> dict:
    """Cut the owner's chosen ranges to private 9:16 MP4s. No moment picker and no publish.

    ``on_clip`` is called with each finished clip's record right after its
    upload, so a status poll can see real progress while later clips are
    still rendering.
    """
    refuse_publish_environment()
    work = tempfile.mkdtemp(prefix=f"spawn-render-{job['job_id']}-")
    try:
        source = Path(work) / "source"
        _download(job["source_get_url"], source, job["source_bytes"], job["source_sha256"])
        _block_url_ingest()
        width, height = _probe_size(source)
        renders = []
        for index, clip in enumerate(job["clips"]):
            output = Path(work) / f"clip-{index}.mp4"
            _encode_vertical(source, output, clip, width, height)
            body = output.read_bytes()
            if len(body) > 64 * 1024 * 1024:
                raise PolicyError("RENDER_TOO_LARGE")
            _put(clip["put_url"], body, "video/mp4")
            record = {
                "index": index,
                "bytes": len(body),
                "sha256": hashlib.sha256(body).hexdigest(),
            }
            renders.append(record)
            if on_clip is not None:
                # Report the finished clip now: the status view is the only
                # progress channel, and a later clip may still fail.
                on_clip(record)
        manifest = json.dumps(renders, separators=(",", ":"), sort_keys=True).encode()
        return {
            "suggestion_sha256": hashlib.sha256(manifest).hexdigest(),
            "renders": renders,
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _probe_size(source: Path) -> tuple[int, int]:
    probe = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", str(source),
        ],
        capture_output=True, text=True, check=False,
    )
    parts = (probe.stdout or "").strip().split("x")
    if probe.returncode != 0 or len(parts) != 2:
        raise PolicyError("RENDER_FAILED")
    width, height = int(parts[0]), int(parts[1])
    if width <= 0 or height <= 0:
        raise PolicyError("RENDER_FAILED")
    return width, height


def _encode_vertical(source: Path, output: Path, clip: dict, width: int, height: int) -> None:
    framing = clip.get("framing", "manual")
    crop = clip.get("crop") or {"x": 0.3, "y": 0, "width": 0.4, "height": 1}
    x = max(0, min(width - 2, int(crop["x"] * width)))
    y = max(0, min(height - 2, int(crop["y"] * height)))
    w = max(2, min(width - x, int(crop["width"] * width)))
    h = max(2, min(height - y, int(crop["height"] * height)))
    captions = Path(output).with_suffix(".ass")
    captions.write_text(_ass(
        clip.get("captions") or [], clip.get("caption_words"),
        duration_ms=clip["out_ms"] - clip["in_ms"],
        caption_style=clip.get("caption_style"),
    ), encoding="utf-8")
    start = clip["in_ms"] / 1000
    end = clip["out_ms"] / 1000
    if framing in ("auto", "contain"):
        from spawn_clipper.framing import reframe_clip
        # Cut exactly once, then track the complete reviewed clip. Caption
        # timestamps stay relative to that cut, not the original source.
        cut = Path(output).with_suffix(".cut.mp4")
        reframed = Path(output).with_suffix(".framed.mp4")
        try:
            subprocess.run([
                "ffmpeg", "-v", "error", "-y", "-ss", f"{start:.3f}",
                "-t", f"{end - start:.3f}", "-i", str(source),
                "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264",
                "-preset", "veryfast", "-crf", "18", "-c:a", "aac", str(cut),
            ], check=True, capture_output=True, timeout=180)
            actual = reframe_clip(cut, reframed, CORE_ROOT, framing)
            print(f"SPAWN clip framing: {actual}", flush=True)
            subprocess.run([
                "ffmpeg", "-v", "error", "-y", "-i", str(reframed),
                "-vf", f"subtitles={captions},setsar=1", "-map", "0:v:0", "-map", "0:a?",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                "-maxrate", "6M", "-bufsize", "12M", "-c:a", "aac",
                "-movflags", "+faststart", str(output),
            ], check=True, capture_output=True, timeout=180)
        finally:
            cut.unlink(missing_ok=True)
            reframed.unlink(missing_ok=True)
        return
    subprocess.run(
        [
            "ffmpeg", "-y", "-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", str(source),
            "-vf", f"crop={w}:{h}:{x}:{y},scale=720:1280,subtitles={captions}",
            "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", str(output),
        ],
        check=True, capture_output=True,
    )


def _ass(captions: list, caption_words: list | None = None, *, duration_ms: int = 60_000,
         caption_style: dict | None = None) -> str:
    style = validate_caption_style(caption_style) if caption_style is not None else DEFAULT_CAPTION_STYLE
    font_name = _CAPTION_FONTS[style["font"]][0]
    foreground = _ass_color(style["text_color"])
    outline = _ass_color(style["outline_color"])
    lines = [
        "[Script Info]", "ScriptType: v4.00+", "PlayResX: 720", "PlayResY: 1280",
        "ScaledBorderAndShadow: yes", "WrapStyle: 2", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: Default,Arial,42,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,0,2,40,40,80,1",
        f"Style: Karaoke,{font_name},{style['font_size']},&H00{foreground},&H00{outline},&H80{outline},-1,0,0,0,100,100,0,0,1,{style['outline_width']},{style['shadow']},5,44,44,0,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    if not style["enabled"]:
        return "\n".join(lines) + "\n"
    if caption_words and _words_match_captions(captions, caption_words, duration_ms):
        lines.extend(_karaoke_events(caption_words, style))
        return "\n".join(lines) + "\n"
    for caption in captions[:32]:
        text = _ass_literal(str(caption.get("text") or "")[:240])
        if not text:
            continue
        start = max(0, int(caption.get("from_ms") or 0))
        end = min(duration_ms, int(caption.get("to_ms") or 0))
        if end <= start:
            continue
        if caption_style is None:
            # Historical, sentence-only requests retain their original appearance.
            lines.append(f"Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Default,,0,0,0,,{{\\q0}}{text}")
        else:
            # Style sentence captions honestly; never invent word timing.
            group = [{"text": word} for word in text.split()]
            font_size, line_break = _group_layout(group, style)
            x, y = _group_position(group, style, font_size, line_break)
            texts = [_display_word(word["text"], style) for word in group]
            text = " ".join(texts) if line_break is None else " ".join(texts[:line_break]) + r"\N" + " ".join(texts[line_break:])
            tags = _entrance_tags(style, x, y, 0)
            lines.append(f"Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Karaoke,,0,0,0,,{{\\an5\\q2\\fs{font_size}{tags}}}{text}")
    return "\n".join(lines) + "\n"


def _ass_literal(text: str) -> str:
    text = " ".join(text.split())
    return text.translate(str.maketrans({"\\": "＼", "{": "｛", "}": "｝"}))


def _words_match_captions(captions: list, words: list, duration_ms: int) -> bool:
    try:
        validate_caption_words(words, duration_ms)
    except PolicyError:
        return False
    normalize = lambda text: " ".join(unicodedata.normalize("NFKC", text).lower().split())
    caption_text = " ".join(str(caption.get("text") or "") for caption in captions)
    return normalize(caption_text) == normalize(" ".join(word["text"] for word in words))


_CAPTION_FONTS = {
    "sans": ("DejaVu Sans", "DejaVuSans-Bold.ttf"),
    "condensed": ("DejaVu Sans Condensed", "DejaVuSansCondensed-Bold.ttf"),
    "mono": ("DejaVu Sans Mono", "DejaVuSansMono-Bold.ttf"),
}


def _ass_color(hex_color: str) -> str:
    return hex_color[5:7] + hex_color[3:5] + hex_color[1:3]


def _display_word(text: str, style: dict) -> str:
    return _ass_literal(text.upper() if style["uppercase"] else text)


@lru_cache(maxsize=384)
def _caption_font(size: int, family: str = "sans"):
    from PIL import ImageFont

    return ImageFont.truetype("/usr/share/fonts/truetype/dejavu/" + _CAPTION_FONTS[family][1], size)


def _group_layout(group: list[dict], style: dict = DEFAULT_CAPTION_STYLE) -> tuple[int, int | None]:
    texts = [_display_word(word["text"], style) for word in group]
    size = style["font_size"]
    font = _caption_font(size, style["font"])
    if font.getlength(" ".join(texts)) <= 620:
        return size, None
    breaks = list(range(1, len(texts))) or [None]
    def width(at, face):
        rows = [" ".join(texts)] if at is None else [" ".join(texts[:at]), " ".join(texts[at:])]
        return max(face.getlength(row) for row in rows)
    split = min(breaks, key=lambda at: width(at, font))
    # Legacy sentence captions may contain a single 240-character URL/token.
    # Keep fitting below the normal word size floor rather than place it offscreen.
    while size > 1 and width(split, _caption_font(size, style["font"])) > 620:
        size -= 1
    return size, split


def _group_position(group: list[dict], style: dict, size: int, split: int | None) -> tuple[float, float]:
    """Clamp the complete text block, including its entrance, inside safe margins."""
    texts = [_display_word(word["text"], style) for word in group]
    rows = [" ".join(texts)] if split is None else [" ".join(texts[:split]), " ".join(texts[split:])]
    face = _caption_font(size, style["font"])
    half_width = max(face.getlength(row) for row in rows) / 2
    half_height = sum(face.getmetrics()) * len(rows) / 2
    edge = style["outline_width"] + style["shadow"]
    x_margin, y_margin = 36 + edge + half_width, 96 + edge + half_height
    x = max(x_margin, min(720 - x_margin, style["x_pct"] * 7.2))
    rise = 24 if style["animation"] == "rise" else 0
    y = max(y_margin, min(1280 - y_margin - rise, style["y_pct"] * 12.8))
    return round(x, 2), round(y, 2)


def _entrance_tags(style: dict, x: float, y: float, elapsed: int) -> str:
    duration = style["animation_ms"]
    position = f"\\pos({x:g},{y:g})"
    if style["animation"] == "none" or elapsed >= duration:
        return position
    remaining = duration - elapsed
    progress = elapsed / duration
    # Each ASS event begins on a word boundary. Continue the group animation
    # from its elapsed position; do not restart or compress it into one word.
    if style["animation"] == "pop":
        scale = 92 + 8 * progress
        return position + f"\\fscx{scale:g}\\fscy{scale:g}\\t(0,{remaining},\\fscx100\\fscy100)"
    if style["animation"] == "fade":
        alpha = round(255 * (1 - progress))
        shadow_alpha = 128 + round(127 * (1 - progress))
        return position + (
            f"\\1a&H{alpha:02X}&\\3a&H{alpha:02X}&\\4a&H{shadow_alpha:02X}&"
            f"\\t(0,{remaining},\\1a&H00&\\3a&H00&\\4a&H80&)"
        )
    offset = 24 * (1 - progress)
    return f"\\move({x:g},{y + offset:g},{x:g},{y:g},0,{remaining})"


def _karaoke_events(words: list[dict], style: dict = DEFAULT_CAPTION_STYLE) -> list[str]:
    groups: list[list[dict]] = []
    for word in words:
        if not groups or len(groups[-1]) == style["words_per_group"] or word["from_ms"] - groups[-1][-1]["to_ms"] > 350:
            groups.append([])
        groups[-1].append(word)
    lines = []
    for group in groups:
        font_size, line_break = _group_layout(group, style)
        x, y = _group_position(group, style, font_size, line_break)
        boundaries = sorted({word[key] for word in group for key in ("from_ms", "to_ms")})
        for start, end in zip(boundaries, boundaries[1:]):
            if _ass_time(start) == _ass_time(end):
                continue
            elapsed = start - group[0]["from_ms"]
            entrance = _entrance_tags(style, x, y, elapsed)
            text = f"{{\\an5\\q2\\fs{font_size}{entrance}}}"
            for index, word in enumerate(group):
                if index:
                    text += r"\N" if index == line_break else " "
                color = _ass_color(style["highlight_color"] if word["from_ms"] <= start < word["to_ms"] else style["text_color"])
                text += f"{{\\c&H{color}&}}" + _display_word(word["text"], style)
            lines.append(f"Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Karaoke,,0,0,0,,{text}")
    return lines


def _ass_time(ms: object) -> str:
    value = max(0, int(ms or 0))
    seconds, millis = divmod(value, 1000)
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours}:{minutes:02d}:{seconds:02d}.{millis // 10:02d}"
