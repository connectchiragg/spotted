import os
from dataclasses import dataclass, field

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    tagging_provider: str = field(default_factory=lambda: os.getenv('TAGGING_PROVIDER', 'gemini'))
    image_model_cache: str = field(default_factory=lambda: os.getenv('IMAGE_MODEL_CACHE', 'data/models'))
    api_key: str = field(default_factory=lambda: os.getenv('GEMINI_API_KEY', ''), repr=False)
    model: str = field(default_factory=lambda: os.getenv('GEMINI_MODEL', 'gemini-3.5-flash'))
    max_upload_mb: int = field(default_factory=lambda: int(os.getenv('MAX_UPLOAD_MB', '400')))
    max_video_seconds: int = field(default_factory=lambda: int(os.getenv('MAX_VIDEO_SECONDS', '600')))
    max_frames: int = field(default_factory=lambda: int(os.getenv('MAX_FRAMES', '16')))
    gemini_timeout_seconds: int = field(default_factory=lambda: int(os.getenv('GEMINI_TIMEOUT_SECONDS', '30')))
    aws_profile: str = field(default_factory=lambda: os.getenv('AWS_PROFILE', 'default'))
    aws_region: str = field(default_factory=lambda: os.getenv('AWS_REGION', 'ap-south-1'))
    s3_bucket: str = field(default_factory=lambda: os.getenv('S3_BUCKET', ''))
    sqs_queue_url: str = field(default_factory=lambda: os.getenv('SQS_QUEUE_URL', ''))
    database_path: str = field(default_factory=lambda: os.getenv('DATABASE_PATH', 'data/instawork.db'))
    database_url: str = field(default_factory=lambda: os.getenv('DATABASE_URL', ''), repr=False)
    aws_usage_enabled: bool = field(default_factory=lambda: os.getenv('AWS_USAGE_ENABLED', 'false').lower() == 'true')
    embedding_model: str = field(default_factory=lambda: os.getenv('EMBEDDING_MODEL', 'BAAI/bge-small-en-v1.5'))
    embedding_cache: str = field(default_factory=lambda: os.getenv('EMBEDDING_CACHE', 'data/models'))
    search_min_similarity: float = field(default_factory=lambda: float(os.getenv('SEARCH_MIN_SIMILARITY', '0.60')))
    duplicate_similarity_threshold: float = field(default_factory=lambda: float(os.getenv('DUPLICATE_SIMILARITY_THRESHOLD', '0.95')))

    @property
    def lease_seconds(self) -> int:
        return max(600, self.max_frames * 10 + self.gemini_timeout_seconds + 180)

    def __post_init__(self):
        if self.tagging_provider not in ('gemini','local_clip'):
            raise ValueError('TAGGING_PROVIDER must be gemini or local_clip')
        if not 0 <= self.search_min_similarity <= 1:
            raise ValueError('SEARCH_MIN_SIMILARITY must be between 0 and 1')
        if not 0 <= self.duplicate_similarity_threshold <= 1:
            raise ValueError('DUPLICATE_SIMILARITY_THRESHOLD must be between 0 and 1')
        if not 1 <= self.max_frames <= 32:
            raise ValueError('MAX_FRAMES must be between 1 and 32')
        if min(self.max_upload_mb, self.max_video_seconds, self.gemini_timeout_seconds) <= 0:
            raise ValueError('Size and timeout limits must be positive')
