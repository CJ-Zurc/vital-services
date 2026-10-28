import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np

from app.config import get_settings
from app.model_assets import asset_path


@dataclass(frozen=True)
class SymptomMatch:
    variant_uuid: str
    variant_name: str
    root_snomed_id: str
    root_name: str
    similarity: float
    margin: float

    def as_derived_dict(self) -> dict[str, object]:
        return {
            "variantUuid": self.variant_uuid,
            "variantName": self.variant_name,
            "rootSnomedId": self.root_snomed_id,
            "rootName": self.root_name,
            "similarity": round(self.similarity, 4),
            "margin": round(self.margin, 4),
            "matchMethod": "MINILM_SEMANTIC",
        }


class MiniLmSymptomMatcher:
    def __init__(
        self,
        model: object | None = None,
        matrix: np.ndarray | None = None,
        index: list[dict[str, object]] | None = None,
        threshold: float | None = None,
        margin: float | None = None,
    ) -> None:
        settings = get_settings()
        supplied = (model is not None, matrix is not None, index is not None)
        if any(supplied) and not all(supplied):
            raise ValueError("Model, matrix, and index must be supplied together")
        if all(supplied):
            self._model = model
            self._matrix = matrix
            self._index = index
        else:
            self._model, self._matrix, self._index = self._load_assets()
        self._threshold = threshold if threshold is not None else settings.ai_similarity_threshold
        self._margin = margin if margin is not None else settings.ai_similarity_margin
        if self._matrix.shape[0] != len(self._index):
            raise ValueError("MiniLM matrix and BODHI symptom index do not align")
        self._indices_by_root: dict[str, list[int]] = {}
        for position, item in enumerate(self._index):
            self._indices_by_root.setdefault(str(item["rootSnomedId"]), []).append(position)

    @staticmethod
    @lru_cache
    def _load_assets() -> tuple[object, np.ndarray, list[dict[str, object]]]:
        from sentence_transformers import SentenceTransformer

        model = SentenceTransformer(
            str(asset_path("miniLmPath")),
            local_files_only=True,
            trust_remote_code=False,
        )
        matrix = np.load(asset_path("embeddingMatrixPath"), allow_pickle=False)
        index_path = Path(asset_path("embeddingIndexPath"))
        index = json.loads(index_path.read_text(encoding="utf-8"))
        return model, matrix, index

    def match(self, phrases: list[str]) -> tuple[list[SymptomMatch], int]:
        if not phrases:
            return [], 0
        vectors = self._model.encode(  # type: ignore[attr-defined]
            phrases,
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        similarities = np.asarray(vectors, dtype=np.float32) @ self._matrix.T
        accepted_by_root: dict[str, SymptomMatch] = {}
        ambiguous = 0
        for row in similarities:
            root_candidates: list[tuple[float, str, int]] = []
            for root_id, indices in self._indices_by_root.items():
                best_index = max(indices, key=lambda index: (float(row[index]), -index))
                root_candidates.append((float(row[best_index]), root_id, best_index))
            root_candidates.sort(key=lambda item: (-item[0], item[1], item[2]))
            best_score, _, best_index = root_candidates[0]
            second_score = root_candidates[1][0] if len(root_candidates) > 1 else -1.0
            score_margin = best_score - second_score
            if best_score < self._threshold or score_margin < self._margin:
                ambiguous += 1
                continue
            item = self._index[best_index]
            match = SymptomMatch(
                variant_uuid=str(item["uuid"]),
                variant_name=str(item["variantName"]),
                root_snomed_id=str(item["rootSnomedId"]),
                root_name=str(item["rootName"]),
                similarity=best_score,
                margin=score_margin,
            )
            current = accepted_by_root.get(match.root_snomed_id)
            if current is None or (match.similarity, match.variant_uuid) > (
                current.similarity,
                current.variant_uuid,
            ):
                accepted_by_root[match.root_snomed_id] = match
        matches = sorted(
            accepted_by_root.values(),
            key=lambda item: (-item.similarity, item.root_snomed_id, item.variant_uuid),
        )
        return matches, ambiguous
