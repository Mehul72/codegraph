package com.acme.core;

import java.util.Optional;

/** The one lookup every store supports. */
public interface Repository<T extends BaseEntity> {
  Optional<T> byId(long id);
}
