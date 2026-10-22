require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'OpenGeniCall'
  s.version        = package['version']
  s.summary        = 'System voice calls (CallKit) for Opengeni agents'
  s.description    = 'Reports Opengeni realtime voice sessions as CallKit calls and forwards call, audio-session and launch events to JavaScript.'
  s.license        = 'Apache-2.0'
  s.author         = 'Opengeni'
  s.homepage       = 'https://github.com/Cloudgeni-ai/opengeni'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/Cloudgeni-ai/opengeni.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'CallKit', 'Intents'

  s.source_files = '**/*.swift'
end
