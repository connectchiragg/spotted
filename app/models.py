from typing import Literal

from pydantic import BaseModel, Field, field_validator


class Tag(BaseModel):
    label: str = Field(min_length=1, max_length=80)
    category: Literal['environment', 'object', 'action']
    frame_indices: list[int] = Field(min_length=1, max_length=32)

    @field_validator('label')
    @classmethod
    def normalize_label(cls, value: str) -> str:
        normalized = ' '.join(value.lower().strip().split())
        if not normalized:
            raise ValueError('Tag must not be blank')
        return normalized


class FrameDescription(BaseModel):
    frame_index: int = Field(ge=0, strict=True)
    description: str = Field(min_length=1, max_length=500)

    @field_validator('description')
    @classmethod
    def nonblank_description(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError('Frame description must not be blank')
        return value


class TaggingResult(BaseModel):
    summary: str = Field(min_length=1, max_length=2000)
    tags: list[Tag] = Field(max_length=40)
    frame_descriptions: list[FrameDescription] = Field(default_factory=list, max_length=32)


class VideoResponse(BaseModel):
    filename: str
    duration_seconds: float
    sampled_timestamps: list[float]
    model: str
    prompt_version: str
    summary: str
    tags: list[Tag]
    frame_descriptions: list[FrameDescription] = Field(default_factory=list, max_length=32)
