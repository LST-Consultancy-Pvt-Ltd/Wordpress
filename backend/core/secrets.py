"""Strict encryption for bridge credentials.

Unlike `core.crypto.encrypt_field` (which silently stores plaintext when no
key is configured and returns ciphertext unchanged when decryption fails),
these functions refuse to operate without a key and raise on any decryption
failure: a bridge secret that cannot be decrypted must stop the connection,
not be sent to the bridge as garbage or stored in the clear.
"""
import os

from cryptography.fernet import Fernet, InvalidToken

_PREFIX = "enc1:"


class SecretStoreError(RuntimeError):
    pass


def _fernet() -> Fernet:
    key = os.environ.get("ENCRYPTION_KEY", "")
    if not key:
        raise SecretStoreError("ENCRYPTION_KEY is not configured; refusing to store or read bridge credentials")
    try:
        return Fernet(key.encode())
    except (ValueError, TypeError) as e:
        raise SecretStoreError("ENCRYPTION_KEY is not a valid Fernet key") from e


def encrypt_secret(value: str) -> str:
    if not value:
        raise SecretStoreError("refusing to store an empty secret")
    return _PREFIX + _fernet().encrypt(value.encode()).decode()


def decrypt_secret(stored: str) -> str:
    if not stored or not stored.startswith(_PREFIX):
        raise SecretStoreError("stored credential is not in the encrypted format")
    try:
        return _fernet().decrypt(stored[len(_PREFIX):].encode()).decode()
    except InvalidToken as e:
        raise SecretStoreError("stored credential could not be decrypted (wrong ENCRYPTION_KEY?)") from e


def mask(value: str, keep: int = 4) -> str:
    if not value:
        return ""
    return "•" * 8 + (value[-keep:] if len(value) > keep * 3 else "")
