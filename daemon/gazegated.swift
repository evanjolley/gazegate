// gazegated — the root half of GazeGate.
//
// It does two jobs. It keeps /etc/hosts in sync with the current decision, once
// a second, forever. And it owns every piece of state that decision depends on,
// which the unprivileged app can no longer write directly.
//
// Before this existed the app wrote unlock_until into a file in ~/Library, which
// meant one `echo` defeated the entire eye-contact gate with no password. Now the
// app has to ask over a unix socket, and the request is only honoured if the peer
// on the other end is genuinely GazeGate, checked against its code signature via
// the connection's audit token.
//
// Paths and the requirement string are overridable through the environment so the
// whole thing can be exercised without root.

import Foundation
import Security

// MARK: - Configuration

let env = ProcessInfo.processInfo.environment
let STATE_DIR = env["GAZEGATE_STATE_DIR"] ?? "/Library/Application Support/GazeGate"
let STATE_FILE = STATE_DIR + "/state.json"
let HOSTS = env["GAZEGATE_HOSTS"] ?? "/etc/hosts"
let SOCKET = env["GAZEGATE_SOCKET"] ?? "/var/run/gazegate.sock"
let REQUIREMENT = env["GAZEGATE_REQUIREMENT"]
    ?? "identifier \"com.gazegate.app\" and anchor apple generic and certificate leaf[subject.OU] = \"3ZWQQ4J23W\""

let START_MARK = "# GAZEGATE-START"
let END_MARK = "# GAZEGATE-END"
let UNLOCK_MINUTES = 10
let MIN_GATE_SECONDS = 30
let MAX_GATE_SECONDS = 600

// Always blocked. Unioned in unconditionally, so emptying the extras list cannot
// drop them. Kept in step with CORE_SITES in blocker.js.
let CORE_SITES = [
    "x.com", "www.x.com", "twitter.com", "www.twitter.com",
    "instagram.com", "www.instagram.com",
    "linkedin.com", "www.linkedin.com",
]

func log(_ msg: String) {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd HH:mm:ss"
    print("\(f.string(from: Date())) \(msg)")
    fflush(stdout)
}

// MARK: - State
//
// One JSON file, root owned, world readable so the app can render without asking.
// Only this process ever writes it.

final class State {
    private let lock = NSLock()
    private var d: [String: Any] = [:]

    init() {
        try? FileManager.default.createDirectory(atPath: STATE_DIR, withIntermediateDirectories: true)
        load()
    }

    private func load() {
        if let data = FileManager.default.contents(atPath: STATE_FILE),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            d = obj
        }
        if d["unlock_until"] == nil { d["unlock_until"] = 0 }
        if d["sunday_block_until"] == nil { d["sunday_block_until"] = 0 }
        if d["gate_seconds"] == nil { d["gate_seconds"] = MIN_GATE_SECONDS }
        if d["escalate"] == nil { d["escalate"] = false }
        if d["unlocks_date"] == nil { d["unlocks_date"] = "" }
        if d["unlocks_count"] == nil { d["unlocks_count"] = 0 }
        if d["sites"] == nil { d["sites"] = [String]() }
        persist()
    }

    private func persist() {
        guard let data = try? JSONSerialization.data(withJSONObject: d, options: [.sortedKeys, .prettyPrinted])
        else { return }
        let tmp = STATE_FILE + ".tmp"
        try? data.write(to: URL(fileURLWithPath: tmp))
        _ = try? FileManager.default.replaceItemAt(URL(fileURLWithPath: STATE_FILE),
                                                   withItemAt: URL(fileURLWithPath: tmp))
        // Readable by the app, writable only by us.
        try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: STATE_FILE)
    }

    func snapshot() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return d
    }

    func int(_ k: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        return (d[k] as? Int) ?? 0
    }

    func bool(_ k: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return (d[k] as? Bool) ?? false
    }

    func strings(_ k: String) -> [String] {
        lock.lock(); defer { lock.unlock() }
        return (d[k] as? [String]) ?? []
    }

    func mutate(_ body: (inout [String: Any]) -> Void) {
        lock.lock()
        body(&d)
        persist()
        lock.unlock()
    }
}

let state = State()

func todayKey() -> String {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: Date())
}

func unlocksToday() -> Int {
    let s = state.snapshot()
    guard (s["unlocks_date"] as? String) == todayKey() else { return 0 }
    return (s["unlocks_count"] as? Int) ?? 0
}

