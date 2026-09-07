-- Core order schema for the store service.
-- Postgres flavoured, applied by the migration runner in file order.

/*
 * Customers arrive from the signup flow and are never hard deleted, so
 * everything below is free to hold a foreign key on to them.
 */
CREATE TABLE customers (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE products (
  sku TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  price_cents INT NOT NULL CHECK (price_cents >= 0)
);

-- Orders placed by a customer.
CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers (id),
  -- Was REFERENCES ghost_table (id) until 0006 folded it into status.
  status TEXT NOT NULL DEFAULT 'open',
  source TEXT NOT NULL DEFAULT 'legacy import, references legacy_orders',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.order_lines (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL,
  sku TEXT NOT NULL,
  quantity INT NOT NULL CHECK (quantity > 0),
  /* FOREIGN KEY (sku) REFERENCES ghost_table (sku), replaced by the ALTER below. */
  FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
);

-- Added late, because the product catalogue landed after the first release.
ALTER TABLE order_lines
  ADD CONSTRAINT fk_order_lines_sku
  FOREIGN KEY (sku) REFERENCES products (sku);

CREATE INDEX idx_orders_customer ON orders (customer_id);

-- Dropped in 0006. Kept as a record of the shape it used to have.
-- CREATE TABLE ghost_table (id BIGINT PRIMARY KEY);
/* ALTER TABLE orders ADD CONSTRAINT fk_ghost FOREIGN KEY (id) REFERENCES ghost_table (id); */
