"""A failed multi-clip render must not hide the clips that already rendered.

Repro: POST /v1/renders asks for 2 clips. The worker uploads clip 0 to its
signed put_url, then clip 1 fails (expired signed URL, R2 error, bad encode).
The status a user polls -- GET /v1/jobs/{job_id} -- is the only progress
channel SPAWN has, and on base it reports:

    {"state": "failed", "renders": [], ...}

even though clip 0 exists at its put_url. While the render is still running
the view is no better: ``renders`` stays [] until every clip finishes, so a
4-clip render reads as 0% done for its whole run and then jumps to 100%.
A failed render also forces a full re-render of clips that already exist.

The Modal runtime is not available in the unit-test environment, so `modal`
is stubbed with passthrough decorators and plain dicts, and the runner is
stubbed with a fake that mirrors the real render_chosen loop (upload each
finished clip, then fail on the next one) -- the real loop was grounded
separately with ffmpeg: clip 0 uploaded (57,911 bytes) before clip 1 raised
SUGGESTION_UPLOAD_FAILED.
"""

import sys
import types
import unittest
from unittest import mock


def _install_modal_stub():
    if "modal" in sys.modules:
        return
    modal = types.ModuleType("modal")

    class _Chain:
        def __getattr__(self, item):
            return lambda *args, **kwargs: _Chain()

        def __call__(self, *args, **kwargs):
            return _Chain()

    class _App:
        def __init__(self, *args, **kwargs):
            pass

        def function(self, *args, **kwargs):
            def deco(fn):
                return fn

            return deco

        def asgi_app(self):
            def deco(fn):
                return fn

            return deco

    modal.App = _App
    modal.Image = _Chain()
    modal.Dict = types.SimpleNamespace(from_name=lambda *args, **kwargs: {})
    modal.Volume = types.SimpleNamespace(from_name=lambda *args, **kwargs: object())
    modal.Secret = types.SimpleNamespace(from_name=lambda *args, **kwargs: object())
    modal.FunctionCall = types.SimpleNamespace(from_id=lambda *args, **kwargs: mock.Mock())
    modal.asgi_app = lambda *args, **kwargs: (lambda fn: fn)
    sys.modules["modal"] = modal


_install_modal_stub()

import spawn_clipper.app as app  # noqa: E402
from spawn_clipper.policy import PolicyError  # noqa: E402


def _payload(job_id="clipjob_progress"):
    return {"job_id": job_id, "clips": [{}, {}]}


class _FakeRunner:
    """Mirrors render_chosen's real loop: upload clip 0, then fail on clip 1."""

    def __init__(self, behaviour="fail_on_second"):
        self.behaviour = behaviour
        self.uploaded = []
        self.seen_during_run = None

    def render_chosen(self, payload, on_clip=None):
        first = {"index": 0, "bytes": 57911, "sha256": "a" * 64}
        self.uploaded.append(first)
        if on_clip is not None:
            on_clip(first)
        # The view as a poller would see it right after clip 0 finished.
        self.seen_during_run = app._view(payload["job_id"])
        if self.behaviour == "fail_on_second":
            raise PolicyError("RENDER_FAILED")
        if self.behaviour == "cancel_mid_run":
            # #8's authoritative record, when present; the row write alone is
            # what the cancel endpoint does on base.
            if hasattr(app, "cancelled"):
                app.cancelled[payload["job_id"]] = True
            app.jobs[payload["job_id"]] = {
                **app.jobs[payload["job_id"]],
                "state": "failed",
                "error": "CANCELLED",
            }
            second = {"index": 1, "bytes": 58108, "sha256": "b" * 64}
            self.uploaded.append(second)
            if on_clip is not None:
                on_clip(second)
            return {"suggestion_sha256": "c" * 64, "renders": list(self.uploaded)}
        second = {"index": 1, "bytes": 58108, "sha256": "b" * 64}
        self.uploaded.append(second)
        if on_clip is not None:
            on_clip(second)
        return {"suggestion_sha256": "c" * 64, "renders": list(self.uploaded)}


class RenderProgressTests(unittest.TestCase):
    def setUp(self):
        self._saved = sys.modules.get("spawn_clipper.runner")
        self.runner = types.ModuleType("spawn_clipper.runner")
        sys.modules["spawn_clipper.runner"] = self.runner
        app.jobs.clear()
        cancelled = getattr(app, "cancelled", None)
        if cancelled is not None:
            cancelled.clear()

    def tearDown(self):
        if self._saved is None:
            sys.modules.pop("spawn_clipper.runner", None)
        else:
            sys.modules["spawn_clipper.runner"] = self._saved
        app.jobs.clear()
        cancelled = getattr(app, "cancelled", None)
        if cancelled is not None:
            cancelled.clear()

    def _run(self, behaviour):
        fake = _FakeRunner(behaviour)
        self.runner.render_chosen = fake.render_chosen
        return fake

    def test_failed_render_keeps_completed_clips_in_status(self):
        fake = self._run("fail_on_second")
        with self.assertRaises(PolicyError):
            app.process_render(_payload())
        view = app._view("clipjob_progress")
        self.assertEqual(view["state"], "failed")
        self.assertEqual(view["renders"], fake.uploaded)

    def test_status_shows_completed_clips_while_render_runs(self):
        fake = self._run("fail_on_second")
        with self.assertRaises(PolicyError):
            app.process_render(_payload())
        self.assertIsNotNone(fake.seen_during_run)
        self.assertEqual(fake.seen_during_run["state"], "running")
        self.assertEqual(fake.seen_during_run["renders"], fake.uploaded[:1])

    def test_successful_render_reports_all_clips(self):
        fake = self._run("succeed")
        app.process_render(_payload())
        view = app._view("clipjob_progress")
        self.assertEqual(view["state"], "succeeded")
        self.assertEqual(view["renders"], fake.uploaded)

    def test_cancelled_render_still_reports_cancelled(self):
        # #8 interplay: progress writes must not resurrect a cancellation.
        # Runs only where #8's authoritative record exists; on base the
        # cancel-overwrite itself is #8's open defect, not this candidate's.
        if not hasattr(app, "cancelled") or not hasattr(app, "_cancelled"):
            self.skipTest("no authoritative cancelled record on this base")
        fake = self._run("cancel_mid_run")
        app.process_render(_payload())
        view = app._view("clipjob_progress")
        self.assertEqual(view["state"], "failed")
        self.assertEqual(view["error"], "CANCELLED")


if __name__ == "__main__":
    unittest.main()
