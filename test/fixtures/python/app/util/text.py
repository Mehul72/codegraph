"""Small string helpers."""

import re

SLUG_PATTERN = re.compile(r"[^a-z0-9]+")


def slugify(value):
    """Lower case a string and replace runs of punctuation with dashes."""
    return SLUG_PATTERN.sub("-", value.lower()).strip("-")


def shorten(value, limit=40):
    if len(value) <= limit:
        return value
    return value[: limit - 3] + "..."
