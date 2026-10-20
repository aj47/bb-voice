package expo.modules.bbvoicenative

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

// Foreground service (type microphone) that keeps the process, mic access and
// CPU alive while the screen is off. The voice loop itself stays in JS.
class BbVoiceService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      onStopRequested?.invoke()
      return START_NOT_STICKY
    }
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "bb voice"
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Listening"
    val notification = buildNotification(title, text)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    if (wakeLock == null) {
      val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "bbvoice:loop").apply {
        setReferenceCounted(false)
        acquire()
      }
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    super.onDestroy()
  }

  private fun buildNotification(title: String, text: String): Notification {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Hands-free voice", NotificationManager.IMPORTANCE_LOW)
      )
    }
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = PendingIntent.getActivity(
      this, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION") Notification.Builder(this)
    }
    val stopIntent = PendingIntent.getService(
      this, 1, Intent(this, BbVoiceService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    return builder
      .addAction(Notification.Action.Builder(null, "Stop", stopIntent).build())
      .setContentTitle(title)
      .setContentText(text)
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentIntent(contentIntent)
      .setOngoing(true)
      .build()
  }

  companion object {
    var onStopRequested: (() -> Unit)? = null
    const val ACTION_STOP = "net.techfren.bbvoice.STOP"
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    private const val CHANNEL_ID = "bbvoice_handsfree"
    private const val NOTIFICATION_ID = 4802
  }
}
