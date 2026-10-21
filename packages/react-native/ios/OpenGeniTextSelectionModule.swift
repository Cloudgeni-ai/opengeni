import ExpoModulesCore
import ObjectiveC
import UIKit

/// Native text selection for timeline messages. React Native's selectable
/// Text on iOS only offers Copy for the whole paragraph. Inside a view whose
/// accessibility identifier (its React Native test id) starts with
/// `og-annotation-source:`, a long press instead selects the word under the
/// finger with the system selection handles and edit menu, so any part of the
/// paragraph can be selected, copied, looked up or shared. When JavaScript
/// listens and the identifier names a source, the menu also offers Add note,
/// which reports the selected text and its surroundings.
public class OpenGeniTextSelectionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OpenGeniTextSelection")

    Events("onAnnotate")

    OnCreate {
      DispatchQueue.main.async { OpenGeniTextSelection.shared.install() }
    }

    OnStartObserving {
      OpenGeniTextSelection.shared.emit = { [weak self] event in
        self?.sendEvent("onAnnotate", event)
      }
    }

    OnStopObserving {
      OpenGeniTextSelection.shared.emit = nil
    }

    /// The Add note title, localized by JavaScript; nil hides Add note.
    Function("setAnnotateTitle") { (title: String?) in
      DispatchQueue.main.async { OpenGeniTextSelection.shared.annotateTitle = title }
    }

    /// Where each draft quote is drawn inside a source, in the source view's
    /// coordinates: `{ x, top, rects }`, the end of its last glyph, the top of
    /// that line's text and one text box per line (flattened x, y, width,
    /// height), or an empty object when the quote is not drawn there. Each
    /// query is `{ quote, before, after }`; the surrounding text picks between
    /// repeated occurrences.
    AsyncFunction("quoteAnchors") { (sourceKey: String, queries: [[String: String]]) -> [[String: Any]] in
      OpenGeniTextSelection.shared.quoteAnchors(sourceKey: sourceKey, queries: queries)
    }.runOnQueue(.main)
  }
}

final class OpenGeniTextSelection: NSObject {
  static let shared = OpenGeniTextSelection()
  static let sourcePrefix = "og-annotation-source:"

  var emit: (([String: Any]) -> Void)?
  var annotateTitle: String?
  private var installed = false
  private weak var active: OpenGeniSelectionTextView?

  /// Swizzles the Fabric paragraph's long-press handler once.
  func install() {
    guard !installed, let cls = NSClassFromString("RCTParagraphComponentView") else { return }
    installed = true
    let selector = NSSelectorFromString("handleLongPress:")
    guard let method = class_getInstanceMethod(cls, selector) else { return }
    typealias Handler = @convention(c) (AnyObject, Selector, AnyObject) -> Void
    let original = unsafeBitCast(method_getImplementation(method), to: Handler.self)
    let block: @convention(block) (AnyObject, AnyObject) -> Void = { target, gesture in
      if let view = target as? UIView, let press = gesture as? UILongPressGestureRecognizer,
        OpenGeniTextSelection.shared.handle(press, on: view)
      {
        return
      }
      original(target, selector, gesture)
    }
    method_setImplementation(method, imp_implementationWithBlock(block))
  }

  /// The source marker this paragraph sits in: nil when the paragraph is not
  /// inside a timeline message, "" for a message that cannot be annotated.
  private func sourceKey(for view: UIView) -> String? {
    var current: UIView? = view
    while let candidate = current {
      if let id = candidate.accessibilityIdentifier, id.hasPrefix(Self.sourcePrefix) {
        return String(id.dropFirst(Self.sourcePrefix.count))
      }
      current = candidate.superview
    }
    return nil
  }

  /// Starts a selection for a long press; false leaves it to React Native.
  private func handle(_ press: UILongPressGestureRecognizer, on paragraph: UIView) -> Bool {
    guard let key = sourceKey(for: paragraph) else { return false }
    // The press keeps reporting changes while the finger stays down; its
    // start opens a selection and lifting the finger shows the edit menu, as
    // in any iOS text view.
    if press.state == .ended {
      if let current = active, current.paragraph === paragraph { current.showMenu() }
      return true
    }
    guard press.state == .began else { return true }
    if let current = active, current.paragraph === paragraph { return true }
    active?.dismiss()
    guard
      let text = Self.attributedText(of: paragraph), text.length > 0,
      let frame = Self.textFrame(of: paragraph), frame.width > 0, frame.height > 0
    else { return false }
    let overlay = OpenGeniSelectionTextView(
      paragraph: paragraph, text: text, frame: frame, sourceKey: key)
    paragraph.addSubview(overlay)
    active = overlay
    overlay.begin(at: press.location(in: overlay))
    return true
  }

