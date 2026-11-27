"""Tests for the GitHub App JWT and the cached installation token."""

import base64
import json
import shutil
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from factory.github_auth import AuthError, InstallationToken, app_jwt

HAS_OPENSSL = shutil.which("openssl") is not None
EXPIRY = "2026-11-27T11:00:00Z"


def b64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def at(hour: int, minute: int) -> float:
    return datetime(2026, 11, 27, hour, minute, tzinfo=timezone.utc).timestamp()


@unittest.skipUnless(HAS_OPENSSL, "openssl is not installed")
class AppJwtTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.key = self.dir / "app.key"
        self.public = self.dir / "public.pem"
        subprocess.run(["openssl", "genrsa", "-out", str(self.key), "2048"], check=True, capture_output=True)
        subprocess.run(
            ["openssl", "rsa", "-in", str(self.key), "-pubout", "-out", str(self.public)],
            check=True,
            capture_output=True,
        )

    def test_jwt_verifies_against_the_public_key(self):
        token = app_jwt("12345", self.key, now=1_800_000_000)
        head, payload, signature = token.split(".")
        self.assertEqual(json.loads(b64(head)), {"alg": "RS256", "typ": "JWT"})
        self.assertEqual(json.loads(b64(payload)), {"iat": 1_799_999_940, "exp": 1_800_000_540, "iss": "12345"})
        self.assertNotIn("=", token)
        signing_input = self.dir / "input.txt"
        signing_input.write_bytes(f"{head}.{payload}".encode())
        signature_file = self.dir / "sig.bin"
        signature_file.write_bytes(b64(signature))
        verified = subprocess.run(
            ["openssl", "dgst", "-sha256", "-verify", str(self.public), "-signature", str(signature_file),
             str(signing_input)],
            capture_output=True,
        )
        self.assertEqual(verified.returncode, 0)

    def test_a_missing_key_raises_auth_error_without_a_path_in_the_message(self):
        missing = self.dir / "missing-key-file.pem"
        with self.assertRaises(AuthError) as caught:
            app_jwt("12345", missing, now=1_800_000_000)
        self.assertNotIn("missing-key-file", str(caught.exception))
        self.assertNotIn(str(self.dir), str(caught.exception))
        self.assertIn("exit status", str(caught.exception))


class AppJwtFailureTest(unittest.TestCase):
    def test_a_missing_openssl_binary_raises_auth_error(self):
        with mock.patch("factory.github_auth.subprocess.run", side_effect=FileNotFoundError("/some/path")):
            with self.assertRaises(AuthError) as caught:
                app_jwt("12345", Path("key.pem"), now=1)
        self.assertNotIn("/some/path", str(caught.exception))

    def test_a_signing_timeout_raises_auth_error(self):
        expired = subprocess.TimeoutExpired(["openssl", "dgst", "-sign", "key.pem"], 30)
        with mock.patch("factory.github_auth.subprocess.run", side_effect=expired):
            with self.assertRaises(AuthError) as caught:
                app_jwt("12345", Path("key.pem"), now=1)
        self.assertNotIn("key.pem", str(caught.exception))


class InstallationTokenTest(unittest.TestCase):
    def setUp(self) -> None:
        patcher = mock.patch("factory.github_auth.app_jwt", return_value="signed-jwt")
        self.jwt = patcher.start()
        self.addCleanup(patcher.stop)
        self.now = at(10, 0)
        self.posts: list[tuple[str, str]] = []
        self.answers = [{"token": "t1", "expires_at": EXPIRY}, {"token": "t2", "expires_at": "2026-11-27T12:00:00Z"}]

    def post(self, path: str, bearer: str) -> dict:
        self.posts.append((path, bearer))
        return self.answers[len(self.posts) - 1]

    def make(self) -> InstallationToken:
        return InstallationToken("12345", "678", Path("key.pem"), post=self.post, clock=lambda: self.now)

    def test_token_is_cached_until_five_minutes_before_expiry(self):
        tokens = self.make()
        self.assertEqual(tokens.get(), "t1")
        self.assertEqual(len(self.posts), 1)
        self.now = at(10, 54)
        self.assertEqual(tokens.get(), "t1")
        self.assertEqual(len(self.posts), 1)
        self.now = at(10, 56)
        self.assertEqual(tokens.get(), "t2")
        self.assertEqual(len(self.posts), 2)

    def test_the_token_is_asked_for_with_the_jwt_at_the_installation_path(self):
        self.make().get()
        self.assertEqual(self.posts, [("/app/installations/678/access_tokens", "signed-jwt")])
        self.jwt.assert_called_once_with("12345", Path("key.pem"), int(self.now))

    def test_an_answer_without_a_token_or_a_readable_expiry_raises_auth_error(self):
        for answer in ({}, {"token": "t1"}, {"token": "t1", "expires_at": "soon"}, {"token": "", "expires_at": EXPIRY}):
            with self.subTest(answer=answer):
                self.posts.clear()
                self.answers = [answer]
                with self.assertRaises(AuthError):
                    self.make().get()


if __name__ == "__main__":
    unittest.main()
