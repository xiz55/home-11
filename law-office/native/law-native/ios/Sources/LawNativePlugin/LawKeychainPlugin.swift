import Foundation
import Security
import Capacitor

/// حفظ أسرار الجهاز (جلسة الحساب السحابي، معرّف الجهاز، بيانات الدخول دون اتصال المجزأة) في Keychain.
/// الإتاحة: بعد أول فتح قفل للجهاز، ولهذا الجهاز فقط — لا تُنقل إلى iCloud Keychain ولا إلى جهاز آخر عبر النسخ الاحتياطي.
@objc(LawKeychainPlugin)
public class LawKeychainPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LawKeychainPlugin"
    public let jsName = "LawKeychain"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]
    private let service = "sa.lawoffice.secrets"

    private func baseQuery(_ key: String) -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("key required") }
        var q = baseQuery(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return call.resolve(["value": NSNull()]) }
        guard status == errSecSuccess, let data = out as? Data, let s = String(data: data, encoding: .utf8) else {
            return call.reject("keychain read failed: \(status)")
        }
        call.resolve(["value": s])
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else { return call.reject("key and value required") }
        let data = Data(value.utf8)
        let q = baseQuery(key)
        let attrs: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        var status = SecItemUpdate(q as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            var add = q
            add.merge(attrs) { _, new in new }
            status = SecItemAdd(add as CFDictionary, nil)
        }
        if status != errSecSuccess { return call.reject("keychain write failed: \(status)") }
        call.resolve()
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("key required") }
        let status = SecItemDelete(baseQuery(key) as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound { return call.reject("keychain delete failed: \(status)") }
        call.resolve()
    }
}
