"""Exercise the public status contract with a simulated conditional put."""

import importlib
import sys
import types
import unittest
from unittest import mock

from test_app_job_claim import _install_stubs

with mock.patch.dict(sys.modules, _install_stubs()):
    app = importlib.import_module("spawn_clipper.app")


class Store(dict):
    before_put = None
    after_write = None

    def put(self, key, value, *, skip_if_exists):
        assert skip_if_exists
        hook, self.before_put = self.before_put, None
        if hook is not None:
            hook()
        if key in self:
            return False
        self[key] = value
        return True

    def __setitem__(self, key, value):
        super().__setitem__(key, value)
        hook, self.after_write = self.after_write, None
        if hook is not None:
            hook()


class TerminalTests(unittest.TestCase):
    job = "srcimport_test"
    payload = {"job_id": job}
    result = {"sha256": "abc", "bytes": 1, "duration_ms": 1, "mime_type": "video/mp4"}

    def setUp(self):
        self.store = Store({self.job: {"state": "queued", "error": None}})
        imports = mock.patch.object(app, "imports", self.store)
        imports.start()
        self.addCleanup(imports.stop)
        mod = types.ModuleType("spawn_clipper.importer")
        self.run = mod.run_import = mock.Mock(return_value=self.result)
        modules = mock.patch.dict(sys.modules, {"spawn_clipper.importer": mod})
        modules.start()
        self.addCleanup(modules.stop)

    def assertCancelled(self, view):
        self.assertEqual(view, {"job_id": self.job, "state": "failed", "error": "CANCELLED"})

    def test_success_wins_before_cancel_is_committed(self):
        observed = []

        def finish_first():
            getattr(app.process_import, "fn", app.process_import)(self.payload)
            observed.append(app._import_view(self.job))

        self.store.before_put = finish_first
        view, won = app._cancel_import(self.job)
        self.assertFalse(won)
        self.assertEqual(view, observed[0])
        self.assertEqual(view, {"job_id": self.job, "state": "succeeded", "error": None, **self.result})

    def test_failure_wins_before_cancel_is_committed(self):
        self.run.side_effect = RuntimeError("local test failure")

        def finish_first():
            with self.assertRaises(RuntimeError):
                getattr(app.process_import, "fn", app.process_import)(self.payload)

        self.store.before_put = finish_first
        view, won = app._cancel_import(self.job)
        self.assertFalse(won)
        self.assertEqual(view, {"job_id": self.job, "state": "failed", "error": "IMPORT_FAILED"})

    def test_cancel_wins_before_success_is_committed(self):
        observed = []
        self.store.before_put = lambda: observed.append(app._cancel_import(self.job))
        getattr(app.process_import, "fn", app.process_import)(self.payload)
        view, won = observed[0]
        self.assertTrue(won)
        self.assertCancelled(view)
        self.assertCancelled(app._import_view(self.job))
        self.assertEqual(app._cancel_import(self.job), (view, False))

    def test_cancel_wins_before_failure_is_committed(self):
        self.run.side_effect = RuntimeError("local test failure")
        self.store.before_put = lambda: app._cancel_import(self.job)
        with self.assertRaises(RuntimeError):
            getattr(app.process_import, "fn", app.process_import)(self.payload)
        self.assertCancelled(app._import_view(self.job))

    def test_cancel_wins_during_worker_start(self):
        self.store.after_write = lambda: app._cancel_import(self.job)
        getattr(app.process_import, "fn", app.process_import)(self.payload)
        self.run.assert_not_called()
        self.assertCancelled(app._import_view(self.job))

    def test_cancel_missing_snapshot_does_not_acknowledge_concurrent_admission(self):
        self.store.clear()

        def admit_during_terminal_lookup(key, default=None):
            value = dict.get(self.store, key, default)
            if key == f"terminal:{self.job}":
                self.store[self.job] = {"state": "queued", "error": None}
            return value

        with mock.patch.object(self.store, "get", side_effect=admit_during_terminal_lookup):
            view, won = app._cancel_import(self.job)
        self.assertEqual(view, {"job_id": self.job, "state": "not_found", "error": None})
        self.assertFalse(won)
        self.assertEqual(app._import_view(self.job)["state"], "queued")

    def test_existing_terminal_rows_and_unknown_ids(self):
        for terminal in (
            {"state": "succeeded", "error": None, **self.result},
            {"state": "failed", "error": "IMPORT_FAILED"},
            {"state": "failed", "error": "CANCELLED"},
        ):
            with self.subTest(terminal=terminal):
                self.store[self.job] = terminal
                getattr(app.process_import, "fn", app.process_import)(self.payload)
                self.assertEqual(app._cancel_import(self.job), ({"job_id": self.job, **terminal}, False))
                self.assertNotIn(f"terminal:{self.job}", self.store)
        self.run.assert_not_called()
        self.assertEqual(app._cancel_import("srcimport_missing"),
                         ({"job_id": "srcimport_missing", "state": "not_found", "error": None}, False))
