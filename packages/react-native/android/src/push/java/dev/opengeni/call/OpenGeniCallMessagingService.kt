package dev.opengeni.call

import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService

/**
 * The app's Firebase messaging service when agents may ring it: call rings
 * go to the system call, everything else to expo-notifications as before.
 * Declared by the config plugin's `call.androidSystemCall`, above
 * expo-notifications' own service.
 */
class OpenGeniCallMessagingService : ExpoFirebaseMessagingService() {
  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    if (OpenGeniCallPush.handle(this, remoteMessage.data)) return
    super.onMessageReceived(remoteMessage)
  }
}
