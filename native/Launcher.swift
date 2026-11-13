import Cocoa
import WebKit

final class WorkbenchDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var process: Process?
    let origin = URL(string: "http://127.0.0.1:43828")!
    var downloadLocations: [ObjectIdentifier: URL] = [:]

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        let menu = NSMenu(), item = NSMenuItem(), editItem = NSMenuItem()
        let appMenu = NSMenu(); appMenu.addItem(withTitle: "退出拾句工作台", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"); item.submenu = appMenu; menu.addItem(item)
        let edit = NSMenu(title: "编辑")
        for (title, action, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        editItem.submenu = edit; menu.addItem(editItem); NSApp.mainMenu = menu
        let reloadItem = edit.addItem(withTitle: "重新载入工作台", action: #selector(reloadWorkbench), keyEquivalent: "r"); reloadItem.target = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 900), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "拾句 · 视频与文案工作台"; window.minSize = NSSize(width: 820, height: 650); window.center(); window.delegate = self
        let config = WKWebViewConfiguration(); config.preferences.javaScriptCanOpenWindowsAutomatically = false
        web = WKWebView(frame: window.contentView!.bounds, configuration: config); web.autoresizingMask = [.width, .height]; web.navigationDelegate = self; web.uiDelegate = self
        window.contentView?.addSubview(web); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        web.loadHTMLString("<html><body style='background:#f5f6ef;color:#456044;font:16px -apple-system;text-align:center;padding-top:32vh'>正在打开拾句工作台…</body></html>", baseURL: nil)
        check(remaining: 0) { [weak self] ready in if ready { self?.show() } else { self?.start() } }
    }
    func check(remaining: Int, completion: @escaping (Bool) -> Void) {
        var request = URLRequest(url: origin.appendingPathComponent("api/health")); request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            let ready = (response as? HTTPURLResponse)?.statusCode == 200 && data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["app"] as? String == "shiju-workbench"
            DispatchQueue.main.async {
                if ready || remaining == 0 { completion(ready) }
                else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self?.check(remaining: remaining - 1, completion: completion) } }
            }
        }.resume()
    }
    func show() { web.load(URLRequest(url: URL(string: "/#/media", relativeTo: origin)!)) }
    @objc func reloadWorkbench() { web.reload() }
    func start() {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let agent = home.appendingPathComponent("Library/LaunchAgents/local.shiju.copy-workbench.plist")
        if FileManager.default.fileExists(atPath: agent.path) {
            let task = Process(); task.executableURL = URL(fileURLWithPath: "/bin/launchctl"); task.arguments = ["kickstart", "gui/\(getuid())/local.shiju.copy-workbench"]
            try? task.run()
        } else {
            guard let resources = Bundle.main.resourceURL else { return }
            let support = home.appendingPathComponent("Library/Application Support/拾句工作台")
            try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
            let task = Process(); task.executableURL = resources.appendingPathComponent("node"); task.arguments = [resources.appendingPathComponent("app/server.mjs").path]; task.currentDirectoryURL = resources.appendingPathComponent("app")
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = home.appendingPathComponent(".local/bin").path + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            env["SHIJU_DATA_DIR"] = support.appendingPathComponent("data").path
            let cli = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
            if FileManager.default.fileExists(atPath: cli) { env["CODEX_CLI"] = cli }
            task.environment = env
            let log = support.appendingPathComponent("app.log"); FileManager.default.createFile(atPath: log.path, contents: nil)
            task.standardOutput = try? FileHandle(forWritingTo: log); task.standardError = task.standardOutput
            process = task; do { try task.run() } catch { showError(error.localizedDescription); return }
        }
        check(remaining: 35) { [weak self] ready in if ready { self?.show() } else { self?.showError("本机工作台暂时未能启动。现有数据仍保留，请重新打开应用。") } }
    }
    func showError(_ text: String) { let alert = NSAlert(); alert.messageText = "暂时无法打开工作台"; alert.informativeText = text; alert.runModal() }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.host == "127.0.0.1" || url.scheme == "about" { decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow) }
        else { if navigationAction.navigationType == .linkActivated && ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }; decisionHandler(.cancel) }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }; return nil
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let attachment = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.contains("attachment") ?? false
        decisionHandler(attachment || !navigationResponse.canShowMIMEType ? .download : .allow)
    }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let folder = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads")
        let name = (suggestedFilename as NSString).lastPathComponent
        var file = folder.appendingPathComponent(name); var count = 2
        while FileManager.default.fileExists(atPath: file.path) { let base = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension; file = folder.appendingPathComponent("\(base) (\(count))\(ext.isEmpty ? "" : "." + ext)"); count += 1 }
        downloadLocations[ObjectIdentifier(download)] = file; completionHandler(file)
    }
    func downloadDidFinish(_ download: WKDownload) { if let url = downloadLocations.removeValue(forKey: ObjectIdentifier(download)) { NSWorkspace.shared.activateFileViewerSelecting([url]) } }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) { downloadLocations.removeValue(forKey: ObjectIdentifier(download)); showError("文稿下载失败：" + error.localizedDescription) }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) { process?.terminate() }
}
let delegate = WorkbenchDelegate()
NSApplication.shared.delegate = delegate
NSApplication.shared.run()
