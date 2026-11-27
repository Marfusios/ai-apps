"""GitHub App authentication: the App's signed JWT and the cached installation access token."""

import base64
import json
import subprocess
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path

JWT_BACKDATE_SECONDS = 60  # tolerates a clock slightly ahead of GitHub's
JWT_LIFETIME_SECONDS = 540  # GitHub accepts at most ten minutes
REFRESH_MARGIN_SECONDS = 300
SIGN_TIMEOUT_SECONDS = 30


class AuthError(Exception):
    """Signing or minting a token failed; the message never holds a key path, a key or a token."""


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _segment(value: dict) -> str:
    return _b64url(json.dumps(value, separators=(",", ":")).encode("utf-8"))


def app_jwt(app_id: str, key_file: Path, now: int) -> str:
    """Sign a short-lived RS256 JWT for the App with openssl, which reads the key by path."""
    header = _segment({"alg": "RS256", "typ": "JWT"})
    payload = _segment({"iat": now - JWT_BACKDATE_SECONDS, "exp": now + JWT_LIFETIME_SECONDS, "iss": app_id})
    signing_input = f"{header}.{payload}".encode("ascii")
    try:
        done = subprocess.run(
            ["openssl", "dgst", "-sha256", "-sign", str(key_file)],
            input=signing_input,
            capture_output=True,
            timeout=SIGN_TIMEOUT_SECONDS,
            check=False,
        )
    except OSError as error:
        raise AuthError(f"openssl could not be run ({type(error).__name__})") from None
    except subprocess.TimeoutExpired:
        raise AuthError("openssl did not finish signing in time") from None
    if done.returncode != 0:
        raise AuthError(f"openssl failed to sign the App JWT (exit status {done.returncode})")
    return f"{header}.{payload}.{_b64url(done.stdout)}"


class InstallationToken:
    """An installation access token that is minted on demand and reused until it nears expiry."""

    def __init__(
        self,
        app_id: str,
        installation_id: str,
        key_file: Path,
        *,
        post: Callable[[str, str], dict],
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._app_id = app_id
        self._path = f"/app/installations/{installation_id}/access_tokens"
        self._key_file = key_file
        self._post = post
        self._clock = clock
        self._token = ""
        self._expires_at = 0.0

    def get(self) -> str:
        """Return a token with at least five minutes of life left."""
        if self._expires_at - self._clock() < REFRESH_MARGIN_SECONDS:
            self._mint()
        return self._token

    def _mint(self) -> None:
        bearer = app_jwt(self._app_id, self._key_file, int(self._clock()))
        answer = self._post(self._path, bearer)
        token, expires_at = answer.get("token"), answer.get("expires_at")
        if not isinstance(token, str) or not token or not isinstance(expires_at, str):
            raise AuthError("GitHub's answer to the token request lacks a token or its expiry")
        try:
            expiry = datetime.fromisoformat(expires_at).timestamp()
        except ValueError:
            raise AuthError("GitHub's token expiry is not a timestamp") from None
        self._token, self._expires_at = token, expiry
