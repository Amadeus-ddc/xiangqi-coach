// Offline importer companion. The importer prepends native/main.swift's strict
// inspect function and compiles with the same unchanged native/core rules.
func normalizedNotation(_ raw: String) -> String {
    var value = raw.precomposedStringWithCompatibilityMapping
    for (from, to) in [("車","车"),("馬","马"),("進","进"),("後","后"),("將","将"),("帥","帅"),("砲","炮")] {
        value = value.replacingOccurrences(of: from, with: to)
    }
    for (index, digit) in "一二三四五六七八九".enumerated() {
        value = value.replacingOccurrences(of: String(digit), with: String(index + 1))
    }
    return value
}

func matchesNotation(_ raw: String, _ move: [String: String], _ position: [String: Any]) -> Bool {
    let target = Array(normalizedNotation(raw)), written = Array(normalizedNotation(move["chinese"]!))
    if target == written { return true }
    // The runtime formatter uses file numbers, whereas PGNs use 前/后/中
    // for equal pieces on one file. Resolve that prefix from the actual board.
    guard target.count == 4, written.count == 4,
          "前后中12345".contains(target[0]), target[1] == written[0],
          target.suffix(2) == written.suffix(2) else { return false }
    let board = position["pieces"] as! [String: String], from = move["from"]!
    let piece = board[from]!, red = piece.hasPrefix("r")
    let group = board.filter { $0.value == piece && $0.key.first == from.first }.map { $0.key }
        .sorted { red ? $0.last! > $1.last! : $0.last! < $1.last! }
    guard group.count >= 2 else { return false }
    let index = target[0] == "前" ? 0 : target[0] == "后" ? group.count - 1 : target[0] == "中" ? (group.count % 2 == 1 ? group.count / 2 : -1) : (Int(String(target[0]))! - 1)
    return index >= 0 && index < group.count && group[index] == from
}

struct ProofEdge { let move: String; let board: [String: String] }
final class MateProof {
    let winner: String, limit: Int
    var visited = 0, truncated = false
    var memo: [String: Bool] = [:]
    var edges: [String: [ProofEdge]] = [:]
    init(winner: String, limit: Int) { self.winner = winner; self.limit = limit }
    func legal(_ board: [String: String], _ side: String) -> [ProofEdge] {
        let key = XiangqiBoardUtils.piecesBySquareToFen(board, currentTurn: side)
        if let cached = edges[key] { return cached }
        var result: [ProofEdge] = []
        for (from, piece) in board.sorted(by: { $0.key < $1.key }) where piece.hasPrefix(side) {
            for to in MoveRules.getLegalDestinationSquares(fromSquare: from, piecesBySquare: board).sorted() {
                if (board[to] ?? "").hasSuffix("K") { continue }
                var next = board; next[to] = next.removeValue(forKey: from)
                result.append(ProofEdge(move: from + to, board: next))
            }
        }
        edges[key] = result
        return result
    }
    func hasLegal(_ board: [String: String], _ side: String) -> Bool {
        for (from, piece) in board.sorted(by: { $0.key < $1.key }) where piece.hasPrefix(side) {
            if MoveRules.getLegalDestinationSquares(fromSquare: from, piecesBySquare: board).contains(where: { !(board[$0] ?? "").hasSuffix("K") }) { return true }
        }
        return false
    }
    func win(_ board: [String: String], _ side: String, _ plies: Int) -> Bool {
        visited += 1
        if visited > limit { truncated = true; return false }
        let key = XiangqiBoardUtils.piecesBySquareToFen(board, currentTurn: side) + ":" + String(plies)
        if let cached = memo[key] { return cached }
        if plies == 0 {
            let result = side != winner && !hasLegal(board, side)
            memo[key] = result; return result
        }
        let moves = legal(board, side)
        if moves.isEmpty { let result = side != winner; memo[key] = result; return result }
        let next = side == "r" ? "b" : "r"
        let result = side == winner
            ? moves.contains { win($0.board, next, plies - 1) }
            : moves.allSatisfy { win($0.board, next, plies - 1) }
        memo[key] = result; return result
    }
    func paths(_ board: [String: String], _ side: String, _ plies: Int) -> [[String]] {
        if truncated { return [] }
        if plies == 0 { return !hasLegal(board, side) && side != winner ? [[]] : [] }
        let moves = legal(board, side)
        if moves.isEmpty { return side != winner ? [[]] : [] }
        let next = side == "r" ? "b" : "r"
        var result: [[String]] = []
        for edge in moves where win(edge.board, next, plies - 1) {
            result += paths(edge.board, next, plies - 1).map { [edge.move] + $0 }
        }
        return result
    }
}

while let line = readLine() {
    var id = ""
    do {
        let request = try JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
        id = request["id"] as? String ?? ""
        let fen = request["fen"] as! String
        var current = try inspect(fen)
        var result: [String: Any] = ["id": id]
        if request["operation"] as? String == "proof" {
            let side = current["turn"] as! String
            let board = current["pieces"] as! [String: String]
            let depth = request["maxPlayerMoves"] as! Int
            let solver = MateProof(winner: side, limit: request["nodeLimit"] as? Int ?? 200000)
            let win = !(current["terminal"] as! Bool) && solver.win(board, side, depth * 2 - 1)
            let paths = win ? solver.paths(board, side, depth * 2 - 1) : []
            result.merge(["win": win, "solutions": paths, "nodes": solver.visited, "states": solver.edges.count, "truncated": solver.truncated]) { _, new in new }
        } else {
            func position(_ current: [String: Any]) -> [String: Any] {
                return ["fen": current["fen"]!, "turn": current["turn"]!, "inCheck": current["inCheck"]!, "terminal": current["terminal"]!, "legalCount": current["legalCount"]!]
            }
            var positions = [position(current)], moves: [String] = []
            for text in request["notations"] as? [String] ?? [] {
                let candidates = (current["legalMoves"] as! [[String: String]]).filter { matchesNotation(text, $0, current) }
                guard candidates.count == 1 else { try fail("ply \(moves.count + 1): \(text) has \(candidates.count) legal matches") }
                let uci = candidates[0]["uci"]!
                let next = XiangqiBoardUtils.getNewFenAfterUCIMove(uciMove: uci, fen: current["fen"] as! String)!
                current = try inspect(next)
                moves.append(uci); positions.append(position(current))
            }
            result["positions"] = positions; result["moves"] = moves
        }
        let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
        print(String(decoding: data, as: UTF8.self))
    } catch {
        let message = (error as? RuleError)?.message ?? error.localizedDescription
        let data = try! JSONSerialization.data(withJSONObject: ["id": id, "error": message], options: [.sortedKeys])
        print(String(decoding: data, as: UTF8.self))
    }
    fflush(stdout)
}
