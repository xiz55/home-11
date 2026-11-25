import Foundation
import UIKit
import WebKit
import Capacitor

/// الطباعة (AirPrint) وتحويل HTML التقارير إلى PDF مقسّم صفحات A4 — على الجهاز نفسه دون أي خدمة خارجية.
@objc(LawPrintPlugin)
public class LawPrintPlugin: CAPPlugin, CAPBridgedPlugin, WKNavigationDelegate {
    public let identifier = "LawPrintPlugin"
    public let jsName = "LawPrint"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "print", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pdf", returnType: CAPPluginReturnPromise)
    ]

    private var webView: WKWebView?
    private var onLoaded: ((WKWebView) -> Void)?

    private func render(html: String, then: @escaping (WKWebView) -> Void) {
        DispatchQueue.main.async {
            let cfg = WKWebViewConfiguration()
            // محتوى التقرير ثابت: لا شبكة ولا سكربتات
            cfg.defaultWebpagePreferences.allowsContentJavaScript = false
            let wv = WKWebView(frame: CGRect(x: 0, y: 0, width: 794, height: 1123), configuration: cfg)
            wv.navigationDelegate = self
            self.webView = wv
            self.onLoaded = then
            wv.loadHTMLString(html, baseURL: nil)
        }
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // مهلة قصيرة لاكتمال تحميل الخطوط المضمّنة
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            let cb = self.onLoaded
            self.onLoaded = nil
            cb?(webView)
        }
    }

    @objc func print(_ call: CAPPluginCall) {
        guard let html = call.getString("html") else { return call.reject("html required") }
        let jobName = call.getString("jobName") ?? "Report"
        render(html: html) { wv in
            let info = UIPrintInfo(dictionary: nil)
            info.outputType = .general
            info.jobName = jobName
            let pc = UIPrintInteractionController.shared
            pc.printInfo = info
            pc.printFormatter = wv.viewPrintFormatter()
            pc.present(animated: true) { _, completed, error in
                self.webView = nil
                if let error = error { call.reject(error.localizedDescription) } else { call.resolve(["completed": completed]) }
            }
        }
    }

    @objc func pdf(_ call: CAPPluginCall) {
        guard let html = call.getString("html") else { return call.reject("html required") }
        let landscape = call.getBool("landscape") ?? false
        render(html: html) { wv in
            let a4 = CGSize(width: 595.2, height: 841.8)
            let size = landscape ? CGSize(width: a4.height, height: a4.width) : a4
            let paper = CGRect(origin: .zero, size: size)
            let printable = paper.insetBy(dx: 28, dy: 28)
            let renderer = UIPrintPageRenderer()
            renderer.addPrintFormatter(wv.viewPrintFormatter(), startingAtPageAt: 0)
            renderer.setValue(NSValue(cgRect: paper), forKey: "paperRect")
            renderer.setValue(NSValue(cgRect: printable), forKey: "printableRect")
            let data = NSMutableData()
            UIGraphicsBeginPDFContextToData(data, paper, nil)
            renderer.prepare(forDrawingPages: NSRange(location: 0, length: renderer.numberOfPages))
            let bounds = UIGraphicsGetPDFContextBounds()
            for i in 0..<renderer.numberOfPages {
                UIGraphicsBeginPDFPage()
                renderer.drawPage(at: i, in: bounds)
            }
            UIGraphicsEndPDFContext()
            self.webView = nil
            call.resolve(["base64": data.base64EncodedString()])
        }
    }
}
