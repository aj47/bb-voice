import { requireOptionalNativeModule } from 'expo-modules-core';
import { AppRegistry, PermissionsAndroid, Platform } from 'react-native';

type NativeModule = {
  addListener(event: 'onStopRequested', fn: () => void): { remove(): void };
  startKeepAlive(title: string, text: string): boolean;
  updateKeepAlive(title: string, text: string): void;
  stopKeepAlive(): void;
  setCallAudioRoute(active: boolean): void;
  isIgnoringBatteryOptimizations(): boolean;
  requestIgnoreBatteryOptimizations(): boolean;
};

const native = Platform.OS === 'android' ? requireOptionalNativeModule<NativeModule>('BbVoiceNative') : null;

// The native side starts this task and finishes it on stop. It never resolves on
// its own; its only job is to keep React Native's JS timers running in background.
AppRegistry.registerHeadlessTask('BbVoiceKeepAlive', () => () => new Promise<void>(() => {}));

// Asked once per launch: declining shouldn't bring the dialog back every session.
let askedBattery = false;

export async function startKeepAlive(title: string, text: string) {
  if (!native) return false;
  if (Platform.OS === 'android' && Platform.Version >= 33) {
    await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => {});
  }
  // Without the exemption, a locked phone holds the voice loop's timers.
  if (!askedBattery && !native.isIgnoringBatteryOptimizations()) {
    askedBattery = true;
    native.requestIgnoreBatteryOptimizations();
  }
  return native.startKeepAlive(title, text);
}

export function updateKeepAlive(title: string, text: string) {
  native?.updateKeepAlive(title, text);
}

export function stopKeepAlive() {
  native?.stopKeepAlive();
}

export function setCallAudioRoute(active: boolean) {
  native?.setCallAudioRoute(active);
}

// Fired by the notification's Stop button (works from the lock screen).
export function onStopRequested(fn: () => void) {
  return native?.addListener('onStopRequested', fn) ?? { remove() {} };
}
