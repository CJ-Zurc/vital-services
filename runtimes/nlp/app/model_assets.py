import hashlib
import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.config import get_settings


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@lru_cache
def load_model_manifest() -> dict[str, Any]:
    root = Path(get_settings().ai_asset_dir)
    path = root / "model_manifest.json"
    if not path.is_file():
        raise FileNotFoundError(f"Missing model manifest: {path}")
    manifest = json.loads(path.read_text(encoding="utf-8"))
    required = {
        "bodhiCommit",
        "medcatPackHash",
        "miniLmRevision",
        "miniLmHash",
        "embeddingMatrixHash",
        "normalizationVersion",
        "scoringVersion",
    }
    missing = sorted(required - manifest.keys())
    if missing:
        raise ValueError(f"Model manifest is missing: {', '.join(missing)}")
    matrix_path = root / manifest["embeddingMatrixPath"]
    if _hash_file(matrix_path) != manifest["embeddingMatrixHash"]:
        raise ValueError("BODHI symptom embedding matrix checksum mismatch")
    return manifest


def asset_path(manifest_key: str) -> Path:
    manifest = load_model_manifest()
    return Path(get_settings().ai_asset_dir) / manifest[manifest_key]


def model_fingerprint_versions() -> dict[str, str]:
    manifest = load_model_manifest()
    return {
        "bodhiCommit": manifest["bodhiCommit"],
        "medcatPackHash": manifest["medcatPackHash"],
        "miniLmRevision": manifest["miniLmRevision"],
        "miniLmHash": manifest["miniLmHash"],
        "embeddingMatrixHash": manifest["embeddingMatrixHash"],
        "normalizationVersion": manifest["normalizationVersion"],
        "scoringVersion": manifest["scoringVersion"],
    }
