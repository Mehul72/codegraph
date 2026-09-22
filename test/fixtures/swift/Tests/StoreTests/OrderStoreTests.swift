import XCTest
@testable import Store

final class OrderStoreTests: XCTestCase {
    var store: SQLOrderStore!

    override func setUp() {
        store = SQLOrderStore(db: Database(path: ":memory:"))
    }

    func testSaveThenFind() async throws {
        let order = Order(id: UUID(), totalCents: 500)
        try store.save(order)
        let found = try await store.find(id: order.id)
        XCTAssertEqual(found, order)
    }
}
