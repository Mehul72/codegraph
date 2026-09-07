package com.acme.web;

import java.util.List;

import org.springframework.web.bind.annotation.*;

import com.acme.store.Order;
import com.acme.store.OrderRepository;

/** HTTP surface for orders. */
@RestController
@RequestMapping("/api/orders")
public class OrderController {
  private final OrderRepository repository;

  public OrderController(OrderRepository repository) {
    this.repository = repository;
  }

  /** Most recent orders, newest first. */
  @GetMapping
  public List<Order> recent() {
    return repository.recent(OrderRepository.PAGE_SIZE);
  }

  @GetMapping("/{id}")
  public Order byId(@PathVariable long id) {
    return repository.byId(id).orElse(null);
  }

  @RequestMapping(value = "/summary", method = RequestMethod.GET)
  public int summary() {
    return repository.recent(OrderRepository.PAGE_SIZE).size();
  }
}
