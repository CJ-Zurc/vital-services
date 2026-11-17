from functools import lru_cache
from pathlib import Path
from pydantic import Field
from pydantic_settings import BaseSettings,SettingsConfigDict
class Settings(BaseSettings):
    ai_asset_dir:Path=Path('/opt/vital-ai-assets')
    bodhi_source_dir:Path=Path('/app/vendor/bodhi-s')
    ai_similarity_threshold:float=Field(default=.70,ge=0,le=1)
    ai_similarity_margin:float=Field(default=.05,ge=0,le=1)
    model_config=SettingsConfigDict(extra='ignore')
@lru_cache
def get_settings():return Settings()
