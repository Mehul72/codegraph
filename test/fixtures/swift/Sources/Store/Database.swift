/// A thin wrapper over SQLite.
public final class Database {
    let path: String

    public init(path: String) {
        self.path = path
    }

    func query(_ sql: String, _ args: Any...) async throws -> [Row] {
        []
    }

    func execute(_ sql: String) throws {}

    func close() {}
}

public struct Row {
    let id: OrderID
}
