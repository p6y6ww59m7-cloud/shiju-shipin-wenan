import Cocoa
import WebKit

class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process?
    var output = Data()
    var started = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        let menu = NSMenu()
        let appMenu = NSMenuItem(); menu.addItem(appMenu)
        let sub = NSMenu(); sub.addItem(withTitle: "退出视频导出助手", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"); appMenu.submenu = sub
        let editMenu = NSMenuItem(); menu.addItem(editMenu)
        let edit = NSMenu(title: "编辑")
        edit.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(NSMenuItem.separator())
        edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenu.submenu = edit; NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1080, height: 850), styleMask: [.titled,.closable,.miniaturizable,.resizable], backing: .buffered, defer: false)
        window.title = "视频导出助手 · 多平台版"; window.minSize = NSSize(width: 740, height: 650); window.center(); window.delegate = self
        let config = WKWebViewConfiguration()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        web = WKWebView(frame: window.contentView!.bounds, configuration: config)
        web.autoresizingMask = [.width, .height]; web.navigationDelegate = self
        window.contentView?.addSubview(web)
        web.loadHTMLString("<html><body style='background:#f4f6f5;color:#526b58;font:15px -apple-system;text-align:center;padding-top:28vh'>正在打开视频导出助手…</body></html>", baseURL: nil)
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        startServer()
    }

    func startServer() {
        guard let resources = Bundle.main.resourceURL else { return }
        let process = Process(); server = process
        process.executableURL = resources.appendingPathComponent("node")
        process.arguments = [resources.appendingPathComponent("app/server.mjs").path]
        process.currentDirectoryURL = resources.appendingPathComponent("app")
        let stdout = Pipe(); process.standardOutput = stdout
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("抖音视频导出助手")
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        let logURL = support.appendingPathComponent("app.log")
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        process.standardError = try? FileHandle(forWritingTo: logURL)
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { return }
            DispatchQueue.main.async {
                guard let self = self, !self.started else { return }
                self.output.append(chunk)
                if let text = String(data: self.output, encoding: .utf8), let line = text.split(separator: "\n").first,
                   let data = String(line).data(using: .utf8), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let address = json["url"] as? String, let url = URL(string: address) {
                    self.started = true; self.web.load(URLRequest(url: url))
                }
            }
        }
        do { try process.run() } catch { showError("未能启动本地服务：\(error.localizedDescription)") }
        DispatchQueue.main.asyncAfter(deadline: .now()+15) { [weak self] in
            if let self = self, !self.started { self.showError("本地服务启动失败。请关闭应用后重新打开。") }
        }
    }
    func showError(_ text: String) {
        let alert = NSAlert(); alert.messageText = "暂时无法打开"; alert.informativeText = text; alert.runModal()
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let u = navigationAction.request.url else { decisionHandler(.cancel); return }
        if u.host == "127.0.0.1" || u.scheme == "about" { decisionHandler(.allow) } else { decisionHandler(.cancel) }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) { server?.terminate() }
}
let delegate = AppDelegate()
NSApplication.shared.delegate = delegate
NSApplication.shared.run()
