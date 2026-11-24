"""Modal app for SPAWN clip suggestions and owner link imports.

Deploy from this directory. Do not enable billing or social publishing.
GPU jobs still read only SPAWN-signed objects; URL ingest stays blocked there.
Link imports run in a separate CPU function with a pinned yt-dlp limited to
named platform extractors, or a direct file download. Each input uses its own
scratch directory. retries=0 so Modal does not run an uncertain job a second
time. max_containers is the global concurrency cap.
"""

import os
import time

import modal

from spawn_clipper.policy import (
    OPENSHORTS_COMMIT,
    PIN_PATH,
    PolicyError,
    parse_import_request,
    parse_job_request,
    parse_render_request,
    verify_request,
)

APP_NAME = "spawn-clipper"
SECRET_NAME = "spawn-clipper"
DICT_NAME = "spawn-clip-jobs"
IMPORT_DICT_NAME = "spawn-source-imports"
IMPORT_CANCELLED_DICT_NAME = "spawn-source-cancelled-imports"
MAX_CONTAINERS = 1
IMPORT_MAX_CONTAINERS = 2
GPU_TIMEOUT_SECONDS = 20 * 60
# SPAWN signs the upload URL for 3600 seconds; the import must finish well inside it.
IMPORT_TIMEOUT_SECONDS = 40 * 60
YT_DLP_VERSION = "2026.10.26"
DENO_VERSION = "2.7.14"
# TLS impersonation for extractors such as Vimeo that refuse plain Python TLS. Not cookies.
CURL_CFFI_VERSION = "0.17.0"
CONTAINER_PIN_PATH = "/root/OPENSHORTS_PIN"

app = modal.App(APP_NAME)

web_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("fastapi==0.136.1", "httpx==0.28.1")
    .add_local_file(PIN_PATH, CONTAINER_PIN_PATH)
    .add_local_python_source("spawn_clipper")
)

# One shell layer so the commercial cloud/ tree is never committed into the image.
_PIN = OPENSHORTS_COMMIT
gpu_image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.4.1-cudnn-devel-ubuntu22.04",
        add_python="3.11",
    )
    .apt_install(
        "ffmpeg", "git", "ca-certificates", "curl",
        "fonts-dejavu-core=2.37-2build1", "fonts-dejavu-extra=2.37-2build1",
    )
    .run_commands(
        "bash -lc '"
        "set -euo pipefail; "
        "git clone https://github.com/mutonby/openshorts.git /opt/openshorts; "
        f"git -C /opt/openshorts checkout --detach {_PIN}; "
        "rm -rf /opt/openshorts/cloud /opt/openshorts/requirements-billing.txt; "
        "test ! -e /opt/openshorts/cloud; "
        "test ! -e /opt/openshorts/requirements-billing.txt; "
        "grep -q \"MIT License\" /opt/openshorts/LICENSE'"
    )
    .run_commands("python -m pip install -r /opt/openshorts/requirements.txt")
    .run_commands(
        "python -c \"from PIL import ImageFont; "
        "[ImageFont.truetype('/usr/share/fonts/truetype/dejavu/' + name, 80) for name in "
        "('DejaVuSans-Bold.ttf', 'DejaVuSansCondensed-Bold.ttf', 'DejaVuSansMono-Bold.ttf')]\""
    )
    .env(
        {
            "BILLING_ENABLED": "0",
            "ENABLE_URL_INGEST": "0",
            "SOCIAL_PUBLISH": "0",
            "OPENSHORTS_ROOT": "/opt/openshorts",
            "WHISPER_DEVICE": "cuda",
            "WHISPER_COMPUTE": "float16",
            "WHISPER_MODEL": "large-v3-turbo",
            "HF_HOME": "/cache/huggingface",
            "XDG_CACHE_HOME": "/cache",
            "PYTHONPATH": "/opt/openshorts",
        }
    )
    .add_local_file(PIN_PATH, CONTAINER_PIN_PATH)
    .add_local_python_source("spawn_clipper")
)

