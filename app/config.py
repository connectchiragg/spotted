import os
from dataclasses import dataclass, field

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    api_key: str = field(default_factory=lambda: os.getenv('GEMINI_API_KEY', ''), repr=False)
    model: str = field(default_factory=lambda: os.getenv('GEMINI_MODEL', 'gemini-3.6-flash'))
    max_upload_mb: int = field(default_factory=lambda: int(os.getenv('MAX_UPLOAD_MB', '100')))
    max_video_seconds: int = field(default_factory=lambda: int(os.getenv('MAX_VIDEO_SECONDS', '600')))
    max_frames: int = field(default_factory=lambda: int(os.getenv('MAX_FRAMES', '8')))
    gemini_timeout_seconds: int = field(default_factory=lambda: int(os.getenv('GEMINI_TIMEOUT_SECONDS', '90')))
    aws_profile: str = field(default_factory=lambda: os.getenv('AWS_PROFILE', 'default'))
    aws_region: str = field(default_factory=lambda: os.getenv('AWS_REGION', 'ap-south-1'))
    s3_bucket: str = field(default_factory=lambda: os.getenv('S3_BUCKET', ''))
    sqs_queue_url: str = field(default_factory=lambda: os.getenv('SQS_QUEUE_URL', ''))
    database_path: str = field(default_factory=lambda: os.getenv('DATABASE_PATH', 'data/instawork.db'))
    aws_usage_enabled: bool = field(default_factory=lambda: os.getenv('AWS_USAGE_ENABLED', 'false').lower() == 'true')

    @property
    def lease_seconds(self) -> int:
        return max(600, self.max_frames * 10 + self.gemini_timeout_seconds + 180)

    def __post_init__(self):
        if not 1 <= self.max_frames <= 32:
            raise ValueError('MAX_FRAMES must be between 1 and 32')
        if min(self.max_upload_mb, self.max_video_seconds, self.gemini_timeout_seconds) <= 0:
            raise ValueError('Size and timeout limits must be positive')
