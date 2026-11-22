"""Late CLIPS results must not overwrite an acknowledged cancellation.

Repro for CONTRIBUTING.md "Known source findings" #2 (PR #2 discussion
r4584545263): POST /v1/jobs/{id}/cancel answers 200 with state "failed" /
error "CANCELLED" while the GPU worker is still running, but process() and
process_render() unconditionally overwrite the row when the late result
lands, so a later GET reports the cancelled job as "succeeded".

The import worker already guards this (process_import returns early when
the row turned "failed" mid-run); the job/render workers do not.

The Modal runtime is not available in the unit-test environment, so `modal`
is stubbed with passthrough decorators and plain dicts, and the runner /
importer are stubbed with fakes that cancel the row mid-run, exactly as
the cancel endpoint would while the worker is still running.

The cancelled record (`app.cancelled`) is a separate plain dict in the stub,
as `modal.Dict.from_name` returns a fresh dict per name. The check/commit
boundary tests below use a jobs store that lets a cancel land after the
worker's guard read but before its terminal write, which is the window the
read guard alone cannot close on a modal.Dict.
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


def _cancel_row(store, job_id):
    """What the cancel endpoint writes while the worker is still running."""
    store[job_id] = {**store.get(job_id, {}), "state": "failed", "error": "CANCELLED"}


def _cancel_record(job_id):
    """What the cancel endpoint records, without touching the row yet."""
    app.cancelled[job_id] = True


class _RaceStore(dict):
    """A jobs store that lets a cancel land between the guard read and the
    terminal write, as the cancel endpoint can on a modal.Dict (separate
    operations, no compare-and-swap).

    The first terminal write (state "succeeded", or "failed" with a real
    error code) first applies the cancel the way the endpoint would — record
    then row — and only then performs the worker's own write.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._race_done = False

    def __setitem__(self, key, value):
        if (
            not self._race_done
            and isinstance(value, dict)
            and value.get("state") in ("succeeded", "failed")
            and value.get("error") != "CANCELLED"
        ):
            self._race_done = True
            _cancel_record(key)
            dict.__setitem__(self, key, {**self.get(key, {}), "state": "failed", "error": "CANCELLED"})
        dict.__setitem__(self, key, value)


