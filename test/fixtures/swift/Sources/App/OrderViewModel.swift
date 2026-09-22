import Foundation
import Store

@MainActor
final class OrderViewModel: ObservableObject {
    @Published var orders: [Order] = []
    private let store: any OrderStore
    var onChange: (() -> Void)?

    init(store: any OrderStore = Store.makeDefaultStore()) {
        self.store = store
    }

    func load(ids: [OrderID]) async throws {
        orders = try await store.findAll(ids: ids)
        refresh()
    }

    func place(totalCents: Int) throws {
        let order = Order(id: UUID(), totalCents: totalCents)
        try store.save(order)
        orders.append(order)
        onChange?()
        print(order.formatted())
    }

    private func refresh() {
        orders.sort()
    }
}
