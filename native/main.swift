import Foundation

struct RuleError: Error { let message: String }
func fail(_ message: String) throws -> Never { throw RuleError(message: message) }
func inspect(_ raw: String, includeLegal: Bool = true) throws -> [String: Any] {
    let fields = raw.split(separator: " ")
    guard fields.count == 2, ["r", "b", "w"].contains(fields[1]),
          raw.unicodeScalars.allSatisfy({ $0.isASCII }),
          XiangqiBoardUtils.isValidBoardFen(raw) else { try fail("局面格式无效。") }
    let side = fields[1] == "b" ? "b" : "r"
    let board = XiangqiBoardUtils.fenToPiecesBySquare(raw)
    guard board.values.filter({ $0 == "rK" }).count == 1,
          board.values.filter({ $0 == "bK" }).count == 1,
          board.count <= 32 else { try fail("局面必须包含双方将帅，且至多 32 个棋子。") }
    for prefix in ["r", "b"] {
        for (kind, maxCount) in [("R", 2), ("N", 2), ("B", 2), ("A", 2), ("C", 2), ("P", 5)] {
            guard board.values.filter({ $0 == prefix + kind }).count <= maxCount else { try fail("棋子数量无效。") }
        }
        let palace = prefix == "r" ? Set(["d0","e0","f0","d1","e1","f1","d2","e2","f2"]) : Set(["d7","e7","f7","d8","e8","f8","d9","e9","f9"])
        guard let king = board.first(where: { $0.value == prefix + "K" }), palace.contains(king.key) else { try fail("将帅必须在九宫内。") }
        let advisors = prefix == "r" ? Set(["d0","f0","e1","d2","f2"]) : Set(["d9","f9","e8","d7","f7"])
        let elephants = prefix == "r" ? Set(["c0","g0","a2","e2","i2","c4","g4"]) : Set(["c9","g9","a7","e7","i7","c5","g5"])
        for (square, piece) in board where piece.hasPrefix(prefix) {
            if piece.hasSuffix("A") && !advisors.contains(square) { try fail("仕士位置无效。") }
            if piece.hasSuffix("B") && !elephants.contains(square) { try fail("相象位置无效。") }
            if piece.hasSuffix("P") {
                let rank = Int(String(square.last!))!
                let ownHalf = prefix == "r" ? rank < 5 : rank > 4
                guard (prefix == "r" ? rank >= 3 : rank <= 6),
                      !ownHalf || "acegi".contains(square.first!) else { try fail("兵卒位置无效。") }
            }
        }
    }
    guard !MoveRules.isKingInCheck(isRed: side != "r", piecesBySquare: board) else { try fail("非行棋方的将帅正受攻击，局面或轮次无效。") }
    let fen = XiangqiBoardUtils.piecesBySquareToFen(board, currentTurn: side)
    var legal: [[String: String]] = []
    for (from, piece) in board.sorted(by: { $0.key < $1.key }) where piece.hasPrefix(side) {
        for to in MoveRules.getLegalDestinationSquares(fromSquare: from, piecesBySquare: board).sorted() {
            guard !((board[to] ?? "").hasSuffix("K")),
                  let next = XiangqiBoardUtils.getNewFenAfterMove(from: from, to: to, currentPieces: board) else { continue }
            legal.append(["uci": from + to, "from": from, "to": to,
                          "chinese": Move.stringifyMove(fen1: fen, fen2: next, backup: from + to, isHorizontalFlipped: false)])
        }
    }
    let inCheck = MoveRules.isKingInCheck(isRed: side == "r", piecesBySquare: board)
    var value: [String: Any] = ["fen": fen, "turn": side, "pieces": board, "inCheck": inCheck,
                               "terminal": legal.isEmpty, "legalCount": legal.count]
    if includeLegal { value["legalMoves"] = legal }
    if legal.isEmpty {
        value["winner"] = side == "r" ? "b" : "r"
        value["endReason"] = inCheck ? "checkmate" : "stalemate"
    }
    return value
}

while let line = readLine() {
    do {
        guard let data = line.data(using: .utf8),
              let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let fen = request["fen"] as? String else { try fail("需要 fen 字段。") }
        var current = try inspect(fen)
        var steps: [[String: Any]] = []
        for uci in request["moves"] as? [String] ?? [] {
            guard let chosen = (current["legalMoves"] as? [[String: String]])?.first(where: { $0["uci"] == uci }) else {
                try fail("不合法的着法：\(uci)。请重新读取合法走法。")
            }
            let next = XiangqiBoardUtils.getNewFenAfterUCIMove(uciMove: uci, fen: current["fen"] as! String)!
            current = try inspect(next)
            steps.append(["uci": uci, "chinese": chosen["chinese"]!, "fen": current["fen"]!])
        }
        current["steps"] = steps
        if request["includeLegal"] as? Bool == false { current.removeValue(forKey: "legalMoves") }
        let output = try JSONSerialization.data(withJSONObject: current, options: [.sortedKeys])
        print(String(decoding: output, as: UTF8.self))
    } catch {
        let message = (error as? RuleError)?.message ?? error.localizedDescription
        let output = try! JSONSerialization.data(withJSONObject: ["error": message])
        print(String(decoding: output, as: UTF8.self))
    }
}
