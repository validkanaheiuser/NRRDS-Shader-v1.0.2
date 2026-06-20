import hmac
import hashlib
import json
import os
import pytest

os.environ["AUDIO_BRIDGE_TOKEN"] = "test_token_abc"

from server.main import verify_ws_token, AUTH_TOKEN

# These are stub tests — actual server requires running process for WS tests.
# These test the pure functions.

def make_hmac(dev_id, date, nonce, token="test_token_abc"):
    msg = f"{dev_id}-{date}-{nonce}".encode()
    return hmac.new(token.encode(), msg, hashlib.sha256).hexdigest()

def test_hmac_valid():
    h = make_hmac("dev1", "20-06-26", "abc123nonce")
    # Server verify_handshake_hmac should return True
    from server.main import verify_handshake_hmac
    assert verify_handshake_hmac("dev1", "20-06-26", h, "abc123nonce")

def test_hmac_invalid_nonce():
    h = make_hmac("dev1", "20-06-26", "abc123nonce")
    from server.main import verify_handshake_hmac
    assert not verify_handshake_hmac("dev1", "20-06-26", h, "wrong_nonce")

def test_nonce_replay():
    from server.main import verify_handshake_hmac, _nonce_cache
    _nonce_cache.clear()
    nonce = "unique_nonce_1"
    h = make_hmac("dev1", "20-06-26", nonce)
    assert verify_handshake_hmac("dev1", "20-06-26", h, nonce)
    # Second call with same nonce should fail
    h2 = make_hmac("dev1", "20-06-26", nonce)
    assert not verify_handshake_hmac("dev1", "20-06-26", h2, nonce)

def test_ws_token_valid():
    from server.main import verify_ws_token
    assert verify_ws_token("test_token_abc")

def test_ws_token_invalid():
    from server.main import verify_ws_token
    assert not verify_ws_token("wrong_token")

def test_token_missing_env(monkeypatch):
    monkeypatch.delenv("AUDIO_BRIDGE_TOKEN", raising=False)
    import importlib
    import sys
    # Remove the cached module so it re-executes module-level code on reload
    sys.modules.pop("server.main", None)
    with pytest.raises(RuntimeError, match="AUDIO_BRIDGE_TOKEN"):
        import server.main  # noqa: F401
    # Restore for subsequent tests
    sys.modules.pop("server.main", None)
