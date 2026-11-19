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


class LateResultAfterCancelTests(unittest.TestCase):
    def setUp(self):
        self._saved_modules = {}
        for name in ("spawn_clipper.runner", "spawn_clipper.importer"):
            self._saved_modules[name] = sys.modules.get(name)
        self.runner = types.ModuleType("spawn_clipper.runner")
        sys.modules["spawn_clipper.runner"] = self.runner
        self.importer = types.ModuleType("spawn_clipper.importer")
        sys.modules["spawn_clipper.importer"] = self.importer
        app.jobs.clear()
        app.imports.clear()

    def tearDown(self):
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


if __name__ == "__main__":
    unittest.main()
