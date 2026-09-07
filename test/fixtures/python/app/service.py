"""Order business rules."""

from app.base import BaseService
from app.models import MAX_ITEMS, Order, OrderError
from app.repository import OrderRepository
from app.util.text import slugify


class OrderService(BaseService):
    """Validates and stores orders."""

    def __init__(self, repository: OrderRepository):
        super().__init__("orders")
        self.repository = repository

    def create(self, order: Order):
        """Validate an order and hand it to the repository."""
        self.validate(order)
        self.audit("create " + slugify(order.id))
        return self.repository.find(order.id)

    def validate(self, order: Order):
        if order.total <= 0:
            raise OrderError("total must be positive")
        if order.total > MAX_ITEMS * 1000:
            raise OrderError("order too large")
        return True
