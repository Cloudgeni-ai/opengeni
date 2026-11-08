require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# The call audio device (config plugin `call.iosAudioDevice`) builds against
# WebRTC, so it is only part of apps that ask for it.
podfile_properties =
  begin
    JSON.parse(File.read(File.join(Pod::Config.instance.installation_root.to_s, 'Podfile.properties.json')))
  rescue StandardError
    {}
  end
audio_device = podfile_properties['opengeni.callAudioDevice'] == 'true'

Pod::Spec.new do |s|
  s.name           = 'OpenGeniCall'
  s.version        = package['version']
  s.summary        = 'System voice calls (CallKit) for Opengeni agents'
  s.description    = 'Reports Opengeni realtime voice sessions as CallKit calls, rings agent calls through PushKit, and forwards call, audio-session and launch events to JavaScript.'
  s.license        = 'Apache-2.0'
  s.author         = 'Opengeni'
  s.homepage       = 'https://github.com/Cloudgeni-ai/opengeni'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/Cloudgeni-ai/opengeni.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'CallKit', 'Intents', 'PushKit'

  if audio_device
    # The WebRTC that react-native-webrtc ships.
    s.dependency 'JitsiWebRTC'
    s.frameworks = 'AVFoundation', 'AudioToolbox', 'CallKit', 'Intents', 'PushKit'
    s.source_files = '**/*.{swift,m}'
  else
    s.source_files = '**/*.swift'
    s.exclude_files = 'audio-device/**'
  end
end
