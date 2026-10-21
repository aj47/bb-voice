// bb voice: the bb web UI in a WebView, plus a native hands-free voice loop
// that keeps working with the screen off or locked.
//
// The `handsfree` bb plugin adds a realtime button to each thread composer. It talks
// to this shell over the WebView bridge: the page posts `bbvoice.toggle`, the
// shell answers by dispatching `bbvoice:state` into the page.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, BackHandler, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import {
  BbClient,
  BRIDGE_VERSION,
  ClassicSession,
  DEFAULT_SETTINGS,
  LIVE_VOICES,
  LiveSession,
  parseBridgeMessage,
  STATE_EVENT,
  threadLabel,
  type BridgeState,
  type Phase,
  type VoiceEngine,
  type VoiceMode,
  type VoicePrefs,
  type VoiceSnapshot,
} from '@aj47/bb-voice-core';
import { onStopRequested } from './modules/bb-voice-native/src';
import { classicPlatform, livePlatform } from './src/platform';
import { DEFAULT_APP_SETTINGS, getApiKey, loadSettings, saveSettings, type AppSettings } from './src/settings';

const KEY_SERVER = 'bbvoice.server';

type Active = { threadId: string; title: string; mode: VoiceMode; session: VoiceEngine };

export default function App() {
  const [server, setServer] = useState<string | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(KEY_SERVER).then((s) => setServer(s ?? ''));
  }, []);

  const save = useCallback((url: string) => {
    setServer(url);
    AsyncStorage.setItem(KEY_SERVER, url);
  }, []);

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      {server === null ? null : server ? (
        <Shell key={server} server={server} onChangeServer={save} />
      ) : (
        <ServerSetup initial="" onSave={save} />
      )}
    </View>
  );
}

function ServerSetup({ initial, onSave, error }: { initial: string; onSave: (url: string) => void; error?: string }) {
  const [url, setUrl] = useState(initial);
  return (
    <View style={styles.setup}>
      <Text style={styles.h1}>bb server</Text>
      <Text style={styles.muted}>Your bb app URL, reachable from this phone (e.g. over Tailscale).</Text>
      <TextInput
        style={styles.input}
        value={url}
        onChangeText={setUrl}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="https://host:38886"
        placeholderTextColor="#666"
        onSubmitEditing={() => url.trim() && onSave(url.trim())}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable style={styles.button} onPress={() => url.trim() && onSave(url.trim())}>
        <Text style={styles.buttonText}>Connect</Text>
      </Pressable>
    </View>
  );
}

const BRIDGE_BOOT = `
  window.__BB_VOICE__ = { version: ${BRIDGE_VERSION}, state: null };
  true;
`;

