#import <Foundation/Foundation.h>

/// Hands react-native-webrtc the call audio device before its module exists:
/// WebRTCModule reads WebRTCModuleOptions.audioDevice once, when it creates
/// the peer connection factory. An app that set its own device keeps it.
@interface OpenGeniCallAudioDeviceInstaller : NSObject
@end

@implementation OpenGeniCallAudioDeviceInstaller

+ (void)load {
  Class options = NSClassFromString(@"WebRTCModuleOptions");
  Class device = NSClassFromString(@"OpenGeniCallAudioDevice");
  SEL shared = NSSelectorFromString(@"sharedInstance");
  if (options == nil || device == nil || ![options respondsToSelector:shared]) {
    return;
  }
  id (*sharedInstance)(id, SEL) = (id(*)(id, SEL))[options methodForSelector:shared];
  NSObject *instance = sharedInstance(options, shared);
  if (instance == nil || [instance valueForKey:@"audioDevice"] != nil) {
    return;
  }
  [instance setValue:[[device alloc] init] forKey:@"audioDevice"];
}

@end
