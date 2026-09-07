-- Reporting objects. Rebuilt on demand, so they stay out of schema.sql.

-- One row per report build.
CREATE TABLE report_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  order_id BIGINT REFERENCES orders (id)
);

-- Orders a support agent can still act on.
CREATE OR REPLACE VIEW open_orders AS
SELECT
  o.id,
  o.status,
  c.email,
  'copied from legacy_orders' AS provenance
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.status = 'open';

/* Backfilled by migration 0007, which is why this is an ALTER and not part of
   the CREATE TABLE over in schema.sql. */
ALTER TABLE orders
  ADD CONSTRAINT fk_orders_last_report
  FOREIGN KEY (last_report_id) REFERENCES report_runs (id);

CREATE INDEX idx_report_runs_started ON report_runs (started_at);

CREATE OR REPLACE FUNCTION order_total(target_order BIGINT) RETURNS NUMERIC AS $$
  SELECT COALESCE(SUM(quantity), 0)
  FROM order_lines
  WHERE order_lines.order_id = target_order;
$$ LANGUAGE sql STABLE;