class LateResultAfterCancelTests(unittest.TestCase):
    def setUp(self):
        self._saved_modules = {}
        for name in ("spawn_clipper.runner", "spawn_clipper.importer"):
            self._saved_modules[name] = sys.modules.get(name)
        self.runner = types.ModuleType("spawn_clipper.runner")
        sys.modules["spawn_clipper.runner"] = self.runner
        self.importer = types.ModuleType("spawn_clipper.importer")
        sys.modules["spawn_clipper.importer"] = self.importer
        self._orig_jobs = app.jobs
        app.jobs.clear()
        app.cancelled.clear()
        app.imports.clear()

    def tearDown(self):
        app.jobs = self._orig_jobs
        # Never leak the stubs: later test modules import the real modules.
        for name, module in self._saved_modules.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module

    def test_late_analysis_result_does_not_overwrite_cancel(self):
        job_id = "job_late_analysis"

        def run_job(payload):
            _cancel_row(app.jobs, payload["job_id"])
            return {"suggestion_sha256": "abc", "openshorts_commit": "x"}

        self.runner.run_job = run_job
        app.jobs[job_id] = {"state": "running", "error": None}
        app.process({"job_id": job_id})
        self.assertEqual(app.jobs[job_id]["state"], "failed")
        self.assertEqual(app.jobs[job_id]["error"], "CANCELLED")

    def test_late_render_result_does_not_overwrite_cancel(self):
        job_id = "job_late_render"

        def render_chosen(payload):
            _cancel_row(app.jobs, payload["job_id"])
            return {"suggestion_sha256": "abc", "renders": [{"index": 0, "bytes": 1, "sha256": "d"}]}

        self.runner.render_chosen = render_chosen
        app.jobs[job_id] = {"state": "running", "error": None}
        app.process_render({"job_id": job_id})
        self.assertEqual(app.jobs[job_id]["state"], "failed")
        self.assertEqual(app.jobs[job_id]["error"], "CANCELLED")

    def test_late_analysis_failure_does_not_overwrite_cancel(self):
        job_id = "job_late_failure"

        def run_job(payload):
            _cancel_row(app.jobs, payload["job_id"])
            raise RuntimeError("boom")

        self.runner.run_job = run_job
        app.jobs[job_id] = {"state": "running", "error": None}
        with self.assertRaises(RuntimeError):
            app.process({"job_id": job_id})
        self.assertEqual(app.jobs[job_id]["state"], "failed")
        self.assertEqual(app.jobs[job_id]["error"], "CANCELLED")

    def test_uncancelled_analysis_still_succeeds(self):
        job_id = "job_normal"
        self.runner.run_job = lambda payload: {
            "suggestion_sha256": "abc",
            "openshorts_commit": "x",
        }
        app.jobs[job_id] = {"state": "running", "error": None}
        app.process({"job_id": job_id})
        self.assertEqual(app.jobs[job_id]["state"], "succeeded")
        self.assertEqual(app.jobs[job_id]["suggestion_sha256"], "abc")

    def test_uncancelled_analysis_failure_still_records_code(self):
        job_id = "job_normal_failure"
        self.runner.run_job = lambda payload: (_ for _ in ()).throw(RuntimeError("boom"))
        app.jobs[job_id] = {"state": "running", "error": None}
        with self.assertRaises(RuntimeError):
            app.process({"job_id": job_id})
        self.assertEqual(app.jobs[job_id]["state"], "failed")
        self.assertEqual(app.jobs[job_id]["error"], "CLIP_JOB_FAILED")

    def test_late_import_result_does_not_overwrite_cancel(self):
        # The import worker already has this guard; lock the precedent in.
        job_id = "srcimport_late"

        def run_import(payload):
            _cancel_row(app.imports, payload["job_id"])
            return {"sha256": "abc", "bytes": 1, "duration_ms": 1, "mime_type": "video/mp4"}

        self.importer.run_import = run_import
        app.imports[job_id] = {"state": "running", "error": None}
        app.process_import({"job_id": job_id})
        self.assertEqual(app.imports[job_id]["state"], "failed")
        self.assertEqual(app.imports[job_id]["error"], "CANCELLED")

    # -- check/commit boundary: cancel lands after the guard read --

    def test_cancel_between_guard_and_write_success_stays_cancelled(self):
        # The guard already passed when the cancel lands, so the worker's
        # terminal write still lands in the row; the visible state must
        # stay failed/CANCELLED because _view honours the record.
        job_id = "job_race_success"
        app.jobs = _RaceStore({job_id: {"state": "running", "error": None}})
        self.runner.run_job = lambda payload: {
            "suggestion_sha256": "abc",
            "openshorts_commit": "x",
        }
        app.process({"job_id": job_id})
        self.assertEqual(app.jobs[job_id]["state"], "succeeded")
        view = app._view(job_id)
        self.assertEqual(view["state"], "failed")
        self.assertEqual(view["error"], "CANCELLED")
        # The late suggestion must not leak into the status response.
        self.assertIsNone(view["suggestion_sha256"])
        self.assertEqual(view["renders"], [])

    def test_cancel_between_guard_and_write_render_stays_cancelled(self):
        job_id = "job_race_render"
        app.jobs = _RaceStore({job_id: {"state": "running", "error": None}})

        def render_chosen(payload):
            return {"suggestion_sha256": "abc", "renders": [{"index": 0, "bytes": 1, "sha256": "d"}]}

        self.runner.render_chosen = render_chosen
        app.process_render({"job_id": job_id})
        self.assertEqual(app.jobs[job_id]["state"], "succeeded")
        view = app._view(job_id)
        self.assertEqual(view["state"], "failed")
        self.assertEqual(view["error"], "CANCELLED")
        # The late suggestion and renders must not leak into the status response.
        self.assertIsNone(view["suggestion_sha256"])
        self.assertEqual(view["renders"], [])

    def test_cancel_between_guard_and_write_failure_stays_cancelled(self):
        job_id = "job_race_failure"
        app.jobs = _RaceStore({job_id: {"state": "running", "error": None}})

        def run_job(payload):
            raise RuntimeError("boom")

        self.runner.run_job = run_job
        with self.assertRaises(RuntimeError):
            app.process({"job_id": job_id})
        self.assertEqual(app.jobs[job_id]["error"], "CLIP_JOB_FAILED")
        view = app._view(job_id)
        self.assertEqual(view["state"], "failed")
        self.assertEqual(view["error"], "CANCELLED")

    def test_record_only_cancel_stops_worker(self):
        # Cancel acknowledged (record written) while the worker runs, row
        # not yet updated: the extended guard must see the record.
        job_id = "job_record_only"

        def run_job(payload):
            _cancel_record(payload["job_id"])
            return {"suggestion_sha256": "abc", "openshorts_commit": "x"}

        self.runner.run_job = run_job
        app.jobs[job_id] = {"state": "running", "error": None}
        app.process({"job_id": job_id})
        self.assertNotIn("suggestion_sha256", app.jobs[job_id])
        view = app._view(job_id)
        self.assertEqual(view["state"], "failed")
        self.assertEqual(view["error"], "CANCELLED")

    # -- cancel endpoint behaviour (via _cancel_job) --

    def test_cancel_job_writes_record_and_row(self):
        job_id = "job_cancel"
        app.jobs[job_id] = {"state": "running", "error": None}
        view = app._cancel_job(job_id)
        self.assertEqual(view["state"], "failed")
        self.assertEqual(view["error"], "CANCELLED")
        self.assertIn(job_id, app.cancelled)
        self.assertEqual(app.jobs[job_id]["state"], "failed")
        self.assertEqual(app.jobs[job_id]["error"], "CANCELLED")

    def test_cancel_after_completion_is_noop(self):
        job_id = "job_done"
        app.jobs[job_id] = {"state": "succeeded", "suggestion_sha256": "abc", "error": None}
        view = app._cancel_job(job_id)
        self.assertEqual(view["state"], "succeeded")
        self.assertEqual(view["suggestion_sha256"], "abc")
        self.assertNotIn(job_id, app.cancelled)

    def test_cancel_after_completion_of_failed_job_is_noop(self):
        job_id = "job_failed"
        app.jobs[job_id] = {"state": "failed", "suggestion_sha256": None, "error": "CLIP_JOB_FAILED"}
        view = app._cancel_job(job_id)
        self.assertEqual(view["state"], "failed")
        self.assertEqual(view["error"], "CLIP_JOB_FAILED")
        self.assertNotIn(job_id, app.cancelled)

    def test_cancelled_job_stays_cancelled_after_late_overwrite(self):
        # The old race, replayed after the fix: cancel acknowledged, then a
        # late worker write flips the row to "succeeded". A later cancel
        # call must not flip it back to success.
        job_id = "job_stale_success"
        app.jobs[job_id] = {"state": "running", "error": None}
        app._cancel_job(job_id)
        app.jobs[job_id] = {"state": "succeeded", "suggestion_sha256": "abc", "error": None}
        view = app._cancel_job(job_id)
        self.assertEqual(view["state"], "failed")
        self.assertEqual(view["error"], "CANCELLED")
        self.assertEqual(app._view(job_id)["state"], "failed")
        self.assertEqual(app._view(job_id)["error"], "CANCELLED")

    def test_cancelled_view_clears_late_suggestion_and_renders(self):
        # Status response for a cancelled job must not carry a late
        # suggestion hash or render list, for both analysis and render.
        for job_id, row in (
            ("job_view_analysis", {"state": "succeeded", "suggestion_sha256": "abc", "error": None}),
            (
                "job_view_render",
                {
                    "state": "succeeded",
                    "suggestion_sha256": "abc",
                    "renders": [{"index": 0, "bytes": 1, "sha256": "d"}],
                    "error": None,
                },
            ),
        ):
            with self.subTest(job_id=job_id):
                app.jobs[job_id] = {"state": "running", "error": None}
                app._cancel_job(job_id)
                app.jobs[job_id] = row
                view = app._view(job_id)
                self.assertEqual(view["state"], "failed")
                self.assertEqual(view["error"], "CANCELLED")
                self.assertIsNone(view["suggestion_sha256"])
                self.assertEqual(view["renders"], [])

    def test_cancel_unknown_job_returns_none(self):
        self.assertIsNone(app._cancel_job("job_missing"))


if __name__ == "__main__":
    unittest.main()
