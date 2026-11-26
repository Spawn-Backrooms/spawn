"""A repeated job ID must start at most one analysis, render or import.

The README promises that a repeated ``job_id`` returns the existing row and
never starts a second GPU input or fetches a link twice. The API runs in up to
two containers, so two submissions with the same ID can both read an absent
row before either writes ``queued``. ``_RacingDict`` reproduces that
interleaving: the second submission's reads see no row until it writes.

Neither Modal nor FastAPI is installed for the unit tests, so both are stubbed
with the few names ``app.py`` uses. ``_RacingDict.put`` follows
``modal.Dict.put(key, value, skip_if_exists=True)``, which the Modal server
applies atomically and which returns False when the key already exists.
"""

import asyncio
import json
import os
import sys
import time
import types
import unittest
from unittest import mock

from spawn_clipper.policy import (
    MAX_DURATION_MS,
    MAX_SOURCE_BYTES,
    OPENSHORTS_COMMIT,
    sign_request,
)

SECRET = "test-secret"
SIGNED = "https://account.r2.cloudflarestorage.com/bucket/object?X-Amz-Signature=abc"


class _RacingDict(dict):
    """A second API container whose reads ran before the first container wrote.

    Reads of a key in ``stale`` return no row until this container itself
    writes that key, as when both containers check for an existing row before
    either stores ``queued``.
    """

    def __init__(self):
        super().__init__()
        self.stale = set()

    def get(self, key, default=None):
        if key in self.stale:
            return default
        return super().get(key, default)

    def __setitem__(self, key, value):
        self.stale.discard(key)
        super().__setitem__(key, value)

    def put(self, key, value, *, skip_if_exists=False):
        self.stale.discard(key)
        if skip_if_exists and key in self:
            return False
        super().__setitem__(key, value)
        return True


class _Function:
    def __init__(self, fn):
        self.fn = fn
        self.spawned = []

    def spawn(self, payload):
        self.spawned.append(payload)
        return types.SimpleNamespace(object_id=f"fc-{len(self.spawned)}")


def _install_stubs():
    modal = types.ModuleType("modal")

    class _Image:
        def __getattr__(self, name):
            return lambda *args, **kwargs: self

    class _App:
        def __init__(self, *args, **kwargs):
            pass

        def function(self, *args, **kwargs):
            return _Function

    modal.App = _App
    modal.Image = _Image()
    modal.Dict = types.SimpleNamespace(from_name=lambda *args, **kwargs: _RacingDict())
    modal.Volume = types.SimpleNamespace(from_name=lambda *args, **kwargs: object())
    modal.Secret = types.SimpleNamespace(from_name=lambda *args, **kwargs: object())
    modal.FunctionCall = types.SimpleNamespace(from_id=lambda *args, **kwargs: mock.Mock())
    modal.asgi_app = lambda *args, **kwargs: (lambda fn: fn)

    fastapi = types.ModuleType("fastapi")
    responses = types.ModuleType("fastapi.responses")

    class FastAPI:
        def __init__(self, *args, **kwargs):
            self.routes = {}

        def _route(self, method, path):
            def deco(fn):
                self.routes[(method, path)] = fn
                return fn

            return deco

        def post(self, path):
            return self._route("POST", path)

        def get(self, path):
            return self._route("GET", path)

    class JSONResponse:
        def __init__(self, content, status_code=200):
            self.content = content
            self.status_code = status_code

    fastapi.FastAPI = FastAPI
    fastapi.Request = object
    responses.JSONResponse = JSONResponse
    fastapi.responses = responses
    return {"modal": modal, "fastapi": fastapi, "fastapi.responses": responses}


class _Request:
    def __init__(self, path, body):
        timestamp = str(int(time.time()))
        self.method = "POST"
        self.url = types.SimpleNamespace(path=path)
        self.headers = {
            "x-spawn-timestamp": timestamp,
            "x-spawn-signature": sign_request(SECRET, timestamp, "POST", path, body),
        }
        self._body = body

    async def body(self):
        return self._body


