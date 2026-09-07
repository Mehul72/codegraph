"""Domain types."""

from dataclasses import dataclass

MAX_ITEMS = 50
DEFAULT_CURRENCY = "usd"


@dataclass
class Order:
    """A customer order."""

    id: str
    total: int
    currency: str = DEFAULT_CURRENCY

    def is_large(self):
        return self.total > 100_000


class OrderError(Exception):
    """Raised when an order fails validation."""


def _hidden_helper(order: Order):
    return order.id