# CPU only. yt-dlp needs a JavaScript runtime for YouTube (deno, pinned PyPI wheel) and
# curl_cffi for sites that block by TLS fingerprint.
import_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "ca-certificates")
    .pip_install(
        "httpx==0.28.1",
        f"yt-dlp[default,curl-cffi]=={YT_DLP_VERSION}",
        f"curl_cffi=={CURL_CFFI_VERSION}",
        f"deno=={DENO_VERSION}",
    )
    .env({"BILLING_ENABLED": "0", "SOCIAL_PUBLISH": "0"})
    .add_local_file(PIN_PATH, CONTAINER_PIN_PATH)
    .add_local_python_source("spawn_clipper")
)

model_cache = modal.Volume.from_name("spawn-clipper-models", create_if_missing=True)
jobs = modal.Dict.from_name(DICT_NAME, create_if_missing=True)
imports = modal.Dict.from_name(IMPORT_DICT_NAME, create_if_missing=True)
# Authoritative cancellation record for imports, mirroring `cancelled` for
# CLIPS jobs (PR #8). A modal.Dict has no compare-and-swap, so the read
# guard in process_import and the terminal write are separate operations
# and a cancel can land between them. The cancel endpoint writes this
# record when it acknowledges a cancellation, and every import status read
# honours it, so a late worker result can never become the visible
# terminal state of a cancelled import.
cancelled_imports = modal.Dict.from_name(IMPORT_CANCELLED_DICT_NAME, create_if_missing=True)


def _import_cancelled(job_id: str) -> bool:
    """True when the import was cancelled while the worker was still running.

    The cancelled record is checked first: it is written by the cancel
    endpoint when it acknowledges the cancellation, so it stays true even
    if a late worker write landed in the row afterwards. The row check is
    kept as a fallback for rows the endpoint already marked.
    """
    if job_id in cancelled_imports:
        return True
    row = imports.get(job_id) or {}
    return row.get("state") == "failed" and row.get("error") == "CANCELLED"


@app.function(
    image=gpu_image,
    gpu="T4",
    timeout=GPU_TIMEOUT_SECONDS,
    retries=0,
    max_containers=MAX_CONTAINERS,
    scaledown_window=10,
    volumes={"/cache": model_cache},
    secrets=[modal.Secret.from_name(SECRET_NAME)],
)
def process(payload: dict) -> None:
    job_id = payload["job_id"]
    current = jobs.get(job_id) or {}
    if current.get("state") in ("succeeded", "failed"):
        return
    jobs[job_id] = {**current, "state": "running", "error": None}
    try:
        from spawn_clipper.runner import run_job

        result = run_job(payload)
        jobs[job_id] = {
            "state": "succeeded",
            "suggestion_sha256": result["suggestion_sha256"],
            "error": None,
            "openshorts_commit": result["openshorts_commit"],
        }
    except Exception as error:
        code = error.code if isinstance(error, PolicyError) else "CLIP_JOB_FAILED"
        jobs[job_id] = {"state": "failed", "suggestion_sha256": None, "error": code}
        raise


@app.function(
    image=gpu_image,
    gpu="T4",
    timeout=GPU_TIMEOUT_SECONDS,
    retries=0,
    max_containers=MAX_CONTAINERS,
    scaledown_window=10,
    volumes={"/cache": model_cache},
    secrets=[modal.Secret.from_name(SECRET_NAME)],
)
def process_render(payload: dict) -> None:
    job_id = payload["job_id"]
    current = jobs.get(job_id) or {}
    if current.get("state") in ("succeeded", "failed"):
        return
    jobs[job_id] = {**current, "state": "running", "error": None}
    try:
        from spawn_clipper.runner import render_chosen

        result = render_chosen(payload)
        jobs[job_id] = {
            "state": "succeeded",
            "suggestion_sha256": result["suggestion_sha256"],
            "renders": result["renders"],
            "error": None,
        }
    except Exception as error:
        code = error.code if isinstance(error, PolicyError) else "CLIP_RENDER_FAILED"
        jobs[job_id] = {"state": "failed", "suggestion_sha256": None, "renders": [], "error": code}
        raise


