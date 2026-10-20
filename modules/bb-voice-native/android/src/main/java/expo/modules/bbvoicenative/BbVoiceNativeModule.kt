package expo.modules.bbvoicenative

import android.content.Context
import android.content.Intent
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// React Native pauses JS timers when the app is backgrounded unless a HeadlessJS
// task is running. We hold one open for as long as hands-free is on, so the JS
// voice loop (timers, fetch, WebSocket, WebRTC events) keeps running screen-off.
class BbVoiceNativeModule : Module() {
  private var taskId: Int? = null

  override fun definition() = ModuleDefinition {
    Name("BbVoiceNative")
    Events("onStopRequested")

    OnCreate {
      BbVoiceService.onStopRequested = { sendEvent("onStopRequested", emptyMap<String, Any>()) }
    }

    Function("startKeepAlive") { title: String, text: String ->
      val context = appContext.reactContext ?: return@Function false
      val intent = Intent(context, BbVoiceService::class.java)
        .putExtra(BbVoiceService.EXTRA_TITLE, title)
        .putExtra(BbVoiceService.EXTRA_TEXT, text)
      ContextCompat.startForegroundService(context, intent)
      UiThreadUtil.runOnUiThread {
        if (taskId != null) return@runOnUiThread
        val react = appContext.reactContext as? com.facebook.react.bridge.ReactContext ?: return@runOnUiThread
        taskId = HeadlessJsTaskContext.getInstance(react).startTask(
          HeadlessJsTaskConfig(TASK_KEY, Arguments.createMap(), 0, true)
        )
      }
      true
    }

    Function("updateKeepAlive") { title: String, text: String ->
      val context = appContext.reactContext ?: return@Function false
      val intent = Intent(context, BbVoiceService::class.java)
        .putExtra(BbVoiceService.EXTRA_TITLE, title)
        .putExtra(BbVoiceService.EXTRA_TEXT, text)
      ContextCompat.startForegroundService(context, intent)
      true
    }

    Function("stopKeepAlive") {
      val context = appContext.reactContext ?: return@Function false
      context.stopService(Intent(context, BbVoiceService::class.java))
      UiThreadUtil.runOnUiThread {
        val id = taskId ?: return@runOnUiThread
        taskId = null
        val react = appContext.reactContext as? com.facebook.react.bridge.ReactContext ?: return@runOnUiThread
        val tasks = HeadlessJsTaskContext.getInstance(react)
        if (tasks.isTaskRunning(id)) tasks.finishTask(id)
      }
      true
    }

    // WebRTC plays through the earpiece by default. Route the call to a headset
    // if one is connected, otherwise the loudspeaker.
    Function("setCallAudioRoute") { active: Boolean ->
      val context = appContext.reactContext ?: return@Function false
      val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      if (!active) {
        @Suppress("DEPRECATION")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.clearCommunicationDevice() else am.isSpeakerphoneOn = false
        am.mode = AudioManager.MODE_NORMAL
        return@Function true
      }
      am.mode = AudioManager.MODE_IN_COMMUNICATION
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val devices = am.availableCommunicationDevices
        val preferred = listOf(
          AudioDeviceInfo.TYPE_BLE_HEADSET,
          AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
          AudioDeviceInfo.TYPE_WIRED_HEADSET,
          AudioDeviceInfo.TYPE_USB_HEADSET,
          AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
        )
        val device = preferred.firstNotNullOfOrNull { type -> devices.firstOrNull { it.type == type } }
        if (device != null) am.setCommunicationDevice(device)
      } else {
        @Suppress("DEPRECATION")
        am.isSpeakerphoneOn = !am.isWiredHeadsetOn && !am.isBluetoothScoOn
      }
      true
    }

    OnDestroy {
      appContext.reactContext?.let { it.stopService(Intent(it, BbVoiceService::class.java)) }
    }
  }

  companion object {
    const val TASK_KEY = "BbVoiceKeepAlive"
  }
}
