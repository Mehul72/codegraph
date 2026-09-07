"""Database access for orders."""

import sqlite3

from app.models import MAX_ITEMS, Order

SELECT_ORDER = "SELECT id, total, currency FROM orders WHERE id = ?"


class OrderRepository:
    """Reads and writes rows in the orders table."""

    def __init__(self, connection):
        self.connection = connection

    def find(self, order_id) -> Order:
        """Load one order by id."""
        row = self.connection.execute(SELECT_ORDER, (order_id,)).fetchone()
        return self.to_order(row)

    def to_order(self, row):
        return Order(id=row[0], total=row[1], currency=row[2])

    def recent(self, limit=MAX_ITEMS):
        query = "SELECT id FROM orders JOIN customers ON customers.id = orders.customer_id LIMIT ?"
        return self.connection.execute(query, (limit,)).fetchall()


def open_repository(path):
    """Build a repository backed by a local sqlite file."""
    return OrderRepository(sqlite3.connect(path))
