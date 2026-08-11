import AppKit

guard CommandLine.arguments.count >= 2 else {
    FileHandle.standardError.write(Data("usage: LaunchFixture <bundle> [arguments...]\n".utf8))
    exit(64)
}

let bundleURL = URL(fileURLWithPath: CommandLine.arguments[1])
let configuration = NSWorkspace.OpenConfiguration()
configuration.activates = false
configuration.addsToRecentItems = false
configuration.createsNewApplicationInstance = true
configuration.arguments = Array(CommandLine.arguments.dropFirst(2))

var completed = false
var processIdentifier: pid_t?
var launchError: Error?
NSWorkspace.shared.openApplication(at: bundleURL, configuration: configuration) { application, error in
    processIdentifier = application?.processIdentifier
    launchError = error
    completed = true
}

let deadline = Date().addingTimeInterval(15)
while !completed && Date() < deadline {
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
}

if let launchError {
    FileHandle.standardError.write(Data("LaunchServices rejected fixture: \(launchError)\n".utf8))
    exit(1)
}
guard completed, let processIdentifier else {
    FileHandle.standardError.write(Data("LaunchServices did not return a fixture process\n".utf8))
    exit(1)
}
print(processIdentifier)
