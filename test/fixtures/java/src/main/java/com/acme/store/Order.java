package com.acme.store;

import com.acme.core.BaseEntity;

/** One customer order. */
public class Order extends BaseEntity {
  public static final String STATUS_OPEN = "open";

  private final String status;

  public Order(long id, String status) {
    super(id);
    this.status = status;
  }

  public String status() {
    return status;
  }

  boolean isOpen() {
    return STATUS_OPEN.equals(status);
  }
}
