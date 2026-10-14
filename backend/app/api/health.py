"""Liveness/readiness + capability metadata (no auth required)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from app.config import Settings
from app.deps import get_app_settings
from app.platforms import platform_matrix
from app.schemas import HealthOut

router = APIRouter(tags=["meta"])


@router.get("/health", response_model=HealthOut)
def health(settings: Settings = Depends(get_app_settings)) -> HealthOut:
    return HealthOut(
        status="ok",
        app=settings.app_name,
        version="1.0.0",
        environment=settings.environment,
    )


@router.get("/meta")
def meta(request: Request, settings: Settings = Depends(get_app_settings)) -> dict:
    return {
        "app": settings.app_name,
        "version": "1.0.0",
        "api_prefix": settings.api_prefix,
        "oauth_enabled": settings.oauth_enabled,
        "rate_limit": {
            "enabled": settings.rate_limit_enabled,
            "requests": settings.rate_limit_requests,
            "window_seconds": settings.rate_limit_window_seconds,
        },
        "platforms": platform_matrix(),
        "max_request_bytes": settings.max_request_bytes,
    }
