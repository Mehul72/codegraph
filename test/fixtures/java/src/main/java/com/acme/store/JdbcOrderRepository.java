package com.acme.store;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static java.util.Objects.requireNonNull;

/** JDBC implementation, one statement per method. */
public class JdbcOrderRepository implements OrderRepository {
  private static final String SELECT_RECENT =
      "SELECT o.id, o.status FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.id DESC LIMIT ?";

  private static final String SELECT_BY_ID = """
      SELECT id, status
      FROM orders
      WHERE id = ?
      """;

  private final Connection connection;

  public JdbcOrderRepository(Connection connection) {
    this.connection = requireNonNull(connection);
  }

  @Override
  public List<Order> recent(int limit) {
    List<Order> found = new ArrayList<>();
    try (PreparedStatement statement = connection.prepareStatement(SELECT_RECENT)) {
      statement.setInt(1, limit);
      try (ResultSet rows = statement.executeQuery()) {
        while (rows.next()) {
          found.add(RowMapper.map(rows));
        }
      }
    } catch (SQLException err) {
      throw new IllegalStateException("recent orders query failed", err);
    }
    return found;
  }

  @Override
  public Optional<Order> byId(long id) {
    try (PreparedStatement statement = connection.prepareStatement(SELECT_BY_ID)) {
      statement.setLong(1, id);
      try (ResultSet rows = statement.executeQuery()) {
        return rows.next() ? Optional.of(RowMapper.map(rows)) : Optional.empty();
      }
    } catch (SQLException err) {
      throw new IllegalStateException("order lookup failed", err);
    }
  }

  private void close() {
    try {
      connection.close();
    } catch (SQLException ignored) {
      // Closing twice is not worth reporting.
    }
  }

  /** Turns one result row into an order. */
  static final class RowMapper {
    static Order map(ResultSet rows) throws SQLException {
      return new Order(rows.getLong("id"), rows.getString("status"));
    }
  }
}
