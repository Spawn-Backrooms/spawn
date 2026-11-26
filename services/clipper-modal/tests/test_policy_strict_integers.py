"""Boolean values must not satisfy integer-only request fields."""

import json
import unittest

from spawn_clipper.policy import OPENSHORTS_COMMIT, PolicyError, parse_job_request, parse_render_request

PUT = "https://account.r2.cloudflarestorage.com/bucket/source?X-Amz-Signature=abc"


def job(**overrides):
    body = {
        "job_id": "clipjob_abc",
        "source_get_url": PUT,
        "suggestion_put_url": PUT,
        "render_clips": False,
        "clip_put_urls": [],
        "max_clips": 3,
        "aspect": "9:16",
        "source_sha256": "ab" * 32,
        "source_bytes": 2048,
        "duration_ms": 30_000,
        "openshorts_commit": OPENSHORTS_COMMIT,
    }
    body.update(overrides)
    return json.dumps(body).encode()


def render(**overrides):
    body = {
        "job_id": "clipjob_abc",
        "source_get_url": PUT,
        "source_sha256": "ab" * 32,
        "source_bytes": 2048,
        "duration_ms": 30_000,
        "openshorts_commit": OPENSHORTS_COMMIT,
        "clips": [{"put_url": PUT, "in_ms": 0, "out_ms": 5_000, "aspect": "9:16"}],
    }
    body.update(overrides)
    return json.dumps(body).encode()


class StrictIntegerRequestFields(unittest.TestCase):
    def test_job_boolean_integers_are_rejected(self):
        for field in ("max_clips", "source_bytes", "duration_ms"):
            with self.subTest(field=field), self.assertRaises(PolicyError):
                parse_job_request(job(**{field: True}))

    def test_render_boolean_integers_are_rejected(self):
        for field in ("source_bytes", "duration_ms"):
            with self.subTest(field=field), self.assertRaises(PolicyError):
                parse_render_request(render(**{field: True}))
        clip = {"put_url": PUT, "in_ms": True, "out_ms": 5_000, "aspect": "9:16"}
        with self.assertRaises(PolicyError):
            parse_render_request(render(clips=[clip]))


if __name__ == "__main__":
    unittest.main()
