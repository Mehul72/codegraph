package com.acme.core;

/**
 * Fields every persisted row carries.
 */
public abstract class BaseEntity {
  private final long id;

  protected BaseEntity(long id) {
    this.id = id;
  }

  public long id() {
    return id;
  }
}
