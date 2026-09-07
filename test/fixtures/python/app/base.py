"""Shared plumbing for services."""

import logging

LOG = logging.getLogger(__name__)


class BaseService:
    """Common lifecycle for every service in this app."""

    def __init__(self, name):
        self.name = name

    def describe(self):
        """Human readable label used in log lines."""
        return "service:" + self.name

    def audit(self, action):
        LOG.info("%s %s", self.describe(), action)