// What the next stare costs. Doubles per unlock already granted today when the
// rising price is on.
func effectiveGateSeconds() -> Int {
    let base = max(MIN_GATE_SECONDS, state.int("gate_seconds"))
    guard state.bool("escalate") else { return base }
    let scaled = Double(base) * pow(2.0, Double(unlocksToday()))
    return min(MAX_GATE_SECONDS, Int(scaled))
}

// MARK: - The /etc/hosts loop

func baseHosts() -> [String] {
    guard let text = try? String(contentsOfFile: HOSTS, encoding: .utf8) else { return [] }
    var out: [String] = []
    var skipping = false
    for line in text.components(separatedBy: "\n") {
        if line == START_MARK { skipping = true; continue }
        if line == END_MARK { skipping = false; continue }
        if !skipping { out.append(line) }
    }
    while let last = out.last, last.isEmpty { out.removeLast() }
    return out
}

func blockedSites() -> [String] {
    var seen = Set<String>()
    var out: [String] = []
    for s in CORE_SITES + state.strings("sites") {
        let t = s.trimmingCharacters(in: .whitespaces).lowercased()
        if t.isEmpty || t.hasPrefix("#") { continue }
        if seen.insert(t).inserted { out.append(t) }
    }
    return out
}

func desiredHosts(_ decision: String) -> String {
    var lines = baseHosts()
    if decision == "BLOCK" {
        lines.append(START_MARK)
        for s in blockedSites() { lines.append("0.0.0.0 \(s)") }
        lines.append(END_MARK)
    }
    return lines.joined(separator: "\n") + "\n"
}

func decide() -> String {
    let now = Int(Date().timeIntervalSince1970)
    if now < state.int("unlock_until") { return "ALLOW" }
    let isSunday = Calendar.current.component(.weekday, from: Date()) == 1
    if isSunday { return now < state.int("sunday_block_until") ? "BLOCK" : "ALLOW" }
    return "BLOCK"
}

func applyHosts() {
    let decision = decide()
    let want = desiredHosts(decision)
    let have = (try? String(contentsOfFile: HOSTS, encoding: .utf8)) ?? ""
    guard want != have else { return }
    do {
        try want.write(toFile: HOSTS, atomically: false, encoding: .utf8)
        // Same message shape the bash daemon used, so the app's history parser
        // keeps working across the whole log.
        log("applied \(decision)")
        flushDNS()
    } catch {
        log("hosts write failed \(error)")
    }
}

func flushDNS() {
    for (path, args) in [("/usr/bin/dscacheutil", ["-flushcache"]), ("/usr/bin/killall", ["-HUP", "mDNSResponder"])] {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
        p.waitUntilExit()
    }
}

// MARK: - Peer authentication
//
// The whole point of this daemon. A request is only honoured if the process on
// the other end of the socket satisfies GazeGate's code requirement. The audit
// token is used rather than the pid, because pids can be recycled between the
// check and the act.

let LOCAL_PEERTOKEN: Int32 = 0x006

func peerIsGazeGate(_ fd: Int32) -> Bool {
    var token = audit_token_t()
    var len = socklen_t(MemoryLayout<audit_token_t>.size)
    let got = withUnsafeMutablePointer(to: &token) { ptr -> Int32 in
        getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, ptr, &len)
    }
    guard got == 0, len == socklen_t(MemoryLayout<audit_token_t>.size) else {
        log("auth failed, no peer token")
        return false
    }

    let data = withUnsafeBytes(of: token) { Data($0) }
    let attrs = [kSecGuestAttributeAudit: data] as CFDictionary

    var code: SecCode?
    guard SecCodeCopyGuestWithAttributes(nil, attrs, [], &code) == errSecSuccess, let code else {
        log("auth failed, no guest for token")
        return false
    }

    var req: SecRequirement?
    guard SecRequirementCreateWithString(REQUIREMENT as CFString, [], &req) == errSecSuccess, let req else {
        log("auth failed, bad requirement string")
        return false
    }

    let status = SecCodeCheckValidity(code, [], req)
    if status != errSecSuccess { log("auth rejected, status \(status)") }
    return status == errSecSuccess
}

// MARK: - Commands

func grantUnlock(minutes: Int) -> [String: Any] {
    let until = Int(Date().timeIntervalSince1970) + minutes * 60
    state.mutate { d in
        d["unlock_until"] = until
        // The counter is what makes the next stare cost more, so it lives here
        // too. Resetting it by hand was another way round the rising price.
        let sameDay = (d["unlocks_date"] as? String) == todayKey()
        d["unlocks_date"] = todayKey()
        d["unlocks_count"] = (sameDay ? ((d["unlocks_count"] as? Int) ?? 0) : 0) + 1
    }
    return ["ok": true, "unlock_until": until]
}

