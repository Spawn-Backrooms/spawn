import hashlib
import hmac
import json
import tempfile
import unittest
from pathlib import Path

from spawn_clipper.policy import (
    OPENSHORTS_COMMIT,
    PolicyError,
    assert_core_checkout,
    assert_direct_source_url,
    moment_picker,
    parse_job_request,
    parse_render_request,
    refuse_publish_environment,
    sign_request,
    suggestion_document,
    verify_request,
    windows_from_transcript,
)


def _job(**overrides):
    body = {
        "job_id": "clipjob_abc",
        "source_get_url": "https://account.r2.cloudflarestorage.com/bucket/source?X-Amz-Signature=abc",
        "suggestion_put_url": "https://account.r2.cloudflarestorage.com/bucket/suggestion?X-Amz-Signature=def",
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


class PolicyTest(unittest.TestCase):
    def test_pin_is_a_commit(self):
        self.assertEqual(len(OPENSHORTS_COMMIT), 40)
        self.assertTrue(OPENSHORTS_COMMIT.isalnum())

    def test_signature_round_trip_rejects_tampering_and_old_timestamps(self):
        body = _job()
        signature = sign_request("secret", "1000", "POST", "/v1/jobs", body)
        self.assertTrue(verify_request("secret", "1000", signature, "POST", "/v1/jobs", body, 1000))
        self.assertFalse(verify_request("other", "1000", signature, "POST", "/v1/jobs", body, 1000))
        self.assertFalse(verify_request("secret", "1000", signature, "GET", "/v1/jobs", body, 1000))
        self.assertFalse(verify_request("secret", "1000", signature, "POST", "/v1/jobs", body, 1401))

    def test_youtube_and_http_urls_are_rejected(self):
        for url in (
            "https://www.youtube.com/watch?v=abc",
            "https://youtu.be/abc",
            "http://account.r2.cloudflarestorage.com/bucket/source",
            "https://user:pw@account.r2.cloudflarestorage.com/bucket/source",
        ):
            with self.assertRaises(PolicyError):
                assert_direct_source_url(url)
        with self.assertRaises(PolicyError):
            parse_job_request(_job(source_get_url="https://www.youtube.com/watch?v=abc"))

    def test_every_import_platform_host_and_a_bad_port_are_rejected(self):
        for url in (
            "https://player.vimeo.com/video/1",
            "https://m.twitch.tv/videos/1",
            "https://mobile.twitter.com/a/status/1",
            "https://mobile.x.com/a/status/1",
            "https://m.tiktok.com/v/1",
            "https://vt.tiktok.com/abc",
            "https://account.r2.cloudflarestorage.com:abc/bucket/source",
        ):
            with self.assertRaises(PolicyError):
                assert_direct_source_url(url)
        assert_direct_source_url("https://account.r2.cloudflarestorage.com:443/bucket/source")

    def test_render_defaults_off_and_extra_urls_are_rejected(self):
        parsed = parse_job_request(_job())
        self.assertFalse(parsed["render_clips"])
        self.assertEqual(parsed["clip_put_urls"], [])
        with self.assertRaises(PolicyError):
            parse_job_request(
                _job(
                    render_clips=True,
                    clip_put_urls=["https://account.r2.cloudflarestorage.com/bucket/clip"],
                    max_clips=3,
                )
            )

    def test_cloud_tree_and_publish_keys_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "LICENSE").write_text("MIT License\n", encoding="utf-8")
            assert_core_checkout(root)
            (root / "cloud").mkdir()
            with self.assertRaises(PolicyError) as caught:
                assert_core_checkout(root)
            self.assertEqual(caught.exception.code, "OPENSHORTS_CLOUD_PRESENT")
        with self.assertRaises(PolicyError):
            refuse_publish_environment({"UPLOAD_POST_API_KEY": "secret", "BILLING_ENABLED": "0"})
        with self.assertRaises(PolicyError):
            refuse_publish_environment({"BILLING_ENABLED": "1"})
        refuse_publish_environment({"BILLING_ENABLED": "0"})

    def test_transcript_windows_are_bounded_and_unscored(self):
        segments = [
            {"start_ms": 0, "end_ms": 8_000, "text": "Hello"},
            {"start_ms": 8_000, "end_ms": 16_000, "text": "there"},
            {"start_ms": 40_000, "end_ms": 50_000, "text": "later"},
        ]
        clips = windows_from_transcript(segments, 60_000, 3)
        self.assertGreaterEqual(len(clips), 1)
        self.assertLessEqual(len(clips), 3)
        for clip in clips:
            self.assertLessEqual(clip["out_ms"] - clip["in_ms"], 60_000)
            self.assertGreaterEqual(clip["in_ms"], 0)
        picker, leaves = moment_picker({})
        self.assertEqual(picker, "transcript_windows_no_llm")
        self.assertFalse(leaves)
        self.assertTrue(moment_picker({"GEMINI_API_KEY": "present"})[1])
        document = suggestion_document(
            {"job_id": "clipjob_abc", "duration_ms": 60_000, "render_clips": False},
            {"language": "en", "segments": segments},
            clips,
            moment=picker,
            audio_left_infra=False,
            frame={"width": 1920, "height": 1080},
        )
        self.assertEqual(document["version"], "spawn-clip-suggestion-v1")
        self.assertFalse(document["render_clips"])
        self.assertNotIn("secret", json.dumps(document))

    def test_transcript_windows_end_at_last_speech(self):
        # A window groups speech; dead air after its last segment is not speech.
        # One 8s burst in a 30-minute video must suggest 0-8s, not 0-60s.
        clips = windows_from_transcript(
            [{"start_ms": 0, "end_ms": 8_000, "text": "Hello world"}],
            30 * 60_000, 4,
        )
        self.assertEqual([(c["in_ms"], c["out_ms"]) for c in clips], [(0, 8_000)])
        # A 42s gap must not stretch the first window to the next segment's start.
        clips = windows_from_transcript([
            {"start_ms": 0, "end_ms": 8_000, "text": "Hello"},
            {"start_ms": 50_000, "end_ms": 58_000, "text": "later"},
        ], 30 * 60_000, 4)
        self.assertEqual(
            [(c["in_ms"], c["out_ms"]) for c in clips],
            [(0, 8_000), (50_000, 58_000)],
        )
        # Sparse bursts every 60s: each window is its burst, not a padded 60s.
        clips = windows_from_transcript([
            {"start_ms": 0, "end_ms": 8_000, "text": "a"},
            {"start_ms": 60_000, "end_ms": 68_000, "text": "b"},
            {"start_ms": 120_000, "end_ms": 128_000, "text": "c"},
        ], 30 * 60_000, 4)
        self.assertEqual(
            [(c["in_ms"], c["out_ms"]) for c in clips],
            [(0, 8_000), (60_000, 68_000), (120_000, 128_000)],
        )

    def test_transcript_windows_keep_furthest_overlapping_speech_end(self):
        segments = [
            {"start_ms": 0, "end_ms": 8_000, "text": "Full sentence"},
            {"start_ms": 1_000, "end_ms": 2_000, "text": "Overlap"},
        ]
        for tail, expected in (
            ([], [(0, 8_000)]),
            ([{"start_ms": 50_000, "end_ms": 58_000, "text": "Later"}],
             [(0, 8_000), (50_000, 58_000)]),
        ):
            with self.subTest(tail=tail):
                clips = windows_from_transcript(segments + tail, 60_000, 2)
                self.assertEqual(
                    [(c["in_ms"], c["out_ms"]) for c in clips], expected
                )

    def test_transcript_windows_only_spend_budget_on_usable_clips(self):
        for first_end, expected in (
            (500, [(50_000, 58_000)]),
            (1_000, [(0, 1_000)]),
        ):
            with self.subTest(first_end=first_end):
                clips = windows_from_transcript([
                    {"start_ms": 0, "end_ms": first_end, "text": "Hi"},
                    {"start_ms": 50_000, "end_ms": 58_000, "text": "Later"},
                ], 60_000, 1)
                self.assertEqual(
                    [(c["in_ms"], c["out_ms"]) for c in clips], expected
                )

    def test_signature_matches_hashlib(self):
        body = b"{}"
        expected = hmac.new(b"secret", b"50.POST./v1/jobs.{}", hashlib.sha256).hexdigest()
        self.assertEqual(sign_request("secret", "50", "POST", "/v1/jobs", body), expected)

    def test_render_request_is_nine_sixteen_and_rejects_platform_urls(self):
        body = json.dumps({
            "job_id": "render_clipjob_abc",
            "source_get_url": "https://account.r2.cloudflarestorage.com/bucket/source",
            "source_sha256": "ab" * 32,
            "source_bytes": 2048,
            "duration_ms": 30_000,
            "openshorts_commit": OPENSHORTS_COMMIT,
            "clips": [{
                "in_ms": 0,
                "out_ms": 8_000,
                "aspect": "9:16",
                "put_url": "https://account.r2.cloudflarestorage.com/bucket/clip",
            }],
        }).encode()
        parsed = parse_render_request(body)
        self.assertEqual(parsed["clips"][0]["aspect"], "9:16")
        with self.assertRaises(PolicyError):
            parse_render_request(body.replace(
                b"https://account.r2.cloudflarestorage.com/bucket/source",
                b"https://youtu.be/abc",
            ))


if __name__ == "__main__":
    unittest.main()
