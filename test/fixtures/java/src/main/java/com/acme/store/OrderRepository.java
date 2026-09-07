package com.acme.store;

import java.util.List;

import com.acme.core.Repository;

/** Read side of the order store. */
public interface OrderRepository extends Repository<Order> {
  /** Rows one listing page returns. */
  int PAGE_SIZE = 50;

  List<Order> recent(int limit);
}
