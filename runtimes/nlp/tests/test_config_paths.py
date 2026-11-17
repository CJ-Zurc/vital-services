import unittest
from pathlib import Path

from app.config import Settings


class ConfigPathTests(unittest.TestCase):
    def test_configured_model_directories_support_path_operations(self):
        settings = Settings(ai_asset_dir='/opt/custom-assets', bodhi_source_dir='/opt/custom-bodhi')
        self.assertEqual(settings.ai_asset_dir / 'model_manifest.json', Path('/opt/custom-assets/model_manifest.json'))
        self.assertEqual(settings.bodhi_source_dir / 'csv' / 'nodes_symptom.csv',
                         Path('/opt/custom-bodhi/csv/nodes_symptom.csv'))