// The server setup screen shows when bb fails to load; saving a new URL remounts the shell.
function Shell({ server, onChangeServer }: { server: string; onChangeServer: (url: string) => void }) {
  const web = useRef<WebView>(null);
  const canGoBack = useRef(false);
  const active = useRef<Active | null>(null);
  const client = useMemo(() => new BbClient(server), [server]);
  const [snap, setSnap] = useState<VoiceSnapshot | null>(null);
  const snapRef = useRef<VoiceSnapshot | null>(null);
  snapRef.current = snap;
  const [activeTitle, setActiveTitle] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const pendingThread = useRef<string | null>(null);

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  // Push the voice state into the page so the plugin button reflects it.
  const publish = useCallback((phase: Phase) => {
    const state: BridgeState | null = active.current ? { threadId: active.current.threadId, phase, mode: active.current.mode } : null;
    web.current?.injectJavaScript(`
      if (window.__BB_VOICE__) {
        window.__BB_VOICE__.state = ${JSON.stringify(state)};
        window.dispatchEvent(new CustomEvent('${STATE_EVENT}'));
      }
      true;
    `);
  }, []);

  const stop = useCallback(() => {
    const a = active.current;
    active.current = null;
    a?.session.stop();
    setSnap(null);
    publish('off');
  }, [publish]);

  const start = useCallback(
    async (threadId: string) => {
      stop();
      let title = threadId;
      try {
        title = threadLabel(await client.getThread(threadId));
      } catch {}
      const current = await loadSettings();
      let session: VoiceEngine;
      if (current.mode === 'live') {
        const apiKey = await getApiKey();
        if (!apiKey) {
          pendingThread.current = threadId;
          setShowSettings(true);
          return;
        }
        session = new LiveSession(
          livePlatform(apiKey),
          client,
          threadId,
          title,
          { model: current.liveModel, voice: current.liveVoice, delegateModel: current.delegateModel },
          // The voice can move itself to another thread (switch_thread / new_thread).
          (nextId, nextTitle) => {
            if (active.current?.session !== session) return;
            active.current = { ...active.current, threadId: nextId, title: nextTitle };
            setActiveTitle(nextTitle);
            publish(snapRef.current?.phase ?? 'listening');
          },
        );
      } else {
        session = new ClassicSession(classicPlatform, client, threadId, DEFAULT_SETTINGS, title);
      }
      active.current = { threadId, title, mode: current.mode, session };
      setActiveTitle(title);
      session.subscribe((s) => {
        if (active.current?.session !== session) return;
        setSnap(s);
        publish(s.phase);
      });
      session.start();
    },
    [client, publish, stop],
  );

  const toggle = useCallback(
    (threadId: string) => {
      if (active.current?.threadId === threadId) stop();
      else start(threadId);
    },
    [start, stop],
  );

  useEffect(() => {
    const sub = onStopRequested(stop);
    // The WebView can miss state injected while the screen was off; resync on return.
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') publish(snapRef.current?.phase ?? 'off');
    });
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!canGoBack.current) return false;
      web.current?.goBack();
      return true;
    });
    return () => {
      sub.remove();
      appState.remove();
      back.remove();
      active.current?.session.stop();
    };
  }, [publish, stop]);

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      const msg = parseBridgeMessage(e.nativeEvent.data);
      if (msg?.type === 'bbvoice.toggle') toggle(msg.threadId);
      if (msg?.type === 'bbvoice.settings') setShowSettings(true);
    },
    [toggle],
  );

  if (loadError) {
    return (
      <ServerSetup
        initial={server}
        error={loadError}
        onSave={(url) => (url === server ? setLoadError(null) : onChangeServer(url))}
      />
    );
  }

  const phase = snap?.phase ?? 'off';
  return (
    <View style={styles.flex}>
      <WebView
        ref={web}
        source={{ uri: server }}
        style={styles.flex}
        injectedJavaScriptBeforeContentLoaded={BRIDGE_BOOT}
        onMessage={onMessage}
        onLoadEnd={() => publish(phase)}
        onNavigationStateChange={(nav) => {
          canGoBack.current = nav.canGoBack;
        }}
        onError={(e) => setLoadError(`Couldn't load ${server}: ${e.nativeEvent.description}`)}
        mediaCapturePermissionGrantType="grant"
        allowsInlineMediaPlayback
        setSupportMultipleWindows={false}
        pullToRefreshEnabled
        webviewDebuggingEnabled
        applicationNameForUserAgent="bbvoice/1"
      />
      {snap ? (
        <VoiceBar
          title={activeTitle}
          phase={phase}
          partial={snap.partial}
          error={snap.error}
          onPress={() => {
            const s = active.current?.session;
            if (!s) return;
            if (!s.interrupt() && (phase === 'off' || phase === 'error')) s.start();
          }}
          onStop={stop}
        />
      ) : null}
      <SettingsSheet
        visible={showSettings}
        settings={settings}
        onClose={() => {
          setShowSettings(false);
          pendingThread.current = null;
        }}
        onSave={async (next, apiKey) => {
          await saveSettings(next, apiKey);
          setSettings(await loadSettings());
          setShowSettings(false);
          const threadId = pendingThread.current;
          pendingThread.current = null;
          if (threadId) start(threadId);
        }}
      />
    </View>
  );
}