  static func attributedText(of paragraph: UIView) -> NSAttributedString? {
    guard paragraph.responds(to: NSSelectorFromString("attributedText")) else { return nil }
    return paragraph.value(forKey: "attributedText") as? NSAttributedString
  }

  /// Where React Native draws the paragraph's text, in its own coordinates:
  /// the drawing frame of its content view where React Native exposes one,
  /// else the content view's bounds (text without padding or borders).
  private static func textFrame(of paragraph: UIView) -> CGRect? {
    guard paragraph.responds(to: NSSelectorFromString("contentView")),
      let content = paragraph.value(forKey: "contentView") as? UIView
    else { return nil }
    if content.responds(to: NSSelectorFromString("drawingFrame")),
      let drawing = (content.value(forKey: "drawingFrame") as? NSValue)?.cgRectValue
    {
      return drawing.offsetBy(dx: content.frame.minX, dy: content.frame.minY)
    }
    return content.frame
  }

  func annotate(key: String, quote: String, before: String, after: String) {
    emit?(["sourceKey": key, "quote": quote, "before": before, "after": after])
  }

  var canAnnotate: Bool { emit != nil && annotateTitle != nil }

  // MARK: Quote anchors

  func quoteAnchors(sourceKey: String, queries: [[String: String]]) -> [[String: Any]] {
    let none = queries.map { _ in [String: Any]() }
    guard let source = Self.sourceView(identifier: Self.sourcePrefix + sourceKey) else { return none }
    let paragraphs = Self.paragraphs(in: source).compactMap { paragraph -> MeasuredParagraph? in
      guard let text = Self.attributedText(of: paragraph), text.length > 0,
        let frame = Self.textFrame(of: paragraph), frame.width > 0, frame.height > 0
      else { return nil }
      return MeasuredParagraph(view: paragraph, text: text, frame: frame)
    }
    return queries.map { query in
      guard let quote = query["quote"].map(Self.trimmedQuote), !quote.isEmpty else { return [:] }
      var best: (paragraph: MeasuredParagraph, range: NSRange, score: Int)?
      for paragraph in paragraphs {
        let string = paragraph.text.string as NSString
        var search = NSRange(location: 0, length: string.length)
        while search.length > 0 {
          let found = string.range(of: quote, options: [], range: search)
          if found.location == NSNotFound { break }
          let score =
            Self.commonSuffix(string.substring(to: found.location), query["before"] ?? "")
            + Self.commonPrefix(string.substring(from: NSMaxRange(found)), query["after"] ?? "")
          if best == nil || score > best!.score { best = (paragraph, found, score) }
          let next = found.location + 1
          search = NSRange(location: next, length: string.length - next)
        }
      }
      guard let best else { return [:] }
      return best.paragraph.anchor(for: best.range, in: source) ?? [:]
    }
  }

  /// A quote's visible text: surrounding whitespace has no glyph to anchor to.
  private static func trimmedQuote(_ quote: String) -> String {
    quote.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private static func commonSuffix(_ a: String, _ b: String) -> Int {
    zip(a.reversed(), b.reversed()).prefix { $0 == $1 }.count
  }

  private static func commonPrefix(_ a: String, _ b: String) -> Int {
    zip(a, b).prefix { $0 == $1 }.count
  }

  private static func sourceView(identifier: String) -> UIView? {
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
    for window in windows {
      if let view = find(in: window, where: { $0.accessibilityIdentifier == identifier }) {
        return view
      }
    }
    return nil
  }

  private static func find(in view: UIView, where match: (UIView) -> Bool) -> UIView? {
    if match(view) { return view }
    for child in view.subviews {
      if let found = find(in: child, where: match) { return found }
    }
    return nil
  }

  /// The paragraphs drawn inside a source, in document order.
  private static func paragraphs(in view: UIView) -> [UIView] {
    guard let cls = NSClassFromString("RCTParagraphComponentView") else { return [] }
    var found: [UIView] = []
    func walk(_ current: UIView) {
      if current.isHidden { return }
      if current.isKind(of: cls) {
        found.append(current)
        return
      }
      current.subviews.forEach(walk)
    }
    walk(view)
    return found
  }
}

/// A paragraph laid out the way React Native drew it, for measuring.
private struct MeasuredParagraph {
  let view: UIView
  let text: NSAttributedString
  let frame: CGRect

