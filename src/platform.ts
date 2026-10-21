// React Native adapters for the shared voice engines in @aj47/bb-voice-core.

import { negotiateWithOpenAI, type ClassicPlatform, type KeepAlive, type LivePlatform, type PeerConnection } from '@aj47/bb-voice-core';
import * as Speech from 'expo-speech';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { mediaDevices, RTCPeerConnection } from 'react-native-webrtc';
import { setCallAudioRoute, startKeepAlive, stopKeepAlive, updateKeepAlive } from '../modules/bb-voice-native/src';

const keepAlive: KeepAlive = { start: startKeepAlive, update: updateKeepAlive, stop: stopKeepAlive };

export const classicPlatform: ClassicPlatform = {
  keepAlive,
  recognizer: {
    async requestPermission() {
      return (await ExpoSpeechRecognitionModule.requestPermissionsAsync()).granted;
    },
    listen(events) {
      const M = ExpoSpeechRecognitionModule;
      const subs = [
        M.addListener('result', (e) => events.result(e.results[0]?.transcript ?? '', e.isFinal)),
        M.addListener('end', () => events.end()),
        M.addListener('error', (e) => events.error(e.error, e.message)),
      ];
      return () => subs.forEach((s) => s.remove());
    },
    start(language) {
      ExpoSpeechRecognitionModule.start({
        lang: language,
        interimResults: true,
        continuous: false,
        addsPunctuation: true,
        maxAlternatives: 1,
        androidIntentOptions: {
          EXTRA_PREFER_OFFLINE: true,
          EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 1800,
          EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: 1200,
          EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS: 1000,
        },
        iosCategory: {
          category: 'playAndRecord',
          categoryOptions: ['defaultToSpeaker', 'allowBluetooth'],
          mode: 'default',
        },
      });
    },
    abort() {
      ExpoSpeechRecognitionModule.abort();
    },
  },
  speaker: {
    speak(text, { language, rate, onDone }) {
      Speech.speak(text, { language, rate, onDone, onStopped: onDone, onError: onDone });
    },
    stop() {
      Speech.stop();
    },
  },
};

// The phone holds the OpenAI key (Android secure storage) and calls OpenAI directly.
export function livePlatform(apiKey: string): LivePlatform {
  return {
    keepAlive,
    createPeerConnection: () => new RTCPeerConnection({ iceServers: [] }) as unknown as PeerConnection,
    getUserMedia: () => mediaDevices.getUserMedia({ audio: true, video: false }),
    negotiate: (offerSdp, session) => negotiateWithOpenAI(apiKey, offerSdp, session),
    setAudioRoute: setCallAudioRoute,
  };
}
