# @aj47/bb-voice-core

The voice engines behind [bb voice](https://github.com/aj47/bb-voice) and the [handsfree bb plugin](https://github.com/aj47/bb-plugins/tree/main/handsfree), shared so the phone and the desktop run the same loop.

- `ClassicSession`: listen, debounce, send to the bb thread, speak the streamed reply, listen again.
- `LiveSession`: OpenAI GPT-Live over WebRTC with Responses delegation and bb thread tools.
- `BbClient`: a small client for bb's `/api/v1` and `/ws`.
- `SentenceChunker` / `toSpeakable`: streamed markdown to speakable sentences.
- Bridge types for the mobile WebView shell (`bbvoice.toggle`, `bbvoice:state`).

The engines take a platform object for everything native: speech recognition, text-to-speech, WebRTC, the OpenAI SDP exchange and background keep-alive. The mobile app passes Expo and react-native-webrtc adapters; the plugin passes browser ones.

Metro resolves the `react-native` export condition to the TypeScript source, so the app needs no build step. Everything else gets `dist/`.