@app.function(
    image=import_image,
    cpu=4.0,
    memory=4096,
    timeout=IMPORT_TIMEOUT_SECONDS,
    retries=0,
    max_containers=IMPORT_MAX_CONTAINERS,
    scaledown_window=10,
)
def process_import(payload: dict) -> None:
    job_id = payload["job_id"]
    current = imports.get(job_id) or {}
    if current.get("state") in ("succeeded", "failed"):
        return
    imports[job_id] = {**current, "state": "running", "error": None}
    try:
        from spawn_clipper.importer import run_import

        result = run_import(payload)
        if _import_cancelled(job_id):
            # Cancelled while running. SPAWN treats the uploaded object as unconfirmed and removes it.
            return
        imports[job_id] = {"state": "succeeded", "error": None, **result}
    except Exception as error:
        code = error.code if isinstance(error, PolicyError) else "IMPORT_FAILED"
        if _import_cancelled(job_id):
            raise
        latest = imports.get(job_id) or {}
        imports[job_id] = {**latest, "state": "failed", "error": latest.get("error") or code}
        raise


def _import_view(job_id: str) -> dict:
    row = imports.get(job_id)
    if not row and job_id not in cancelled_imports:
        return {"job_id": job_id, "state": "not_found", "error": None}
    row = row or {}
    view = {"job_id": job_id, "state": row.get("state") or "not_found", "error": row.get("error")}
    if job_id in cancelled_imports:
        # An acknowledged cancellation is the visible terminal state even
        # if a late worker write landed in the row after the guard read.
        view["state"] = "failed"
        view["error"] = "CANCELLED"
    elif view["state"] == "succeeded":
        view.update(
            sha256=row.get("sha256"),
            bytes=row.get("bytes"),
            duration_ms=row.get("duration_ms"),
            mime_type=row.get("mime_type"),
        )
    return view


def _cancel_import(job_id: str) -> dict | None:
    """Acknowledge an import cancellation. Returns the view, or None if not found.

    Writes the cancelled record before the row, so a status read never
    reports a late worker result as the terminal state. An import that
    already finished stays at its terminal state; a cancelled import stays
    cancelled even if a worker already overwrote its row to "succeeded".

    A modal.Dict read and the record write are separate operations, so the
    worker can commit a terminal state after the first read — and a status
    read may already have exposed its digest/bytes. Re-read the row
    immediately before writing the record: an already-committed terminal
    state is authoritative and is preserved instead of being overwritten
    by the cancellation.
    """
    row = imports.get(job_id)
    if not row:
        return None
    if job_id in cancelled_imports or row.get("state") in ("succeeded", "failed"):
        return _import_view(job_id)
    row = imports.get(job_id)
    if not row or row.get("state") in ("succeeded", "failed"):
        return _import_view(job_id)
    cancelled_imports[job_id] = True
    imports[job_id] = {**row, "state": "failed", "error": "CANCELLED"}
    return _import_view(job_id)


def _secret() -> str:
    secret = os.environ.get("SPAWN_CLIP_MODAL_SECRET", "")
    if not secret:
        raise PolicyError("SECRET_MISSING")
    return secret


def _authorized(request, body: bytes) -> bool:
    return verify_request(
        _secret(),
        request.headers.get("x-spawn-timestamp"),
        request.headers.get("x-spawn-signature"),
        request.method,
        request.url.path,
        body,
        time.time(),
    )


def _view(job_id: str) -> dict:
    row = jobs.get(job_id)
    if not row:
        return {"job_id": job_id, "state": "not_found", "suggestion_sha256": None, "error": None}
    return {
        "job_id": job_id,
        "state": row.get("state") or "not_found",
        "suggestion_sha256": row.get("suggestion_sha256"),
        "renders": row.get("renders") or [],
        "error": row.get("error"),
    }