function Dropdown({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable style={[styles.input, styles.dropdown]} onPress={() => setOpen((o) => !o)}>
        <Text style={styles.dropdownText}>{value}</Text>
        <Text style={styles.dropdownText}>{open ? '▴' : '▾'}</Text>
      </Pressable>
      {open ? (
        <ScrollView style={styles.dropdownList} nestedScrollEnabled>
          {options.map((option) => (
            <Pressable
              key={option}
              style={[styles.dropdownItem, option === value && styles.dropdownItemActive]}
              onPress={() => {
                onChange(option);
                setOpen(false);
              }}
            >
              <Text style={styles.dropdownText}>{option}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

function SettingsSheet(props: {
  visible: boolean;
  settings: AppSettings;
  onClose: () => void;
  onSave: (next: VoicePrefs, apiKey?: string) => void;
}) {
  const [mode, setMode] = useState<VoiceMode>(props.settings.mode);
  const [model, setModel] = useState(props.settings.liveModel);
  const [voice, setVoice] = useState(props.settings.liveVoice);
  const [delegateModel, setDelegateModel] = useState(props.settings.delegateModel);
  const [key, setKey] = useState('');

  useEffect(() => {
    if (!props.visible) return;
    setMode(props.settings.mode);
    setModel(props.settings.liveModel);
    setVoice(props.settings.liveVoice);
    setDelegateModel(props.settings.delegateModel);
    setKey('');
  }, [props.visible, props.settings]);

  return (
    <Modal visible={props.visible} transparent animationType="slide" onRequestClose={props.onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={props.onClose} />
      <View style={styles.sheet}>
        <Text style={styles.h1}>Realtime voice</Text>
        <View style={styles.segment}>
          {(['live', 'classic'] as const).map((m) => (
            <Pressable key={m} style={[styles.segmentItem, mode === m && styles.segmentActive]} onPress={() => setMode(m)}>
              <Text style={styles.segmentText}>{m === 'live' ? 'GPT-Live' : 'On-device'}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.muted}>
          {mode === 'live'
            ? 'OpenAI GPT-Live talks with you and hands work to the bb agent. Billed per minute to your OpenAI key.'
            : 'Free on-device speech recognition and text-to-speech.'}
        </Text>
        {mode === 'live' ? (
          <>
            <Text style={styles.label}>OpenAI API key {props.settings.hasApiKey ? '(saved; leave blank to keep)' : ''}</Text>
            <TextInput
              style={styles.input}
              value={key}
              onChangeText={setKey}
              placeholder={props.settings.hasApiKey ? '••••••••' : 'sk-...'}
              placeholderTextColor="#666"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.label}>Model</Text>
            <TextInput style={styles.input} value={model} onChangeText={setModel} autoCapitalize="none" autoCorrect={false} />
            <Text style={styles.label}>Tool model (writes agent messages, runs bb tools)</Text>
            <TextInput style={styles.input} value={delegateModel} onChangeText={setDelegateModel} autoCapitalize="none" autoCorrect={false} />
            <Text style={styles.label}>Voice</Text>
            <Dropdown value={voice} options={LIVE_VOICES} onChange={setVoice} />
          </>
        ) : null}
        <Pressable
          style={styles.button}
          onPress={() =>
            props.onSave(
              {
                mode,
                liveModel: model.trim() || DEFAULT_APP_SETTINGS.liveModel,
                liveVoice: voice.trim() || DEFAULT_APP_SETTINGS.liveVoice,
                delegateModel: delegateModel.trim() || DEFAULT_APP_SETTINGS.delegateModel,
              },
              key.trim() ? key.trim() : undefined,
            )
          }
        >
          <Text style={styles.buttonText}>Save</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const PHASE_LABEL: Record<Phase, string> = {
  off: 'Off · tap to resume',
  listening: 'Listening',
  hearing: 'Hearing you',
  thinking: 'Agent working',
  speaking: 'Speaking · tap to interrupt',
  error: 'Error · tap to retry',
};

const PHASE_COLOR: Record<Phase, string> = {
  off: '#3a3a3a',
  listening: '#1f7a4d',
  hearing: '#27a265',
  thinking: '#7a5a1f',
  speaking: '#1f4f7a',
  error: '#7a1f1f',
};

function VoiceBar(props: {
  title: string;
  phase: Phase;
  partial: string;
  error: string | null;
  onPress: () => void;
  onStop: () => void;
}) {
  return (
    <View style={[styles.bar, { backgroundColor: PHASE_COLOR[props.phase] }]}>
      <Pressable style={styles.barMain} onPress={props.onPress}>
        <Text style={styles.barPhase} numberOfLines={1}>
          {PHASE_LABEL[props.phase]} · {props.title}
        </Text>
        {props.error || props.partial ? (
          <Text style={styles.barSub} numberOfLines={2}>
            {props.error ?? props.partial}
          </Text>
        ) : null}
      </Pressable>
      <Pressable style={styles.barStop} onPress={props.onStop} hitSlop={10} accessibilityLabel="Stop hands-free">
        <Text style={styles.barStopText}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#111', paddingTop: 36, paddingBottom: 20 },
  flex: { flex: 1, backgroundColor: '#111' },
  setup: { flex: 1, padding: 24, justifyContent: 'center', gap: 12 },
  h1: { color: '#eee', fontSize: 22, fontWeight: '600' },
  muted: { color: '#888', fontSize: 14 },
  input: { color: '#eee', backgroundColor: '#1d1d1d', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 12, fontSize: 15 },
  error: { color: '#ff7b7b' },
  button: { backgroundColor: '#1f7a4d', borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 12 },
  barMain: { flex: 1 },
  barPhase: { color: '#fff', fontSize: 15, fontWeight: '600' },
  barSub: { color: '#ffffffcc', fontSize: 13, marginTop: 2, fontStyle: 'italic' },
  barStop: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#00000033', alignItems: 'center', justifyContent: 'center' },
  barStopText: { color: '#fff', fontSize: 16 },
  sheetBackdrop: { flex: 1, backgroundColor: '#0008' },
  sheet: { backgroundColor: '#181818', padding: 20, paddingBottom: 36, gap: 10, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  label: { color: '#aaa', fontSize: 13, marginTop: 4 },
  segment: { flexDirection: 'row', backgroundColor: '#222', borderRadius: 10, padding: 3 },
  segmentItem: { flex: 1, paddingVertical: 9, alignItems: 'center', borderRadius: 8 },
  segmentActive: { backgroundColor: '#1f7a4d' },
  segmentText: { color: '#eee', fontSize: 15, fontWeight: '600' },
  dropdown: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  dropdownText: { color: '#eee', fontSize: 15 },
  dropdownList: { maxHeight: 220, backgroundColor: '#1d1d1d', borderRadius: 8, marginTop: 4 },
  dropdownItem: { paddingHorizontal: 12, paddingVertical: 11 },
  dropdownItemActive: { backgroundColor: '#1f7a4d55' },
});
