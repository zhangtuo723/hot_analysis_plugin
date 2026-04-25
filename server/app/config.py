from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    kimi_api_key: str = ""
    kimi_base_url: str = "https://api.kimi.com/coding/v1"
    kimi_model: str = "kimi-k2-0711"
    database_url: str = "sqlite:///./hot_analysis.db"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
