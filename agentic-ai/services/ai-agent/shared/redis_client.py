"""AURA-NET — shared/redis_client"""

from __future__ import annotations

import os
from typing import Optional

import redis.asyncio as aioredis

REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
_redis: Optional[aioredis.Redis] = None


def _get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(REDIS_URL, decode_responses=True)
    return _redis


async def get_value(key: str) -> Optional[str]:
    return await _get_redis().get(key)


async def set_value(key: str, value: str, ttl_seconds: int) -> None:
    await _get_redis().set(key, value, ex=ttl_seconds)


async def scan_keys(pattern: str) -> list[str]:
    keys: list[str] = []
    cursor = 0
    redis = _get_redis()
    while True:
        cursor, batch = await redis.scan(cursor=cursor, match=pattern, count=100)
        keys.extend(batch)
        if cursor == 0:
            break
    return keys