  func anchor(for range: NSRange, in source: UIView) -> [String: Any]? {
    let end = NSMaxRange(range)
    guard range.length > 0 else { return nil }
    let layout = OpenGeniTextLayout(text: text, size: frame.size)
    let manager = layout.manager
    let storage = layout.storage
    let glyphs = manager.glyphRange(
      forCharacterRange: NSRange(location: end - 1, length: 1), actualCharacterRange: nil)
    guard glyphs.length > 0 else { return nil }
    let box = manager.boundingRect(forGlyphRange: glyphs, in: layout.container)
    let (top, _) = textBox(glyph: glyphs.location, manager: manager, storage: storage)
    let point = convert(CGPoint(x: box.maxX, y: top), to: source)
    // One box per line, from the top of its text to the bottom of its descenders.
    var rects: [Double] = []
    let all = manager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
    manager.enumerateLineFragments(forGlyphRange: all) { _, _, _, lineGlyphs, _ in
      let part = NSIntersectionRange(all, lineGlyphs)
      guard part.length > 0 else { return }
      let bounds = manager.boundingRect(forGlyphRange: part, in: layout.container)
      let (lineTop, lineBottom) = self.textBox(
        glyph: part.location, manager: manager, storage: storage)
      let origin = self.convert(CGPoint(x: bounds.minX, y: lineTop), to: source)
      rects += [
        Double(origin.x), Double(origin.y), Double(bounds.width), Double(lineBottom - lineTop),
      ]
    }
    return ["x": Double(point.x), "top": Double(point.y), "rects": rects]
  }

  /// The top of the text and the bottom of its descenders on a glyph's line.
  /// The glyph location already includes the baseline offset.
  private func textBox(glyph: Int, manager: NSLayoutManager, storage: NSTextStorage)
    -> (CGFloat, CGFloat)
  {
    let line = manager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
    let baseline = line.minY + manager.location(forGlyphAt: glyph).y
    let character = manager.characterIndexForGlyph(at: glyph)
    let font = storage.attribute(.font, at: character, effectiveRange: nil) as? UIFont
    let ascender = font?.ascender ?? line.height * 0.75
    let descender = font?.descender ?? -line.height * 0.25
    return (baseline - ascender, baseline - descender)
  }

  private func convert(_ point: CGPoint, to source: UIView) -> CGPoint {
    view.convert(CGPoint(x: frame.minX + point.x, y: frame.minY + point.y), to: source)
  }
}

/// TextKit 1 laid out like React Native lays out a paragraph: the same
/// attributed string, no line fragment padding, no font leading, clipping line
/// breaks and React Native's draw-time baseline offset.
final class OpenGeniTextLayout {
  let storage: NSTextStorage
  let manager: NSLayoutManager
  let container: NSTextContainer

  init(text: NSAttributedString, size: CGSize) {
    storage = NSTextStorage(attributedString: Self.invisibleCopy(of: text))
    manager = NSLayoutManager()
    manager.usesFontLeading = false
    storage.addLayoutManager(manager)
    container = NSTextContainer(size: size)
    container.lineFragmentPadding = 0
    container.lineBreakMode = .byClipping
    container.widthTracksTextView = false
    container.heightTracksTextView = false
    manager.addTextContainer(container)
  }

