import { DEFAULT_PREFS, type VoicePrefs } from '@aj47/bb-voice-core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

export type AppSettings = VoicePrefs & { hasApiKey: boolean };

const KEY_PREFS = 'bbvoice.prefs';
const KEY_OPENAI = 'bbvoice.openai_key';

export const DEFAULT_APP_SETTINGS: AppSettings = { ...DEFAULT_PREFS, hasApiKey: false };

export async function loadSettings(): Promise<AppSettings> {
  const raw = await AsyncStorage.getItem(KEY_PREFS);
  const prefs = raw ? (JSON.parse(raw) as Partial<AppSettings>) : {};
  const key = await SecureStore.getItemAsync(KEY_OPENAI);
  return { ...DEFAULT_APP_SETTINGS, ...prefs, hasApiKey: Boolean(key) };
}

export async function saveSettings(settings: VoicePrefs, apiKey?: string) {
  await AsyncStorage.setItem(KEY_PREFS, JSON.stringify(settings));
  if (apiKey !== undefined) {
    if (apiKey) await SecureStore.setItemAsync(KEY_OPENAI, apiKey);
    else await SecureStore.deleteItemAsync(KEY_OPENAI);
  }
}

export function getApiKey() {
  return SecureStore.getItemAsync(KEY_OPENAI);
}
