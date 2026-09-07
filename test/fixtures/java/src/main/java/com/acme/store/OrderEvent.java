package com.acme.store;

/** Everything that can happen to an order once it is placed. */
public enum OrderEvent {
  PLACED,
  PAID,
  SHIPPED;

  /** Audit row written for one event. */
  public record Entry(long orderId, OrderEvent event) {
    public boolean isTerminal() {
      return event == SHIPPED;
    }
  }
}
