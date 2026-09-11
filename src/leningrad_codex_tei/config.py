"""Pipeline configuration."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml


@dataclass
class ImageConfig:
    base_url: str
    naming: str


@dataclass
class SeedConfig:
    upstream_url: str
    commit: str
    file: str
    snapshot_commit: str | None = None


@dataclass
class UxlcConfig:
    download_url: str


@dataclass
class AiConfig:
    model: str
    temperature: float = 1.0
    max_retries: int = 3
    inference: str = "flex"
    code_execution: bool = True
    base_delay: float = 5.0
    timeout_ms: int = 600_000
    fallback_to_standard: bool = False
    image_transport: str = "upload"
    thinking_level: str = "medium"

    IMAGE_TRANSPORTS = ("encode", "upload")
    INFERENCE_MODES = ("standard", "flex", "batch")
    THINKING_LEVELS = ("low", "medium", "high")

    def __post_init__(self) -> None:
        if self.inference not in self.INFERENCE_MODES:
            raise ValueError(
                f"ai.inference must be one of {self.INFERENCE_MODES}, "
                f"got {self.inference!r}"
            )
        if self.thinking_level not in self.THINKING_LEVELS:
            raise ValueError(
                f"ai.thinking_level must be one of {self.THINKING_LEVELS}, "
                f"got {self.thinking_level!r}"
            )
        if self.image_transport not in self.IMAGE_TRANSPORTS:
            raise ValueError(
                f"ai.image_transport must be one of {self.IMAGE_TRANSPORTS}, "
                f"got {self.image_transport!r}"
            )
        if self.inference == "batch" and self.image_transport != "encode":
            raise ValueError(
                'ai.image_transport must be "encode" when ai.inference is "batch"'
            )


@dataclass
class PathsConfig:
    uxlc: Path
    seed: Path
    images: Path
    output: Path
    audit: Path
    alignments: Path
    word_stream: Path
    provenance: Path


@dataclass
class Config:
    project_name: str
    project_version: str
    paths: PathsConfig
    images: ImageConfig
    seed: SeedConfig
    uxlc: UxlcConfig
    ai: AiConfig


def load_config(config_path: Path = Path("config.yaml")) -> Config:
    raw = yaml.safe_load(config_path.read_text())
    p = raw["paths"]
    ai_raw = dict(raw["ai"])
    if "service_tier" in ai_raw and "inference" not in ai_raw:
        ai_raw["inference"] = ai_raw.pop("service_tier")
    else:
        ai_raw.pop("service_tier", None)
    return Config(
        project_name=raw["project"]["name"],
        project_version=raw["project"]["version"],
        paths=PathsConfig(
            uxlc=Path(p["uxlc"]),
            seed=Path(p["seed"]),
            images=Path(p["images"]),
            output=Path(p["output"]),
            audit=Path(p["audit"]),
            alignments=Path(p["alignments"]),
            word_stream=Path(p["word_stream"]),
            provenance=Path(p["provenance"]),
        ),
        images=ImageConfig(**raw["images"]),
        seed=SeedConfig(**raw["seed"]),
        uxlc=UxlcConfig(**raw["uxlc"]),
        ai=AiConfig(**ai_raw),
    )
