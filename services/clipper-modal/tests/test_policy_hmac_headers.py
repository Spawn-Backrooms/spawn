"""Malformed HMAC headers must be rejected cleanly, never crash the API worker."""

import unittest
from unittest.mock import patch

from spawn_clipper.policy import verify_request


class MalformedHmacHeaderTests(unittest.TestCase):
    BODY = b'{"job_id":"j1"}'

    def test_timestamp_conversion_failure_is_rejected(self):
        with patch("spawn_clipper.policy.int", side_effect=ValueError, create=True):
            self.assertFalse(
                verify_request("secret", "1000", "0" * 64, "POST", "/v1/jobs", self.BODY, 1000)
            )

    def test_superscript_digit_timestamp_is_rejected(self):
        # str.isdigit() accepts '²' but int('²') raises ValueError.
        self.assertFalse(
            verify_request("secret", "\u00b2", "0" * 64, "POST", "/v1/jobs", self.BODY, 1000)
        )

    def test_non_ascii_signature_is_rejected(self):
        # hmac.compare_digest raises TypeError on non-ASCII str operands.
        self.assertFalse(
            verify_request("secret", "1000", "\u00e9" * 64, "POST", "/v1/jobs", self.BODY, 1000)
        )

    def test_valid_signature_still_accepted(self):
        from spawn_clipper.policy import sign_request

        sig = sign_request("secret", "1000", "POST", "/v1/jobs", self.BODY)
        self.assertTrue(
            verify_request("secret", "1000", sig.upper(), "POST", "/v1/jobs", self.BODY, 1000)
        )


if __name__ == "__main__":
    unittest.main()
