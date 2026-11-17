import tempfile
import unittest
from pathlib import Path

from app.assets.build import _asset_output_path


class AssetOutputTests(unittest.TestCase):
    def test_asset_output_protects_source_and_existing_unrelated_files(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp_path = Path(directory)
            source = tmp_path / "source"
            source.mkdir()
            for output in (tmp_path, source, source / "nested"):
                with self.assertRaisesRegex(ValueError, "protected directory"):
                    _asset_output_path(source, output)
            output = tmp_path / "assets"
            self.assertEqual(_asset_output_path(source, output), output.resolve())
            output.mkdir()
            (output / "unrelated.txt").touch()
            with self.assertRaisesRegex(ValueError, "model manifest"):
                _asset_output_path(source, output)
            (output / "model_manifest.json").touch()
            self.assertEqual(_asset_output_path(source, output), output.resolve())


    def test_asset_output_rejects_symlink_and_linked_parent(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp_path = Path(directory)
            source = tmp_path / "source"
            source.mkdir()
            link = tmp_path / "link"
            try:
                link.symlink_to(source, target_is_directory=True)
            except OSError:
                self.skipTest("Directory symlinks unavailable")
            for output in (link, link / "assets"):
                with self.assertRaisesRegex(ValueError, "filesystem link"):
                    _asset_output_path(source, output)