  /// React Native draws the text; this copy only carries layout, so every
  /// drawn attribute is cleared. The baseline offset React Native applies at
  /// draw time is applied here too (RCTApplyBaselineOffset).
  static func invisibleCopy(of text: NSAttributedString) -> NSAttributedString {
    let copy = NSMutableAttributedString(attributedString: text)
    let all = NSRange(location: 0, length: copy.length)
    for key: NSAttributedString.Key in [
      .backgroundColor, .underlineStyle, .strikethroughStyle, .link, .shadow, .strokeColor,
    ] {
      copy.removeAttribute(key, range: all)
    }
    copy.addAttribute(.foregroundColor, value: UIColor.clear, range: all)
    var maximumLineHeight: CGFloat = 0
    copy.enumerateAttribute(.paragraphStyle, in: all) { value, _, _ in
      if let style = value as? NSParagraphStyle {
        maximumLineHeight = max(maximumLineHeight, style.maximumLineHeight)
      }
    }
    guard maximumLineHeight > 0 else { return copy }
    var maximumFontLineHeight: CGFloat = 0
    copy.enumerateAttribute(.font, in: all) { value, _, _ in
      if let font = value as? UIFont {
        maximumFontLineHeight = max(maximumFontLineHeight, font.lineHeight)
      }
    }
    guard maximumLineHeight >= maximumFontLineHeight else { return copy }
    copy.addAttribute(
      .baselineOffset, value: (maximumLineHeight - maximumFontLineHeight) / 2, range: all)
    return copy
  }
}

/// A transparent TextKit 1 text view laid out exactly like React Native lays
/// out the paragraph underneath (same attributed string, line fragment padding,
/// font leading and baseline offset), so the selection highlight and handles
/// sit on the glyphs React Native drew. It exists only while a selection does.
final class OpenGeniSelectionTextView: UITextView, UITextViewDelegate, UIGestureRecognizerDelegate {
  weak var paragraph: UIView?
  private let layout: OpenGeniTextLayout
  private var storage: NSTextStorage { layout.storage }
  private let sourceKey: String
  private let snapshot: String
  private var outsideTap: UITapGestureRecognizer?
  private var watcher: Timer?
  private var dismissed = false
  /// Presents the menu after the long press. The text view's own edit menu
  /// is private and only appears for its own gestures (dragging a handle).
  private var editMenu: AnyObject?

  init(paragraph: UIView, text: NSAttributedString, frame: CGRect, sourceKey: String) {
    self.paragraph = paragraph
    self.sourceKey = sourceKey
    snapshot = text.string
    layout = OpenGeniTextLayout(text: text, size: frame.size)
    super.init(frame: frame, textContainer: layout.container)
    backgroundColor = .clear
    isEditable = false
    isSelectable = true
    isScrollEnabled = false
    textContainerInset = .zero
    dataDetectorTypes = []
    clipsToBounds = false
    delegate = self
    accessibilityElementsHidden = true
    if #available(iOS 16.0, *) {
      let interaction = UIEditMenuInteraction(delegate: self)
      addInteraction(interaction)
      editMenu = interaction
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  /// Selects the word at `point`; the edit menu follows when the finger lifts.
  func begin(at point: CGPoint) {
    _ = becomeFirstResponder()
    selectedRange = wordRange(at: point)
    installOutsideTap()
    // A streaming message or a recycled view changes the text underneath;
    // the selection then no longer matches what is drawn.
    watcher = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: true) { [weak self] _ in
      guard let self else { return }
      let current = self.paragraph.flatMap(OpenGeniTextSelection.attributedText(of:))?.string
      if self.window == nil || current != self.snapshot { self.dismiss() }
    }
  }

  private func wordRange(at point: CGPoint) -> NSRange {
    let string = storage.string as NSString
    guard string.length > 0 else { return NSRange(location: 0, length: 0) }
    var fraction: CGFloat = 0
    let index = min(
      layoutManager.characterIndex(
        for: point, in: textContainer, fractionOfDistanceBetweenInsertionPoints: &fraction),
      string.length - 1)
    var found: NSRange?
    var nearest: NSRange?
    string.enumerateSubstrings(
      in: NSRange(location: 0, length: string.length), options: .byWords
    ) { _, range, _, stop in
      if NSLocationInRange(index, range) {
        found = range
        stop.pointee = true
        return
      }
      if range.location > index {
        if nearest == nil { nearest = range }
        stop.pointee = true
        return
      }
      nearest = range
    }
    if let range = found ?? nearest { return range }
    return NSRange(location: 0, length: string.length)
  }

  func showMenu() {
    guard !dismissed, selectedRange.length > 0, let range = selectedTextRange else { return }
    let rect = firstRect(for: range)
    if #available(iOS 16.0, *), let interaction = editMenu as? UIEditMenuInteraction {
      let configuration = UIEditMenuConfiguration(
        identifier: nil, sourcePoint: CGPoint(x: rect.midX, y: rect.minY))
      // Above the selection, like the system text views, unless it lacks room.
      configuration.preferredArrowDirection = .down
      interaction.presentEditMenu(with: configuration)
    } else {
      UIMenuController.shared.showMenu(from: self, rect: rect)
    }
  }

