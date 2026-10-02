import AppKit
let root = CommandLine.arguments[1]
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let window = NSWindow(contentRect:NSRect(x:80,y:80,width:700,height:300),styleMask:[.titled,.closable],backing:.buffered,defer:false)
window.title = "OpenGeni CUA disposable fixture"
let field = NSTextField(frame:NSRect(x:24,y:150,width:420,height:30))
field.stringValue = "first"
field.setAccessibilityIdentifier("fixture-text")
field.setAccessibilityLabel("Fixture text")
window.contentView!.addSubview(field)
let password = NSSecureTextField(frame:NSRect(x:24,y:195,width:200,height:28))
password.stringValue = "fixture-secret-never-observe"
password.setAccessibilityLabel("Fixture password")
window.contentView!.addSubview(password)
let result = NSTextField(labelWithString:"Clicks: 0")
result.frame = NSRect(x:24,y:45,width:400,height:28)
window.contentView!.addSubview(result)
class Handler: NSObject {
 var count = 0
 let result:NSTextField
 init(_ result:NSTextField) { self.result=result }
 @objc func click(_ sender:Any?) { count += 1; result.stringValue="Clicks: \(count)" }
}
let handler=Handler(result)
let button=NSButton(title:"Increment",target:handler,action:#selector(Handler.click(_:)))
button.frame=NSRect(x:24,y:95,width:140,height:36)
button.setAccessibilityIdentifier("fixture-increment")
window.contentView!.addSubview(button)
class GestureView: NSView {
 var scrollEvents = 0
 var dragEvents = 0
 override var acceptsFirstResponder: Bool { true }
 override func scrollWheel(with event: NSEvent) { scrollEvents += 1; needsDisplay = true }
 override func mouseDown(with event: NSEvent) {}
 override func mouseDragged(with event: NSEvent) { dragEvents += 1; needsDisplay = true }
 override func draw(_ dirtyRect: NSRect) {
  NSColor.systemBlue.setFill(); bounds.fill()
  ("Scroll: \(scrollEvents) Drag: \(dragEvents)" as NSString).draw(at: NSPoint(x:10,y:100),withAttributes:[.foregroundColor:NSColor.white])
 }
}
let gestures = GestureView(frame:NSRect(x:480,y:24,width:180,height:240))
window.contentView!.addSubview(gestures)
window.orderBack(nil)
let timer=Timer.scheduledTimer(withTimeInterval:0.05,repeats:true) { _ in
 let state:[String:Any] = ["pid":ProcessInfo.processInfo.processIdentifier,"windowId":window.windowNumber,"value":field.stringValue,"clicks":handler.count,"scrollEvents":gestures.scrollEvents,"dragEvents":gestures.dragEvents,"frontmostPid":NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1]
 if let data=try? JSONSerialization.data(withJSONObject:state) {try? data.write(to:URL(fileURLWithPath:root+"/fixture-state.json"),options:.atomic)}
}
Timer.scheduledTimer(withTimeInterval:600,repeats:false) { _ in app.terminate(nil) }
app.run()