func handle(_ req: [String: Any]) -> [String: Any] {
    switch req["cmd"] as? String ?? "" {
    case "get":
        var s = state.snapshot()
        s["effective_gate_seconds"] = effectiveGateSeconds()
        s["unlocks_today"] = unlocksToday()
        return ["ok": true, "state": s]

    case "unlock":
        return grantUnlock(minutes: (req["minutes"] as? Int) ?? UNLOCK_MINUTES)

    case "lock":
        state.mutate { $0["unlock_until"] = 0 }
        return ["ok": true]

    case "sundayBlock":
        var c = Calendar.current
        c.timeZone = TimeZone.current
        let midnight = c.startOfDay(for: Date().addingTimeInterval(86400))
        state.mutate { $0["sunday_block_until"] = Int(midnight.timeIntervalSince1970) }
        return ["ok": true]

    case "sundayClear":
        state.mutate { $0["sunday_block_until"] = 0 }
        return ["ok": true]

    case "setGateSeconds":
        let v = max(MIN_GATE_SECONDS, (req["seconds"] as? Int) ?? MIN_GATE_SECONDS)
        state.mutate { $0["gate_seconds"] = v }
        return ["ok": true, "gate_seconds": v]

    case "setEscalate":
        let v = (req["on"] as? Bool) ?? false
        state.mutate { $0["escalate"] = v }
        return ["ok": true, "escalate": v]

    case "setSites":
        let raw = (req["sites"] as? [String]) ?? []
        var seen = Set<String>()
        var extras: [String] = []
        for s in raw {
            let t = s.trimmingCharacters(in: .whitespaces).lowercased()
            if t.isEmpty || t.hasPrefix("#") || CORE_SITES.contains(t) { continue }
            if seen.insert(t).inserted { extras.append(t) }
        }
        state.mutate { $0["sites"] = extras }
        return ["ok": true, "sites": extras]

    default:
        return ["ok": false, "error": "unknown command"]
    }
}

// MARK: - Socket server

func serve() {
    unlink(SOCKET)
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { log("socket() failed"); exit(1) }

    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(SOCKET.utf8)
    guard pathBytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
        log("socket path too long"); exit(1)
    }
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
        raw.copyBytes(from: pathBytes)
    }
    let size = socklen_t(MemoryLayout<sockaddr_un>.size)
    let bound = withUnsafePointer(to: &addr) { p in
        p.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, size) }
    }
    guard bound == 0 else { log("bind() failed errno \(errno)"); exit(1) }

    // Anyone may connect. Being allowed to talk is not being allowed to act —
    // authorisation is the code-signature check, not the file mode.
    chmod(SOCKET, 0o666)
    guard listen(fd, 8) == 0 else { log("listen() failed"); exit(1) }
    log("listening on \(SOCKET)")

    while true {
        let client = accept(fd, nil, nil)
        if client < 0 { continue }
        DispatchQueue.global().async {
            defer { close(client) }
            // Drain the request first even when it will be refused. Closing on an
            // unread socket makes the peer see EPIPE instead of the reason.
            var buf = [UInt8](repeating: 0, count: 65536)
            let n = read(client, &buf, buf.count)

            guard peerIsGazeGate(client) else {
                let deny = "{\"ok\":false,\"error\":\"unauthorized\"}\n"
                _ = deny.withCString { write(client, $0, strlen($0)) }
                return
            }
            guard n > 0 else { return }
            let data = Data(buf[0..<n])
            guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                let bad = "{\"ok\":false,\"error\":\"bad request\"}\n"
                _ = bad.withCString { write(client, $0, strlen($0)) }
                return
            }
            let resp = handle(obj)
            if let out = try? JSONSerialization.data(withJSONObject: resp) {
                out.withUnsafeBytes { p in _ = write(client, p.baseAddress, out.count) }
                _ = "\n".withCString { write(client, $0, 1) }
            }
            // A state change should show up in /etc/hosts immediately, not up to
            // a second later.
            applyHosts()
        }
    }
}

// MARK: - Main

log("gazegated starting, state \(STATE_FILE)")
DispatchQueue.global().async {
    while true {
        applyHosts()
        Thread.sleep(forTimeInterval: 1.0)
    }
}
serve()