@app.function(
    image=web_image,
    timeout=30,
    max_containers=2,
    secrets=[modal.Secret.from_name(SECRET_NAME)],
)
@modal.asgi_app()
def api():
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse

    web = FastAPI(title="SPAWN clipper", docs_url=None, redoc_url=None, openapi_url=None)

    @web.post("/v1/jobs")
    async def create(request: Request):
        body = await request.body()
        if not _authorized(request, body):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        try:
            payload = parse_job_request(body)
        except PolicyError as error:
            return JSONResponse({"error": error.code}, status_code=422)
        existing = jobs.get(payload["job_id"])
        if existing:
            # Same SPAWN job id is already queued or finished. Do not start another GPU run.
            return JSONResponse({**_view(payload["job_id"]), "duplicate": True}, status_code=202)
        jobs[payload["job_id"]] = {
            "state": "queued",
            "suggestion_sha256": None,
            "error": None,
            "openshorts_commit": OPENSHORTS_COMMIT,
        }
        process.spawn(payload)
        return JSONResponse(_view(payload["job_id"]), status_code=202)

    @web.post("/v1/renders")
    async def render(request: Request):
        body = await request.body()
        if not _authorized(request, body):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        try:
            payload = parse_render_request(body)
        except PolicyError as error:
            return JSONResponse({"error": error.code}, status_code=422)
        existing = jobs.get(payload["job_id"])
        if existing:
            return JSONResponse({**_view(payload["job_id"]), "duplicate": True}, status_code=202)
        jobs[payload["job_id"]] = {
            "state": "queued",
            "suggestion_sha256": None,
            "renders": [],
            "error": None,
        }
        process_render.spawn(payload)
        return JSONResponse(_view(payload["job_id"]), status_code=202)

    @web.post("/v1/imports")
    async def create_import(request: Request):
        body = await request.body()
        if not _authorized(request, body):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        try:
            payload = parse_import_request(body)
        except PolicyError as error:
            return JSONResponse({"error": error.code}, status_code=422)
        if imports.get(payload["job_id"]):
            # Same SPAWN import id. Do not fetch the link a second time.
            return JSONResponse({**_import_view(payload["job_id"]), "duplicate": True}, status_code=202)
        imports[payload["job_id"]] = {"state": "queued", "error": None}
        call = process_import.spawn(payload)
        # Kept beside the row so a fast worker's state write is never overwritten here.
        imports[f"call:{payload['job_id']}"] = call.object_id
        return JSONResponse(_import_view(payload["job_id"]), status_code=202)

    @web.get("/v1/imports/{job_id}")
    async def import_status(job_id: str, request: Request):
        if not _authorized(request, b""):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if not job_id or len(job_id) > 160 or not job_id.startswith("srcimport_"):
            return JSONResponse({"error": "not_found"}, status_code=404)
        view = _import_view(job_id)
        return JSONResponse(view, status_code=200 if view["state"] != "not_found" else 404)

    @web.post("/v1/imports/{job_id}/cancel")
    async def import_cancel(job_id: str, request: Request):
        body = await request.body()
        if not _authorized(request, body):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        row = imports.get(job_id) if job_id.startswith("srcimport_") else None
        if not row:
            return JSONResponse({"job_id": job_id, "state": "not_found"}, status_code=404)
        if row.get("state") in ("succeeded", "failed") or job_id in cancelled_imports:
            return JSONResponse(_import_view(job_id), status_code=200)
        view = _cancel_import(job_id)
        call_id = imports.get(f"call:{job_id}")
        if call_id:
            try:
                modal.FunctionCall.from_id(call_id).cancel()
            except Exception:
                # The row is already failed; a late upload is removed by SPAWN.
                pass
        return JSONResponse(view, status_code=200)

    @web.get("/v1/jobs/{job_id}")
    async def status(job_id: str, request: Request):
        if not _authorized(request, b""):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if not job_id or len(job_id) > 160:
            return JSONResponse({"error": "not_found"}, status_code=404)
        view = _view(job_id)
        return JSONResponse(view, status_code=200 if view["state"] != "not_found" else 404)

    @web.post("/v1/jobs/{job_id}/cancel")
    async def cancel(job_id: str, request: Request):
        body = await request.body()
        if not _authorized(request, body):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        row = jobs.get(job_id)
        if not row:
            return JSONResponse({"job_id": job_id, "state": "not_found"}, status_code=404)
        if row.get("state") in ("succeeded", "failed"):
            return JSONResponse(_view(job_id), status_code=200)
        # Cancellation does not enqueue a replacement GPU input.
        jobs[job_id] = {**row, "state": "failed", "error": "CANCELLED"}
        return JSONResponse(_view(job_id), status_code=200)

    return web
