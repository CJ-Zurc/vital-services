import argparse
import hashlib
import json
import re
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.assets.bodhi import BODHI_COMMIT, BodhiDataset, load_and_validate_bodhi


MINILM_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
MINILM_REVISION = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"
NORMALIZATION_VERSION = "bodhi-specialty-v1"
SCORING_VERSION = "bodhi-path-v2-primary-service"
TAG_PATTERN = re.compile(r"<[^>]+>")
SPACE_PATTERN = re.compile(r"\s+")


def clean_symptom_text(value: str) -> str:
    return SPACE_PATTERN.sub(" ", TAG_PATTERN.sub(" ", value)).strip()


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _hash_tree(path: Path) -> str:
    digest = hashlib.sha256()
    for child in sorted(item for item in path.rglob("*") if item.is_file()):
        digest.update(child.relative_to(path).as_posix().encode("utf-8"))
        digest.update(_hash_file(child).encode("ascii"))
    return digest.hexdigest()


def _read_aliases(dataset: BodhiDataset) -> dict[str, list[str]]:
    import csv

    aliases: dict[str, list[str]] = {}
    path = dataset.source_dir / "clinical_aliases.csv"
    with path.open("r", encoding="utf-8", newline="") as stream:
        for row in csv.DictReader(stream):
            aliases.setdefault(row["root_snomed_id"], []).append(row["alias"])
    return aliases


def _medcat_rows(dataset: BodhiDataset) -> list[dict[str, str]]:
    aliases = _read_aliases(dataset)
    root_variant: dict[str, str] = {}
    for symptom in dataset.symptoms:
        root_id = symptom["root_snomed_id"]
        if root_id not in root_variant or symptom.get("snomed_id") == root_id:
            root_variant[root_id] = symptom["uuid"]

    rows: list[dict[str, str]] = []
    seen_names: set[str] = set()
    for symptom in dataset.symptoms:
        names = {clean_symptom_text(symptom["name"])}
        for child_field in ("child1_name", "child2_name", "child3_name"):
            child = symptom.get(child_field, "").strip()
            if child and len(child.split()) >= 2:
                names.add(child)
                names.add(f"{symptom['root_snomed_name']} {child}")
        if root_variant[symptom["root_snomed_id"]] == symptom["uuid"]:
            names.add(symptom["root_snomed_name"])
            names.update(aliases.get(symptom["root_snomed_id"], []))

        for name in sorted(names):
            normalized_name = SPACE_PATTERN.sub(" ", name).strip()
            normalized_key = normalized_name.lower()
            if len(normalized_name) < 3 or normalized_key in seen_names:
                continue
            seen_names.add(normalized_key)
            rows.append(
                {
                    "cui": symptom["uuid"],
                    "name": normalized_name,
                    "ontologies": "BODHI-S",
                    "name_status": "P",
                    "type_ids": "SYMPTOM",
                    "description": symptom["root_snomed_name"],
                }
            )
    return rows


def _build_medcat(dataset: BodhiDataset, output_dir: Path) -> tuple[Path, str]:
    import pandas as pd
    from medcat.cat import CAT
    from medcat.config import Config
    from medcat.model_creation.cdb_maker import CDBMaker

    config = Config()
    config.general.nlp.provider = "regex"
    config.components.linking.comp_name = "primary_name_only_linker"
    config.components.linking.train = False
    config.annotation_output.include_text_in_output = False
    config.meta.description = "VITAL BODHI-S symptom phrase extraction pack"
    config.meta.ontology = ["BODHI-S"]

    frame = pd.DataFrame(_medcat_rows(dataset))
    cdb = CDBMaker(config).prepare_csvs([frame], full_build=True)
    cat = CAT(cdb=cdb, vocab=None, config=config)
    model_root = output_dir / "medcat"
    model_root.mkdir(parents=True, exist_ok=True)
    pack_path = Path(
        cat.save_model_pack(
            str(model_root),
            pack_name="bodhi-medcat",
            make_archive=False,
            add_hash_to_pack_name=False,
        )
    )
    return pack_path, _hash_tree(pack_path)


def _embedding_text(symptom: dict[str, str]) -> str:
    parts = [symptom["root_snomed_name"]]
    cleaned = clean_symptom_text(symptom["name"])
    if cleaned.lower() != symptom["root_snomed_name"].lower():
        parts.append(cleaned)
    return ". ".join(parts)


def _build_minilm(dataset: BodhiDataset, output_dir: Path) -> tuple[Path, Path, str, str]:
    import numpy as np
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(
        MINILM_MODEL,
        revision=MINILM_REVISION,
        trust_remote_code=False,
    )
    model_dir = output_dir / "minilm"
    model.save(str(model_dir), safe_serialization=True)

    index = [
        {
            "uuid": symptom["uuid"],
            "snomedId": symptom["snomed_id"] or None,
            "rootSnomedId": symptom["root_snomed_id"],
            "rootName": symptom["root_snomed_name"],
            "variantName": symptom["name"],
            "embeddingText": _embedding_text(symptom),
        }
        for symptom in dataset.symptoms
    ]
    texts = [item["embeddingText"] for item in index]
    matrix = model.encode(
        texts,
        batch_size=128,
        convert_to_numpy=True,
        normalize_embeddings=True,
        show_progress_bar=True,
    ).astype("float32")
    if matrix.shape != (4037, 384):
        raise RuntimeError(f"Unexpected MiniLM matrix shape: {matrix.shape}")

    matrix_path = output_dir / "bodhi_symptom_embeddings.npy"
    index_path = output_dir / "bodhi_symptom_index.json"
    np.save(matrix_path, matrix, allow_pickle=False)
    index_path.write_text(json.dumps(index, ensure_ascii=True), encoding="utf-8")
    return model_dir, matrix_path, _hash_tree(model_dir), _hash_file(matrix_path)


def build_assets(source_dir: str | Path, output_dir: str | Path) -> dict[str, Any]:
    source = Path(source_dir)
    output = Path(output_dir)
    dataset = load_and_validate_bodhi(source)
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)

    medcat_path, medcat_hash = _build_medcat(dataset, output)
    minilm_path, matrix_path, minilm_hash, matrix_hash = _build_minilm(dataset, output)
    manifest = {
        "schemaVersion": 1,
        "builtAt": datetime.now(UTC).isoformat(),
        "bodhiCommit": BODHI_COMMIT,
        "bodhiChecksums": dataset.manifest["sha256"],
        "medcatVersion": "2.8.6",
        "medcatPackPath": medcat_path.relative_to(output).as_posix(),
        "medcatPackHash": medcat_hash,
        "miniLmModel": MINILM_MODEL,
        "miniLmRevision": MINILM_REVISION,
        "miniLmPath": minilm_path.relative_to(output).as_posix(),
        "miniLmHash": minilm_hash,
        "embeddingMatrixPath": matrix_path.relative_to(output).as_posix(),
        "embeddingMatrixHash": matrix_hash,
        "embeddingIndexPath": "bodhi_symptom_index.json",
        "embeddingDimensions": 384,
        "embeddingRows": len(dataset.symptoms),
        "normalizationVersion": NORMALIZATION_VERSION,
        "scoringVersion": SCORING_VERSION,
    }
    (output / "model_manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8"
    )
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description="Build immutable VITAL AI model assets")
    parser.add_argument("--source-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    print(json.dumps(build_assets(args.source_dir, args.output_dir), indent=2))


if __name__ == "__main__":
    main()
