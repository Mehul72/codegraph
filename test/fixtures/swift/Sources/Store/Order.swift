import Foundation

public typealias OrderID = UUID

/// A customer order.
///
/// Totals are kept in cents so rounding never drifts.
public struct Order: Identifiable, Hashable {
    /// Where an order is in its life.
    public enum Status: String, CaseIterable {
        case open
        case shipped
        case refunded(reason: String)
    }

    static let TABLE = "orders"

    public let id: OrderID
    public var status: Status
    var totalCents: Int
    private(set) var lines: [LineItem] = []

    public init(id: OrderID, totalCents: Int) {
        self.id = id
        self.status = .open
        self.totalCents = totalCents
    }

    /** Whether the order still needs to be shipped. */
    public var isPending: Bool {
        return status == .open
    }

    mutating func add(_ line: LineItem) {
        lines.append(line)
        totalCents += line.priceCents
    }
}

extension Order: Comparable, Auditable {
    public static func < (lhs: Order, rhs: Order) -> Bool {
        lhs.totalCents < rhs.totalCents
    }

    func audit() -> String {
        "order \(id)"
    }
}

struct LineItem: Hashable {
    let sku: String
    let priceCents: Int
}
