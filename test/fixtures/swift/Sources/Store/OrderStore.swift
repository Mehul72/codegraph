import Foundation

/// Reads and writes orders.
public protocol OrderStore: AnyObject {
    func find(id: OrderID) async throws -> Order?
    func save(_ order: Order) throws
    var count: Int { get }
}

open class BaseStore {
    public init() {}

    func log(_ message: String) {
        print(message)
    }
}

public final class SQLOrderStore: BaseStore, OrderStore {
    private let db: Database
    public private(set) var count = 0

    public init(db: Database) {
        self.db = db
        super.init()
    }

    deinit {
        db.close()
    }

    public func find(id: OrderID) async throws -> Order? {
        let rows = try await db.query("SELECT * FROM orders WHERE id = ?", id)
        log("found \(rows.count)")
        return rows.first.map(Order.init(row:))
    }

    public func save(_ order: Order) throws {
        try db.execute("""
            INSERT INTO orders (id, total_cents)
            VALUES (?, ?)
            """)
        self.log("saved")
        count += 1
    }
}

actor OrderCache {
    private var cached: [OrderID: Order] = [:]

    func remember(_ order: Order) {
        cached[order.id] = order
    }
}
