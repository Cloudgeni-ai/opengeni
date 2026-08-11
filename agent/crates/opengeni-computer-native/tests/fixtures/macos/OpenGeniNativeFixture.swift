import AppKit
import SwiftUI

final class SwiftFixtureModel: ObservableObject {
    @Published var input = ""
    @Published var status = "SwiftUI idle"
}

struct SwiftFixturePanel: View {
    @ObservedObject var model: SwiftFixtureModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("SwiftUI controls")
                .font(.headline)
            TextField("SwiftUI input", text: $model.input)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("fixture-swiftui-input")
            Button("Apply SwiftUI") {
                model.status = "SwiftUI button invoked"
            }
            .accessibilityIdentifier("fixture-swiftui-apply")
            Text(model.status)
                .accessibilityIdentifier("fixture-swiftui-status")
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

final class FixtureCanvas: NSView {
    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        NSColor(calibratedRed: 0.93, green: 0.12, blue: 0.56, alpha: 1).setFill()
        NSBezierPath(rect: NSRect(x: 18, y: 18, width: 170, height: 64)).fill()
        NSColor(calibratedRed: 0.05, green: 0.78, blue: 0.88, alpha: 1).setFill()
        NSBezierPath(ovalIn: NSRect(x: 220, y: 12, width: 86, height: 86)).fill()
    }
}

final class FixtureAppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var modal: NSWindow?
    private let appKitInput = NSTextField(string: "")
    private let appKitStatus = NSTextField(labelWithString: "AppKit idle")
    private let swiftModel = SwiftFixtureModel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(
            contentRect: NSRect(x: 180, y: 140, width: 720, height: 650),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "OpenGeni Native Fixture"
        window.setFrameAutosaveName("OpenGeniNativeFixtureWindow")

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 14, left: 16, bottom: 14, right: 16)
        stack.translatesAutoresizingMaskIntoConstraints = false

        let heading = NSTextField(labelWithString: "OpenGeni macOS native fixture")
        heading.font = NSFont.boldSystemFont(ofSize: 18)
        heading.setAccessibilityIdentifier("fixture-heading")
        stack.addArrangedSubview(heading)

        appKitInput.placeholderString = "AppKit input"
        appKitInput.setAccessibilityIdentifier("fixture-appkit-input")
        appKitInput.widthAnchor.constraint(equalToConstant: 430).isActive = true
        stack.addArrangedSubview(appKitInput)

        let buttonRow = NSStackView()
        buttonRow.orientation = .horizontal
        buttonRow.spacing = 8
        buttonRow.addArrangedSubview(button("Apply AppKit", "fixture-appkit-apply", #selector(applyAppKit)))
        buttonRow.addArrangedSubview(button("Open Modal", "fixture-open-modal", #selector(openModal)))
        buttonRow.addArrangedSubview(button("Hang Briefly", "fixture-hang", #selector(hangBriefly)))
        stack.addArrangedSubview(buttonRow)

        appKitStatus.setAccessibilityIdentifier("fixture-appkit-status")
        stack.addArrangedSubview(appKitStatus)

        let separator = NSBox()
        separator.boxType = .separator
        separator.widthAnchor.constraint(equalToConstant: 675).isActive = true
        stack.addArrangedSubview(separator)

        let hosting = NSHostingView(rootView: SwiftFixturePanel(model: swiftModel))
        hosting.setAccessibilityIdentifier("fixture-swiftui-panel")
        hosting.widthAnchor.constraint(equalToConstant: 675).isActive = true
        hosting.heightAnchor.constraint(equalToConstant: 190).isActive = true
        stack.addArrangedSubview(hosting)

        let canvasLabel = NSTextField(labelWithString: "Visual-only custom canvas")
        canvasLabel.setAccessibilityIdentifier("fixture-canvas-label")
        stack.addArrangedSubview(canvasLabel)

        let canvas = FixtureCanvas()
        canvas.setAccessibilityElement(true)
        canvas.setAccessibilityRole(.group)
        canvas.setAccessibilityLabel("Visual-only fixture canvas")
        canvas.setAccessibilityIdentifier("fixture-canvas")
        canvas.widthAnchor.constraint(equalToConstant: 675).isActive = true
        canvas.heightAnchor.constraint(equalToConstant: 112).isActive = true
        stack.addArrangedSubview(canvas)

        let content = NSView()
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor),
        ])
        window.contentView = content
        window.orderFront(nil)

        if CommandLine.arguments.count > 1 {
            FileManager.default.createFile(
                atPath: CommandLine.arguments[1],
                contents: Data("ready".utf8)
            )
        }
    }

    private func button(_ title: String, _ identifier: String, _ action: Selector) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.bezelStyle = .rounded
        button.setAccessibilityIdentifier(identifier)
        return button
    }

    @objc private func applyAppKit() {
        appKitStatus.stringValue = "AppKit applied: \(appKitInput.stringValue)"
    }

    @objc private func openModal() {
        guard modal == nil else { return }
        let sheet = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 390, height: 180),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        sheet.title = "OpenGeni Fixture Modal"
        let panel = NSStackView()
        panel.orientation = .vertical
        panel.alignment = .centerX
        panel.spacing = 16
        panel.edgeInsets = NSEdgeInsets(top: 26, left: 24, bottom: 24, right: 24)
        panel.translatesAutoresizingMaskIntoConstraints = false
        let question = NSTextField(labelWithString: "Fixture modal question")
        question.setAccessibilityIdentifier("fixture-modal-question")
        panel.addArrangedSubview(question)
        panel.addArrangedSubview(button("Close Modal", "fixture-close-modal", #selector(closeModal)))
        let content = NSView()
        content.addSubview(panel)
        NSLayoutConstraint.activate([
            panel.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            panel.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            panel.topAnchor.constraint(equalTo: content.topAnchor),
        ])
        sheet.contentView = content
        modal = sheet
        window.beginSheet(sheet)
    }

    @objc private func closeModal() {
        guard let modal else { return }
        window.endSheet(modal)
        self.modal = nil
    }

    @objc private func hangBriefly() {
        appKitStatus.stringValue = "AppKit hanging"
        appKitStatus.displayIfNeeded()
        Thread.sleep(forTimeInterval: 2.0)
        appKitStatus.stringValue = "AppKit recovered"
    }
}

let application = NSApplication.shared
let delegate = FixtureAppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
