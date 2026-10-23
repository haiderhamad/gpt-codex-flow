import Foundation
import CryptoKit
import CoreFoundation

// Offline, read-only role-proof verifier for future broker integration.
// This code lives in an AGENT-WRITABLE repository. It MUST NOT be interpreted
// as installed broker identity, trusted storage, client auth or an execution gate.
// In this prototype the "trusted" enrollment is supplied by the test harness.
enum GCFRoleAuditError: Error {
    case invalid(String)
}
private func fail(_ reason: String) -> GCFRoleAuditError { .invalid(reason) }
private let expectedRoles = ["chatgpt", "codex"]
private let proofDomain = "gcf:parallel-role-report-proof:v1"
private let ed25519SPKIPrefix = Data([
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00
])

private func dictionary(_ object: Any?) throws -> [String: Any] {
    guard let value = object as? [String: Any] else { throw fail("BAD_OBJECT") }
    return value
}
private func string(_ value: Any?, max: Int = 1600) throws -> String {
    guard let string = value as? String, !string.isEmpty,
          string.utf8.count <= max,
          !string.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else {
        throw fail("BAD_STRING")
    }
    return string
}
private func lowercaseHex(_ value: String, count: Int) -> Bool {
    value.utf8.count == count &&
    value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
}
private func pathList(_ object: Any?) throws -> [String] {
    guard let list = object as? [String], !list.isEmpty, list.count <= 30,
          Set(list).count == list.count else { throw fail("BAD_PATH_LIST") }
    for item in list {
        _ = try string(item, max: 249)
        if item.hasPrefix("/") || item.contains("\\") ||
            item.split(separator: "/", omittingEmptySubsequences: false).contains(where: {
                $0.isEmpty || $0 == "." || $0 == ".." || $0 == ".git" || $0 == ".ai-bridge"
            }) {
            throw fail("UNSAFE_PATH")
        }
    }
    return list
}
private func ed25519(_ encoded: Any?) throws -> Curve25519.Signing.PublicKey {
    let base64 = try string(encoded, max: 128)
    guard let der = Data(base64Encoded: base64), der.base64EncodedString() == base64,
          der.count == 44, der.prefix(12) == ed25519SPKIPrefix else {
        throw fail("INVALID_ED25519_SPKI")
    }
    do {
        return try Curve25519.Signing.PublicKey(rawRepresentation: Data(der.suffix(32)))
    } catch { throw fail("INVALID_ED25519_PUBLIC_KEY") }
}
private func sha256(_ input: String) -> String {
    SHA256.hash(data: Data(input.utf8)).map { String(format: "%02x", $0) }.joined()
}
private func roleMessage(sessionID: String, head: String, role: String,
                         task: String, owned: [String], patch: String,
                         evidence: String) throws -> Data {
    let transcript: [Any] = [
        proofDomain, sessionID, head, role, sha256(task),
        owned, patch, sha256(evidence)
    ]
    return try JSONSerialization.data(withJSONObject: transcript, options: [.withoutEscapingSlashes])
}
private func sameStrings(_ first: Any?, _ second: Any?) -> Bool {
    guard let a = first as? [String], let b = second as? [String] else { return false }
    return a == b
}
func auditPinnedRoleProofNative(enrollment: Any, session: Any) throws {
    let pins = try dictionary(enrollment)
    let proposed = try dictionary(session)
    // Claims of owner authority inside an agent-controlled session are never
    // accepted as proof; future broker authorization is a distinct operation.
    let forbiddenAuthorityFields: Set<String> = [
        "userApproved", "ownerApproved", "owner_approval_granted",
        "client_identity_verified", "execution_performed", "merge_performed",
        "permissionGranted", "authenticatedPrincipal"
    ]
    guard forbiddenAuthorityFields.isDisjoint(with: Set(proposed.keys)) else {
        throw fail("SPOOFED_AUTHORITY_FIELDS")
    }
    let pinID = try string(pins["session_id"], max: 64)
    let pinnedHead = try string(pins["base_head"], max: 64)
    let pinnedGoal = try string(pins["goal"], max: 1500)
    guard pinID.hasPrefix("parallel_"), pinID.count == 45,
          lowercaseHex(pinnedHead, count: 40) || lowercaseHex(pinnedHead, count: 64),
          proposed["session_id"] as? String == pinID,
          proposed["base_head"] as? String == pinnedHead,
          proposed["goal"] as? String == pinnedGoal else {
        throw fail("PINNED_SESSION_MISMATCH")
    }
    guard let version = proposed["schema"] as? NSNumber,
          CFGetTypeID(version) != CFBooleanGetTypeID(),
          version.intValue == 1, version.doubleValue == 1,
          let signed = proposed["role_proof_required"] as? NSNumber,
          CFGetTypeID(signed) == CFBooleanGetTypeID(), signed.boolValue,
          let state = proposed["status"] as? String,
          state == "ready_to_preview" || state == "preview_verified" else {
        throw fail("REVIEW_SESSION_NOT_SIGNED_OR_READY")
    }
    let pinnedKeys = try dictionary(pins["role_public_keys"])
    let proposedKeys = try dictionary(proposed["role_public_keys"])
    let pinRoles = try dictionary(pins["roles"])
    let reported = try dictionary(proposed["roles"])
    guard Set(pinnedKeys.keys) == Set(expectedRoles),
          Set(proposedKeys.keys) == Set(expectedRoles),
          Set(pinRoles.keys) == Set(expectedRoles),
          Set(reported.keys) == Set(expectedRoles) else {
        throw fail("REQUIRED_ROLE_SET_MISMATCH")
    }
    let a = try string(pinnedKeys["chatgpt"], max: 128)
    let b = try string(pinnedKeys["codex"], max: 128)
    guard a != b else { throw fail("DUPLICATE_ROLE_KEYS") }
    var allPaths = Set<String>()
    for role in expectedRoles {
        let encoded = try string(pinnedKeys[role], max: 128)
        guard proposedKeys[role] as? String == encoded else {
            throw fail("ROLE_PUBLIC_KEY_REPLACED")
        }
        let key = try ed25519(encoded)
        let assignment = try dictionary(pinRoles[role])
        let report = try dictionary(reported[role])
        let task = try string(assignment["task"], max: 1500)
        let pinnedPaths = try pathList(assignment["target_paths"])
        guard report["task"] as? String == task,
              sameStrings(report["target_paths"], pinnedPaths),
              report["state"] as? String == "reported" else {
            throw fail("ASSIGNMENT_OR_ROLE_STATE_MISMATCH")
        }
        for file in pinnedPaths {
            guard allPaths.insert(file).inserted else {
                throw fail("OVERLAPPING_PINNED_OWNERSHIP")
            }
        }
        let changedPaths = try pathList(report["changed_paths"])
        guard changedPaths.allSatisfy({ pinnedPaths.contains($0) }) else {
            throw fail("OUT_OF_SCOPE_REPORT")
        }
        let patch = try string(report["patch_sha256"], max: 64)
        let evidence = try string(report["evidence"], max: 500)
        let encodedSignature = try string(report["proof_signature"], max: 128)
        guard lowercaseHex(patch, count: 64),
              let signature = Data(base64Encoded: encodedSignature),
              signature.count == 64,
              signature.base64EncodedString() == encodedSignature else {
            throw fail("INVALID_REPORT_FORMAT")
        }
        let message = try roleMessage(sessionID: pinID, head: pinnedHead,
            role: role, task: task, owned: pinnedPaths, patch: patch,
            evidence: evidence)
        guard key.isValidSignature(signature, for: message) else {
            throw fail("INVALID_REPORT_SIGNATURE")
        }
    }
}

// NO general-purpose CLI or importable approval interface. Only disposable
// test harness may compile this executable entry point.
#if GCF_OWNER_ROLE_AUDIT_TEST
let input = FileHandle.standardInput.readDataToEndOfFile()
guard !input.isEmpty, input.count <= 64_000 else {
    fputs("REFUSED:BAD_INPUT_SIZE\n", stderr)
    exit(2)
}
do {
    let wrapper = try dictionary(JSONSerialization.jsonObject(with: input))
    guard Set(wrapper.keys) == Set(["enrollment", "session"]) else {
        throw fail("UNEXPECTED_INPUT_FIELDS")
    }
    try auditPinnedRoleProofNative(
        enrollment: wrapper["enrollment"] as Any,
        session: wrapper["session"] as Any
    )
    print("PASS:CRYPTOGRAPHIC_ROLE_PROOF_ONLY")
    print("CLIENT_IDENTITY_VERIFIED=false")
    print("OWNER_APPROVAL_GRANTED=false")
} catch {
    fputs("REFUSED:NATIVE_ROLE_PROOF_AUDIT\n", stderr)
    exit(2)
}
#endif