  private func installOutsideTap() {
    guard let window else { return }
    let tap = UITapGestureRecognizer(target: self, action: #selector(outsideTapped))
    tap.cancelsTouchesInView = false
    tap.delegate = self
    window.addGestureRecognizer(tap)
    outsideTap = tap
  }

  @objc private func outsideTapped() { dismiss() }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch
  ) -> Bool {
    guard gestureRecognizer === outsideTap else { return true }
    guard let view = touch.view else { return true }
    // Taps on the selection or its edit menu keep the selection; the menu's
    // actions (Copy, Add note) run after this recognizer.
    return !view.isDescendant(of: self) && !Self.isEditMenu(view)
  }

  private static func isEditMenu(_ view: UIView) -> Bool {
    var current: UIView? = view
    while let candidate = current {
      let name = NSStringFromClass(type(of: candidate))
      if name.contains("EditMenu") || name.contains("Callout") || name.contains("ContextMenu") {
        return true
      }
      current = candidate.superview
    }
    return false
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
  ) -> Bool {
    gestureRecognizer === outsideTap
  }

  func dismiss() {
    guard !dismissed else { return }
    dismissed = true
    watcher?.invalidate()
    watcher = nil
    if let outsideTap { outsideTap.view?.removeGestureRecognizer(outsideTap) }
    outsideTap = nil
    selectedRange = NSRange(location: 0, length: 0)
    if isFirstResponder { _ = super.resignFirstResponder() }
    removeFromSuperview()
  }

  override func resignFirstResponder() -> Bool {
    let resigned = super.resignFirstResponder()
    if resigned { DispatchQueue.main.async { [weak self] in self?.dismiss() } }
    return resigned
  }

  func textViewDidChangeSelection(_ textView: UITextView) {
    guard !dismissed, selectedRange.length == 0 else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self, self.selectedRange.length == 0 else { return }
      self.dismiss()
    }
  }

  private var selectedText: String {
    (storage.string as NSString).substring(with: selectedRange)
  }

  /// The copy carries invisible colors; copy what React Native shows instead.
  override func copy(_ sender: Any?) {
    guard selectedRange.length > 0 else { return }
    UIPasteboard.general.string = selectedText
  }

  @available(iOS 16.0, *)
  func textView(
    _ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]
  ) -> UIMenu? {
    menu(with: suggestedActions)
  }

  /// The system actions, led by Add note where this text can be annotated.
  fileprivate func menu(with suggestedActions: [UIMenuElement]) -> UIMenu {
    let selection = OpenGeniTextSelection.shared
    guard !sourceKey.isEmpty, selection.canAnnotate, let title = selection.annotateTitle else {
      return UIMenu(children: suggestedActions)
    }
    // The quote is read now: the action runs after the menu closes, when the
    // selection may already be gone.
    guard let quote = selectedQuote() else { return UIMenu(children: suggestedActions) }
    let key = sourceKey
    let annotate = UIAction(title: title, image: UIImage(systemName: "text.quote")) {
      [weak self] _ in
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
      OpenGeniTextSelection.shared.annotate(
        key: key, quote: quote.quote, before: quote.before, after: quote.after)
      self?.dismiss()
    }
    return UIMenu(children: [annotate] + suggestedActions)
  }

  private func selectedQuote() -> (quote: String, before: String, after: String)? {
    let string = storage.string as NSString
    let range = selectedRange
    guard range.length > 0, NSMaxRange(range) <= string.length else { return nil }
    return (
      string.substring(with: range), string.substring(to: range.location),
      string.substring(from: NSMaxRange(range))
    )
  }
}

@available(iOS 16.0, *)
extension OpenGeniSelectionTextView: UIEditMenuInteractionDelegate {
  func editMenuInteraction(
    _ interaction: UIEditMenuInteraction, menuFor configuration: UIEditMenuConfiguration,
    suggestedActions: [UIMenuElement]
  ) -> UIMenu? {
    menu(with: suggestedActions)
  }

  func editMenuInteraction(
    _ interaction: UIEditMenuInteraction, targetRectFor configuration: UIEditMenuConfiguration
  ) -> CGRect {
    guard let range = selectedTextRange else { return .null }
    return firstRect(for: range)
  }
}
