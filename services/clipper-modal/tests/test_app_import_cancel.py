"""A late import result must not overwrite an acknowledged cancellation.

Repro for the import half of CONTRIBUTING.md "Known source findings" #2
(PR #2 discussion r4584545263): POST /v1/imports/{id}/cancel answers 200
with state "failed" / error "CANCELLED" while the import worker is still
running, but process_import's read guard and its terminal write are separate
modal.Dict operations with no compare-and-swap, so a cancel landing between
them flips the row back to "succeeded" and GET /v1/imports/{id} reports the
cancelled import as succeeded — with its sha256/bytes, i.e. as a confirmed
upload instead of the unconfirmed object SPAWN removes after a cancel.

PR #8 fixed this window for the CLIPS job/render workers with a separate
authoritative cancellation record that every status read honours, but it
touches only the jobs dict: imports have no such record, import_cancel
writes none, and _import_view honours none. The mid-run cancel (landing
while run_import is still running) is already guarded; the check/commit
boundary and the worker-start window are not.

The Modal runtime is not available in the unit-test environment, so `modal`
is stubbed with passthrough decorators and plain dicts, and the importer is
stubbed with fakes that cancel the row mid-run, exactly as the cancel
endpoint would while the worker is still running.

The cancelled-imports record (`app.cancelled_imports`) is a separate plain
dict in the stub, as `modal.Dict.from_name` returns a fresh dict per name.
The check/commit boundary tests below use an imports store that lets a
cancel land after the worker's guard read but before its terminal write,
which is the window the read guard alone cannot close on a modal.Dict.
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

# The record is the fix's store. On the base revision the app has no such
# attribute; the tests below supply the dict so the cancel endpoint's
# record-then-row write can be simulated and the base failure stays a
# behavioural one (the view reports "succeeded" for a cancelled import)
# instead of an import-time error.
if not hasattr(app, "cancelled_imports"):
    app.cancelled_imports = {}


def _cancel_row(store, job_id):
    """What the cancel endpoint writes while the worker is still running."""
    store[job_id] = {**store.get(job_id, {}), "state": "failed", "error": "CANCELLED"}


def _cancel_record(job_id):
    """What the cancel endpoint records, without touching the row yet."""
    app.cancelled_imports[job_id] = True


def _cancel_record_and_row(store, job_id):
    """What the cancel endpoint writes: the record first, then the row."""
    _cancel_record(job_id)
    _cancel_row(store, job_id)


class _RaceStore(dict):
    """An imports store that lets a cancel land between the guard read and
    the terminal write, as the cancel endpoint can on a modal.Dict (separate
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
            _cancel_record_and_row(self, key)
        dict.__setitem__(self, key, value)


class _StartRaceStore(dict):
    """An imports store that lets a cancel land between the worker's first
    read and its "running" write: the worker read "queued", the operator
    cancelled, and the worker's unconditional "running" write then clobbers
    the acknowledged cancellation before run_import even starts.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._race_done = False

    def __setitem__(self, key, value):
        if (
            not self._race_done
            and isinstance(value, dict)
            and value.get("state") == "running"
        ):
            self._race_done = True
            _cancel_record_and_row(self, key)
        dict.__setitem__(self, key, value)


def _import_result():
    return {"sha256": "abc", "bytes": 1, "duration_ms": 1, "mime_type": "video/mp4"}


class LateImportResultAfterCancelTests(unittest.TestCase):
    def setUp(self):
        self._saved_modules = {}
        for name in ("spawn_clipper.runner", "spawn_clipper.importer"):
            self._saved_modules[name] = sys.modules.get(name)
        self.runner = types.ModuleType("spawn_clipper.runner")
        sys.modules["spawn_clipper.runner"] = self.runner
        self.importer = types.ModuleType("spawn_clipper.importer")
        sys.modules["spawn_clipper.importer"] = self.importer
        self._orig_imports = app.imports
        app.imports.clear()
        app.cancelled_imports.clear()

    def tearDown(self):
        app.imports = self._orig_imports
        # Never leak the stubs: later test modules import the real modules.
        for name, module in self._saved_modules.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module

    def test_late_import_result_does_not_overwrite_cancel(self):
        # The import worker already has this guard; lock the precedent in.
        job_id = "srcimport_late"

        def run_import(payload):
            _cancel_row(app.imports, payload["job_id"])
            return _import_result()

        self.importer.run_import = run_import
        app.imports[job_id] = {"state": "running", "error": None}
        app.process_import({"job_id": job_id})
        self.assertEqual(app.imports[job_id]["state"], "failed")
        self.assertEqual(app.imports[job_id]["error"], "CANCELLED")

    def test_late_import_failure_does_not_overwrite_cancel(self):
        job_id = "srcimport_late_failure"

        def run_import(payload):
            _cancel_row(app.imports, payload["job_id"])
            raise RuntimeError("boom")

        self.importer.run_import = run_import
        app.imports[job_id] = {"state": "running", "error": None}
        with self.assertRaises(RuntimeError):
            app.process_import({"job_id": job_id})
        self.assertEqual(app.imports[job_id]["state"], "failed")
        self.assertEqual(app.imports[job_id]["error"], "CANCELLED")

    def test_uncancelled_import_still_succeeds(self):
        job_id = "srcimport_normal"
        self.importer.run_import = lambda payload: _import_result()
        app.imports[job_id] = {"state": "running", "error": None}
        app.process_import({"job_id": job_id})
        self.assertEqual(app.imports[job_id]["state"], "succeeded")
        self.assertEqual(app.imports[job_id]["sha256"], "abc")

    def test_uncancelled_import_failure_still_records_code(self):
        job_id = "srcimport_normal_failure"
        self.importer.run_import = lambda payload: (_ for _ in ()).throw(RuntimeError("boom"))
        app.imports[job_id] = {"state": "running", "error": None}
        with self.assertRaises(RuntimeError):
            app.process_import({"job_id": job_id})
        self.assertEqual(app.imports[job_id]["state"], "failed")
        self.assertEqual(app.imports[job_id]["error"], "IMPORT_FAILED")

    # -- check/commit boundary: cancel lands after the guard read --

    def test_cancel_between_guard_and_write_success_stays_cancelled(self):
        # The guard already passed when the cancel lands, so the worker's
        # terminal write still lands in the row; the visible state must
        # stay failed/CANCELLED because _import_view honours the record.
        job_id = "srcimport_race_success"
        app.imports = _RaceStore({job_id: {"state": "running", "error": None}})
        self.importer.run_import = lambda payload: _import_result()
        app.process_import({"job_id": job_id})
        self.assertEqual(app.imports[job_id]["state"], "succeeded")
        view = app._import_view(job_id)
        self.assertEqual(view["state"], "failed")
        self.assertEqual(view["error"], "CANCELLED")

    def test_cancel_between_guard_and_write_failure_stays_cancelled(self):
        job_id = "srcimport_race_failure"
        app.imports = _RaceStore({job_id: {"state": "running", "error": None}})

        def run_import(payload):
            raise RuntimeError("boom")

        self.importer.run_import = run_import
        with self.assertRaises(RuntimeError):
            app.process_import({"job_id": job_id})
        self.assertEqual(app.imports[job_id]["error"], "IMPORT_FAILED")
        view = app._import_view(job_id)
        self.assertEqual(view["state"], "failed")
        self.assertEqual(view["error"], "CANCELLED")

    def test_record_only_cancel_stops_worker(self):
        # Cancel acknowledged (record written) while the worker runs, row
        # not yet updated: the extended guard must see the record.
        job_id = "srcimport_record_only"

        def run_import(payload):
            _cancel_record(payload["job_id"])
            return _import_result()

        self.importer.run_import = run_import
        app.imports[job_id] = {"state": "running", "error": None}
        app.process_import({"job_id": job_id})
        self.assertNotIn("sha256", app.imports[job_id])
        view = app._import_view(job_id)
        self.assertEqual(view["state"], "failed")
        self.assertEqual(view["error"], "CANCELLED")

    # -- worker start: cancel lands between the first read and "running" --

    def test_cancel_between_start_read_and_running_write_stays_cancelled(self):
        # The worker read "queued", the cancel landed, and the worker's
        # unconditional "running" write clobbered the cancellation; the
        # late result must still not become the visible terminal state.
        job_id = "srcimport_race_start"
        app.imports = _StartRaceStore({job_id: {"state": "queued", "error": None}})
        self.importer.run_import = lambda payload: _import_result()
        app.process_import({"job_id": job_id})
        view = app._import_view(job_id)
        self.assertEqual(view["state"], "failed")
        self.assertEqual(view["error"], "CANCELLED")

    # -- cancel endpoint behaviour (via _cancel_import) --

    def test_cancel_import_writes_record_and_row(self):
        job_id = "srcimport_cancel"
        app.imports[job_id] = {"state": "running", "error": None}
        view = app._cancel_import(job_id)
        self.assertEqual(view["state"], "failed")
        self.assertEqual(view["error"], "CANCELLED")
        self.assertIn(job_id, app.cancelled_imports)
        self.assertEqual(app.imports[job_id]["state"], "failed")
        self.assertEqual(app.imports[job_id]["error"], "CANCELLED")

    def test_cancel_import_after_completion_is_noop(self):
        job_id = "srcimport_done"
        app.imports[job_id] = {"state": "succeeded", "error": None, **_import_result()}
        view = app._cancel_import(job_id)
        self.assertEqual(view["state"], "succeeded")
        self.assertEqual(view["sha256"], "abc")
        self.assertNotIn(job_id, app.cancelled_imports)

    def test_cancel_import_after_completion_of_failed_job_is_noop(self):
        job_id = "srcimport_failed"
        app.imports[job_id] = {"state": "failed", "error": "IMPORT_FAILED"}
        view = app._cancel_import(job_id)
        self.assertEqual(view["state"], "failed")
        self.assertEqual(view["error"], "IMPORT_FAILED")
        self.assertNotIn(job_id, app.cancelled_imports)

    def test_cancelled_import_stays_cancelled_after_late_overwrite(self):
        # The old race, replayed after the fix: cancel acknowledged, then a
        # late worker write flips the row to "succeeded". A later cancel
        # call must not flip it back to success.
        job_id = "srcimport_stale_success"
        app.imports[job_id] = {"state": "running", "error": None}
        app._cancel_import(job_id)
        app.imports[job_id] = {"state": "succeeded", "error": None, **_import_result()}
        view = app._cancel_import(job_id)
        self.assertEqual(view["state"], "failed")
        self.assertEqual(view["error"], "CANCELLED")
        self.assertEqual(app._import_view(job_id)["state"], "failed")
        self.assertEqual(app._import_view(job_id)["error"], "CANCELLED")

    def test_cancel_import_unknown_returns_none(self):
        self.assertIsNone(app._cancel_import("srcimport_missing"))


if __name__ == "__main__":
    unittest.main()