def _job_body():
    return json.dumps({
        "job_id": "clipjob_abc",
        "source_get_url": SIGNED,
        "suggestion_put_url": SIGNED,
        "render_clips": False,
        "clip_put_urls": [],
        "max_clips": 3,
        "aspect": "9:16",
        "source_sha256": "ab" * 32,
        "source_bytes": 2048,
        "duration_ms": 30_000,
        "openshorts_commit": OPENSHORTS_COMMIT,
    }).encode()


def _render_body():
    return json.dumps({
        "job_id": "clipjob_abc",
        "source_get_url": SIGNED,
        "source_sha256": "ab" * 32,
        "source_bytes": 2048,
        "duration_ms": 30_000,
        "openshorts_commit": OPENSHORTS_COMMIT,
        "clips": [{"put_url": SIGNED, "in_ms": 0, "out_ms": 5_000, "aspect": "9:16"}],
    }).encode()


def _import_body():
    return json.dumps({
        "job_id": "srcimport_abc",
        "source_url": "https://www.youtube.com/watch?v=iG9CE55wbtY",
        "put_url": SIGNED,
        "max_bytes": MAX_SOURCE_BYTES,
        "max_duration_ms": MAX_DURATION_MS,
    }).encode()


class RepeatedJobIdTest(unittest.TestCase):
    def setUp(self):
        sys.modules.pop("spawn_clipper.app", None)
        patcher = mock.patch.dict(sys.modules, _install_stubs())
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(sys.modules.pop, "spawn_clipper.app", None)
        env = mock.patch.dict(os.environ, {"SPAWN_CLIP_MODAL_SECRET": SECRET})
        env.start()
        self.addCleanup(env.stop)
        import spawn_clipper.app as app

        self.app = app
        self.routes = app.api.fn().routes

    def submit_twice(self, path, body, store, job_id):
        handler = self.routes[("POST", path)]
        first = asyncio.run(handler(_Request(path, body)))
        store.stale.add(job_id)
        second = asyncio.run(handler(_Request(path, body)))
        return [first, second]

    def assert_second_is_duplicate(self, responses):
        self.assertEqual([r.status_code for r in responses], [202, 202])
        self.assertNotIn("duplicate", responses[0].content)
        self.assertTrue(responses[1].content.get("duplicate"))
        self.assertEqual(responses[1].content["state"], "queued")

    def test_concurrent_analysis_submissions_start_one_gpu_run(self):
        responses = self.submit_twice("/v1/jobs", _job_body(), self.app.jobs, "clipjob_abc")
        self.assertEqual(len(self.app.process.spawned), 1)
        self.assert_second_is_duplicate(responses)

    def test_concurrent_render_submissions_start_one_gpu_run(self):
        responses = self.submit_twice("/v1/renders", _render_body(), self.app.jobs, "clipjob_abc")
        self.assertEqual(len(self.app.process_render.spawned), 1)
        self.assert_second_is_duplicate(responses)

    def test_concurrent_import_submissions_fetch_the_link_once(self):
        responses = self.submit_twice("/v1/imports", _import_body(), self.app.imports, "srcimport_abc")
        self.assertEqual(len(self.app.process_import.spawned), 1)
        self.assert_second_is_duplicate(responses)
        self.assertEqual(self.app.imports.get("call:srcimport_abc"), "fc-1")

    def test_a_finished_job_is_returned_without_a_new_run(self):
        self.app.jobs["clipjob_abc"] = {"state": "succeeded", "suggestion_sha256": "cd" * 32, "error": None}
        response = asyncio.run(self.routes[("POST", "/v1/jobs")](_Request("/v1/jobs", _job_body())))
        self.assertEqual(self.app.process.spawned, [])
        self.assertTrue(response.content["duplicate"])
        self.assertEqual(response.content["state"], "succeeded")


if __name__ == "__main__":
    unittest.main()
