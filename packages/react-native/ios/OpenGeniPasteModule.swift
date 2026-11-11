import ExpoModulesCore
import ObjectiveC
import UIKit

/// Image paste for composer text fields. React Native's iOS text views only
/// paste text; a field whose accessibility identifier (its React Native test
/// id) starts with `opengeni-composer-input` also offers Paste for images and
/// hands them to JavaScript as temporary JPEG files. Other text fields in the
/// host app are untouched.
public class OpenGeniPasteModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OpenGeniPaste")

    Events("onPasteImages")

    OnCreate {
      DispatchQueue.main.async { OpenGeniImagePaste.shared.install() }
    }

    OnStartObserving {
      OpenGeniImagePaste.shared.emit = { [weak self] event in
        self?.sendEvent("onPasteImages", event)
      }
    }

    OnStopObserving {
      OpenGeniImagePaste.shared.emit = nil
    }
  }
}

final class OpenGeniImagePaste {
  static let shared = OpenGeniImagePaste()
  static let inputPrefix = "opengeni-composer-input"

  var emit: (([String: Any]) -> Void)?
  private var installed = false

  /// Swizzles the React Native text views once (both architectures' classes).
  func install() {
    guard !installed else { return }
    installed = true
    for name in ["RCTUITextView", "RCTUITextField"] {
      if let cls = NSClassFromString(name) { swizzle(cls) }
    }
  }

  /// The composer input id this view belongs to, if any: the id sits on the
  /// text view or on its component view a few levels up.
  func inputId(for view: UIView) -> String? {
    guard emit != nil else { return nil }
    var current: UIView? = view
    for _ in 0..<4 {
      if let id = current?.accessibilityIdentifier, id.hasPrefix(Self.inputPrefix) { return id }
      current = current?.superview
    }
    return nil
  }

  /// Writes the pasteboard's images to temporary files and reports them.
  func deliver(to inputId: String) -> Bool {
    guard let images = UIPasteboard.general.images, !images.isEmpty else { return false }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "opengeni-paste", isDirectory: true)
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var files: [[String: Any]] = []
    for (index, image) in images.enumerated() {
      guard let data = image.jpegData(compressionQuality: 0.9) else { continue }
      let url = directory.appendingPathComponent("\(UUID().uuidString).jpg")
      do {
        try data.write(to: url, options: .atomic)
      } catch {
        continue
      }
      let name = images.count > 1 ? "Pasted image \(index + 1).jpg" : "Pasted image.jpg"
      files.append([
        "uri": url.absoluteString, "name": name, "mimeType": "image/jpeg", "size": data.count,
      ])
    }
    guard !files.isEmpty, let emit else { return false }
    emit(["inputId": inputId, "files": files])
    return true
  }

  private func swizzle(_ cls: AnyClass) {
    let canPerform = #selector(UIResponder.canPerformAction(_:withSender:))
    let paste = #selector(UIResponderStandardEditActions.paste(_:))

    if let method = class_getInstanceMethod(cls, canPerform) {
      typealias CanPerform = @convention(c) (AnyObject, Selector, Selector, Any?) -> Bool
      let original = unsafeBitCast(method_getImplementation(method), to: CanPerform.self)
      let block: @convention(block) (AnyObject, Selector, Any?) -> Bool = { target, action, sender in
        if action == paste, let view = target as? UIView,
          OpenGeniImagePaste.shared.inputId(for: view) != nil, UIPasteboard.general.hasImages
        {
          return true
        }
        return original(target, canPerform, action, sender)
      }
      replace(cls, canPerform, method, imp_implementationWithBlock(block))
    }

    if let method = class_getInstanceMethod(cls, paste) {
      typealias Paste = @convention(c) (AnyObject, Selector, Any?) -> Void
      let original = unsafeBitCast(method_getImplementation(method), to: Paste.self)
      let block: @convention(block) (AnyObject, Any?) -> Void = { target, sender in
        // An image on the pasteboard becomes an attachment; the text that often
        // rides along with it (a page URL) is not typed into the message.
        if let view = target as? UIView, let id = OpenGeniImagePaste.shared.inputId(for: view),
          UIPasteboard.general.hasImages, OpenGeniImagePaste.shared.deliver(to: id)
        {
          return
        }
        original(target, paste, sender)
      }
      replace(cls, paste, method, imp_implementationWithBlock(block))
    }
  }

  /// Overrides on this class only: adds the method when it is inherited,
  /// replaces it when the class defines it.
  private func replace(_ cls: AnyClass, _ selector: Selector, _ method: Method, _ imp: IMP) {
    if !class_addMethod(cls, selector, imp, method_getTypeEncoding(method)) {
      method_setImplementation(method, imp)
    }
  }
}
