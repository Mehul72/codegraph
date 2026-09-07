"""HTTP surface."""

from flask import Flask, request

from app.models import Order
from app.repository import open_repository
from app.service import OrderService

app = Flask(__name__)
service = OrderService(open_repository("orders.db"))


@app.post("/orders")
def create_order():
    """Create an order from the request body."""
    payload = request.get_json()
    order = Order(id=payload["id"], total=payload["total"])
    return {"id": service.create(order).id}


@app.route("/orders/<order_id>", methods=["GET"])
def read_order(order_id):
    order = service.repository.find(order_id)
    return {"id": order.id, "total": order.total}


def main():
    """Run the development server."""
    app.run(port=8080)
