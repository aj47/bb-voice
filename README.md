# bb voice

Hands-free voice for [bb](https://getbb.app) on Android. The app shows bb's full web UI and adds a native voice loop that keeps working with the screen off or the phone locked.

Open a thread, tap the waveform button next to the composer's mic, and talk. Your words go to the thread's agent and its replies are read back to you. There are two voice modes:

- **On-device:** free. Android's speech recognizer hears you, and system text-to-speech reads the agent's reply sentence by sentence as it streams.
- **GPT-Live:** OpenAI's `gpt-live-1` holds the conversation. A tool model composes a clean message for the agent from what you said and can find, switch, start, read, check and stop threads for you. Billed to your OpenAI key.

| Thread with the realtime button | Live session | Voice settings |
| --- | --- | --- |
| <img src="docs/screenshots/thread.png" width="240" alt="Thread with the realtime button"> | <img src="docs/screenshots/live.png" width="240" alt="Live session"> | <img src="docs/screenshots/settings.png" width="240" alt="Voice settings"> |

## Setup

You need a running bb, and the phone needs to reach it. Tailscale is the easiest way. bb's API has no token auth, so keep it on a private network.

1. **Allow your hostname in bb.** bb only accepts requests addressed to `localhost`, an IP, or the hostname in `BB_APP_URL`. On the machine running bb:
   ```sh
   npx bb-app config set BB_APP_URL https://your-mac.your-tailnet.ts.net:38886
   ```
2. **Install the bb plugin** that adds the realtime button to thread composers:
   ```sh
   bb plugin install git:https://github.com/aj47/bb-plugins.git@main --plugin handsfree
   ```
3. **Build and install the app** (Android SDK and JDK 17):
   ```sh
   npm install
   npx expo prebuild -p android
   cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
   adb install -r app/build/outputs/apk/release/app-release.apk
   ```
4. **Open bb voice** and enter your bb URL (the same one as `BB_APP_URL`).

## Using it

- **Start or stop:** tap the waveform button next to the mic in any thread. A voice bar at the bottom shows the state (listening, agent working, speaking) and has ✕ to stop. Lock the phone and it keeps going; the notification has a Stop button.
- **Settings:** long-press the waveform button. Choose the mode, paste an OpenAI API key (stored in Android secure storage), and pick the GPT-Live voice and tool model.
- **On-device mode:** pause about 1.5 seconds and what you said is sent. Say "stop", "cancel" or "never mind" to stop the agent. Tap the bar to cut off speech.
- **GPT-Live mode:** just talk; interrupting works. Ask for work ("ask it to add tests for the parser"), threads ("what's running?", "switch to the website thread", "start a new thread in gmclip to…"), or results ("what did it say?", "is it done?").

GPT-Live is billed per second at about $0.05/min while connected, plus a small cost for the tool model. Stop the session when you're done.

## How it works

- `App.tsx` loads bb's web UI in a WebView and owns the voice session. The plugin's button talks to it over the WebView bridge (`bbvoice.toggle`, `bbvoice.settings`), and the app sends state back as a `bbvoice:state` event.
- `src/bb.ts` is a small bb API client: `POST /api/v1/threads/:id/send`, `/ws` change notifications, and `GET /threads/:id/events?afterSeq=N` for agent messages and turn completion.
- `src/voiceSession.ts` runs on-device mode with `expo-speech-recognition` and `expo-speech`. Recognizer sessions are short and restarted, because segmented sessions misbehave on Samsung. The last partial is kept because Google's on-device recognizer often ends with an empty final.
- `src/liveSession.ts` runs GPT-Live over WebRTC with Responses delegation. Tool calls run against the bb API. Agent progress is fed back as quiet context and finished replies as spoken commentary.
- `src/speakable.ts` turns streamed markdown into speakable sentences and skips code blocks.
- `modules/bb-voice-native` is an Android foreground service (microphone type) with a wake lock, plus a HeadlessJS task so React Native timers keep running with the screen off. It also routes call audio to a headset or the speaker.

iOS should mostly work for on-device mode, but it is untested and has no background support yet.

## License

MIT
