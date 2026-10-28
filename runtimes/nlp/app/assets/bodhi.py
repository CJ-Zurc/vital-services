import csv
import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any



from app.config import get_settings



BODHI_COMMIT = "daca31c2a5a28876a0140135015518a44eb2d37d"
NODE_FILES = {
    "symptoms": "nodes_symptom.csv",
    "conditions": "nodes_condition.csv",
    "specialties": "nodes_speciality.csv",
}
EDGE_FILES = {
    "PRESENT_IN": "edges_present_in.csv",
    "TREATED_BY": "edges_treated_by.csv",
    "IS_INFLUENCED_BY": "edges_is_influenced_by.csv",
    "RELATED_TO": "edges_related_to.csv",
    "HAS_PREREQUISITE": "edges_has_prerequisite.csv",
}


@dataclass(frozen=True)
class BodhiDataset:
    version: str
    source_dir: Path
    manifest: dict[str, Any]
    symptoms: list[dict[str, str]]
    conditions: list[dict[str, str]]
    specialties: list[dict[str, str]]
    edges: dict[str, list[dict[str, str]]]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        return [dict(row) for row in csv.DictReader(stream)]


def _require_references(
    rows: list[dict[str, str]],
    field: str,
    allowed: set[str],
    relation: str,
) -> None:
    missing = sorted({row[field] for row in rows if row[field] not in allowed})
    if missing:
        sample = ", ".join(missing[:5])
        raise ValueError(f"{relation} contains invalid {field} references: {sample}")


def load_and_validate_bodhi(source_dir: str | Path) -> BodhiDataset:
    root = Path(source_dir)
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"Missing BODHI manifest: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("commit") != BODHI_COMMIT:
        raise ValueError("BODHI source commit does not match the approved commit")

    csv_dir = root / "csv"
    for filename, expected_hash in manifest["sha256"].items():
        path = csv_dir / filename
        if not path.is_file():
            raise FileNotFoundError(f"Missing BODHI file: {path}")
        if _sha256(path) != expected_hash:
            raise ValueError(f"BODHI checksum mismatch: {filename}")

    symptoms = _read_csv(csv_dir / NODE_FILES["symptoms"])
    conditions = _read_csv(csv_dir / NODE_FILES["conditions"])
    specialties = _read_csv(csv_dir / NODE_FILES["specialties"])
    edges = {
        relation: _read_csv(csv_dir / filename)
        for relation, filename in EDGE_FILES.items()
    }

    expected = manifest["expectedCounts"]
    actual = {
        "symptoms": len(symptoms),
        "rootSymptoms": len(
            {row["root_snomed_id"] for row in symptoms if row["root_snomed_id"]}
        ),
        "conditions": len(conditions),
        "specialties": len(specialties),
        "relationships": sum(len(rows) for rows in edges.values()),
        **{relation: len(rows) for relation, rows in edges.items()},
    }
    mismatches = {
        key: {"expected": expected[key], "actual": value}
        for key, value in actual.items()
        if expected.get(key) != value
    }
    if mismatches:
        raise ValueError(f"BODHI count validation failed: {mismatches}")

    symptom_ids = {row["uuid"] for row in symptoms}
    condition_ids = {row["snomed_id"] for row in conditions}
    specialty_ids = {row["id"] for row in specialties}
    _require_references(edges["PRESENT_IN"], "symptom_uuid", symptom_ids, "PRESENT_IN")
    _require_references(
        edges["PRESENT_IN"], "condition_snomed_id", condition_ids, "PRESENT_IN"
    )
    _require_references(
        edges["TREATED_BY"], "condition_snomed_id", condition_ids, "TREATED_BY"
    )
    _require_references(edges["TREATED_BY"], "speciality_id", specialty_ids, "TREATED_BY")
    for relation in ("IS_INFLUENCED_BY", "HAS_PREREQUISITE"):
        _require_references(edges[relation], "condition_snomed_id_src", condition_ids, relation)
        _require_references(edges[relation], "condition_snomed_id_dst", condition_ids, relation)
    _require_references(edges["RELATED_TO"], "src_id", symptom_ids, "RELATED_TO")
    _require_references(edges["RELATED_TO"], "dst_id", symptom_ids, "RELATED_TO")

    return BodhiDataset(
        version=BODHI_COMMIT,
        source_dir=root,
        manifest=manifest,
        symptoms=symptoms,
        conditions=conditions,
        specialties=specialties,
        edges=edges,
    )

