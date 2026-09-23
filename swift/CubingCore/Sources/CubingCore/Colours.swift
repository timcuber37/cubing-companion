/// WCA-standard face colour names and slot labels.
public enum Colours {
    public static let names = ["white", "orange", "green", "red", "blue", "yellow"]
    public static let hex = ["#f8fafc", "#f97316", "#22c55e", "#ef4444", "#3b82f6", "#eab308"]

    public static func name(_ face: Int) -> String { names[face] }
    public static func slot(_ slot: Slot) -> String {
        "\(names[slot.faces.0])-\(names[slot.faces.1])"
    }
    public static func swatches(_ slot: Slot) -> (String, String) {
        (hex[slot.faces.0], hex[slot.faces.1])
    }
}
