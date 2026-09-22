import Foundation

/// Something whose writes are recorded.
protocol Auditable {
    func audit() -> String
}

public extension Order {
    /// The order as a customer sees it.
    func formatted() -> String {
        "\(status.rawValue): \(centsLabel())"
    }

    private func centsLabel() -> String {
        String(totalCents)
    }
}

extension SQLOrderStore: Auditable {
    func audit() -> String {
        "\(count) orders"
    }
}

extension OrderStore {
    public func findAll(ids: [OrderID]) async throws -> [Order] {
        var found: [Order] = []
        for id in ids {
            guard let order = try await find(id: id) else { continue }
            found.append(order)
        }
        return found
    }
}

public func makeDefaultStore() -> SQLOrderStore {
    SQLOrderStore(db: Database(path: ":memory:"))
}
