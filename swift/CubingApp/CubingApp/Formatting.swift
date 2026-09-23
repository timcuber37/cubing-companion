import CubingCore
import CubingSession
import Foundation

enum Format {
    /// `12.34`, or `1:02.34` past a minute — how a cube timer shows a time.
    static func time(_ ms: Double?) -> String {
        guard let ms else { return "–" }
        let hundredths = Int((ms / 10).rounded())
        let seconds = hundredths / 100, fraction = hundredths % 100
        let body = seconds >= 60
            ? "\(seconds / 60):\(String(format: "%02d", seconds % 60))"
            : "\(seconds)"
        return "\(body).\(String(format: "%02d", fraction))"
    }

    static func tps(_ value: Double?) -> String {
        value.map { String(format: "%.2f", $0) } ?? "–"
    }

    static func rating(_ value: Double?) -> String {
        value.map { String(format: "%.1f", $0) } ?? "–"
    }

    static func phase(_ phase: Phase) -> String {
        switch phase {
        case .cross: "Cross"
        case .f2l1: "F2L 1"
        case .f2l2: "F2L 2"
        case .f2l3: "F2L 3"
        case .f2l4: "F2L 4"
        case .oll: "OLL"
        case .pll: "PLL"
        case .auf: "AUF"
        }
    }

    static func date(_ msSince1970: Double) -> String {
        Date(timeIntervalSince1970: msSince1970 / 1000).formatted(date: .abbreviated, time: .shortened)
    }
}
