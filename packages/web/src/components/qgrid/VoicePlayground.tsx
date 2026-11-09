import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import ExternalLinkIcon from "~icons/lucide/external-link";
import LoaderIcon from "~icons/lucide/loader-circle";
import MicIcon from "~icons/lucide/mic";
import PlayIcon from "~icons/lucide/play";
import SquareIcon from "~icons/lucide/square";
import XIcon from "~icons/lucide/x";

import {
  type SpeakInput,
  type SpeakOutput,
  type TranscribeInput,
} from "@/services/qgrid/qgrid.types";
import { QgridService } from "@/services/services.generated";

import { TimedPlayer, type TimedWord } from "./TimedPlayer";
import { audioToWavBase64 } from "./voice-audio";

const PROJECT_NAME = "qgrid_voice";

// gpt-realtime-1.5 is left out: it answered the script instead of reading it in 7 of 13 lines
// (2026-10-17 matrix). The server and SDK still accept it.
const TTS_MODELS = ["grok/grok-tts", "openai/gpt-realtime-2.1-mini", "openai/gpt-realtime-2.1"];

// Only the OpenAI models that held up in the 2026-11-09 language/accent run (lowest CER, kept learner
// grammar errors verbatim); gpt-transcribe, gpt-live-transcribe and the whisper models were dropped.
// The server still accepts them. Grok was not measured (token needed re-login) and stays.
const STT_MODELS = [
  "openai/gpt-4o-transcribe",
  "openai/gpt-4o-mini-transcribe",
  "grok/grok-voice-transcribe-2.0",
];

// OpenAI realtime presets (the server rejects others); default first. No gender split: several are
// ambiguous (ballad reads as androgynous), so they stay one group.
const OPENAI_VOICES = [
  "marin",
  "cedar",
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
];

// Grok /tts voices listed by xAI for the subscription token (2026-11-06); default first.
const GROK_VOICE_GROUPS = [
  {
    label: "Female",
    voices: ["ara", "aurora", "carina", "celeste", "eve", "iris", "liora", "luna", "ursa"],
  },
  {
    label: "Male",
    voices: [
      "altair",
      "atlas",
      "castor",
      "cosmo",
      "helios",
      "helix",
      "kepler",
      "leo",
      "lumen",
      "lux",
      "naksh",
      "orion",
      "perseus",
      "rex",
      "rigel",
      "sal",
      "sirius",
      "zagan",
      "zenith",
    ],
  },
];

const OPENAI_VOICE_GROUPS = [{ label: "", voices: OPENAI_VOICES }];

const isOpenAI = (model: string) => model.startsWith("openai/");

const FIELD =
  "w-full rounded-lg border border-sand-200/80 bg-white px-2.5 py-1.5 text-[12px] text-sand-800 placeholder:text-sand-400 focus:outline-none focus:border-sienna-300 disabled:opacity-50";

// Selects and inputs share one height; WebKit otherwise renders selects shorter than inputs.
const CONTROL = `${FIELD} h-8`;

const BUTTON =
  "px-3.5 py-1.5 text-[12px] font-medium rounded-lg bg-sienna-500 text-white hover:bg-sienna-600 disabled:opacity-50 transition-all duration-150 active:scale-[0.97] inline-flex items-center gap-1.5 shadow-sm";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-sand-500">{label}</span>
      {children}
    </label>
  );
}

const shortModel = (model: string) => model.slice(model.indexOf("/") + 1);

/**
 * One past result. The request-log link opens a new tab so leaving the playground does not drop
 * the in-memory history.
 */
function HistoryRow({
  title,
  meta,
  requestLogId,
  onRemove,
  children,
}: {
  title: string;
  meta: string;
  requestLogId?: number;
  onRemove: () => void;
  children: React.ReactNode;
}) {
  return (
    <li className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex items-center gap-2 text-[12px]">
        <span className="font-medium text-sand-800">{title}</span>
        <span className="tabular-nums text-sand-400">{meta}</span>
        <span className="ml-auto flex items-center gap-2">
          {requestLogId !== undefined && (
            <Link
              to="/requests/show"
              search={{ id: requestLogId }}
              target="_blank"
              className="inline-flex items-center gap-1 tabular-nums text-sand-500 hover:text-sienna-500"
            >
              request log #{requestLogId}
              <ExternalLinkIcon className="size-3" />
            </Link>
          )}
          <button
            type="button"
            onClick={onRemove}
            title="Remove from history"
            className="text-sand-300 hover:text-sand-600"
          >
            <XIcon className="size-3.5" />
          </button>
        </span>
      </div>
      {children}
    </li>
  );
}

function History({ empty, children }: { empty: string; children: React.ReactNode[] }) {
  return children.length === 0 ? (
    <p className="px-4 py-6 text-center text-[12px] text-sand-400">{empty}</p>
  ) : (
    <ul className="divide-y divide-sand-100">{children}</ul>
  );
}

/** Words from per-character timing (Grok TTS shape): each run of non-space characters is a word. */
function wordsFromCharTimes(timestamps: SpeakOutput["audioTimestamps"]): TimedWord[] | undefined {
  if (!timestamps) return undefined;
  const words: TimedWord[] = [];
  let current: TimedWord | undefined;

  timestamps.graphChars.forEach((char, i) => {
    const [start, end] = timestamps.graphTimes[i]!;

    if (/\s/.test(char)) {
      current = undefined;

      return;
    }

    if (current) {
      current.text += char;
      current.end = end;
    } else {
      current = { text: char, start, end };
      words.push(current);
    }
  });

  return words;
}

type TtsItem = {
  key: number;
  src: string;
  model: string;
  voice: string;
  instructions?: string;
  text: string;
  elapsedMs: number;
  requestLogId?: number;
  words?: TimedWord[];
  timing?: string;
};

function TtsPanel() {
  const [model, setModel] = useState(TTS_MODELS[0]!);
  const [voice, setVoice] = useState("ara");
  const [instructions, setInstructions] = useState("");
  const [text, setText] = useState("Hi! What did you do this weekend?");
  const [history, setHistory] = useState<TtsItem[]>([]);
  const [withTimestamps, setWithTimestamps] = useState(true);
  const nextKey = useRef(0);
  const speak = QgridService.useSpeakMutation();
  const openai = isOpenAI(model);

  const changeModel = (next: string) => {
    // Voice ids are provider-specific, so switching provider resets to that provider's default.
    if (isOpenAI(next) !== openai) setVoice(isOpenAI(next) ? OPENAI_VOICES[0]! : "ara");
    setModel(next);
  };

  const style = openai && instructions.trim() ? instructions.trim() : undefined;

  const generate = (voiceId: string) => {
    const startedAt = performance.now();
    const params: SpeakInput = { model, text, voice: voiceId, projectName: PROJECT_NAME };

    if (style) params.instructions = style;

    if (withTimestamps) params.withTimestamps = true;

    speak.mutate(
      { params },
      {
        onSuccess: (out) => {
          const item: TtsItem = {
            key: nextKey.current++,
            src: `data:${out.mimeType};base64,${out.audio}`,
            model,
            voice: voiceId,
            instructions: params.instructions,
            text,
            elapsedMs: performance.now() - startedAt,
            requestLogId: out.requestLogId,
            words: wordsFromCharTimes(out.audioTimestamps),
            timing: out.timestampsError
              ? `timing failed: ${out.timestampsError}`
              : out.timestampsSource === "aligned"
                ? "timing aligned via Grok STT"
                : out.timestampsSource === "provider"
                  ? "timing from Grok TTS"
                  : undefined,
          };

          setHistory((items) => [item, ...items]);
        },
      },
    );
  };

  // ▶ plays a bundled sample (public/voice-samples, each voice introducing itself) without a request,
  // and selects that voice; pressing it again while it plays stops it.
  const sampleRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string>();

  useEffect(() => () => sampleRef.current?.pause(), []);

  const playSample = (voiceId: string) => {
    setVoice(voiceId);
    sampleRef.current?.pause();

    if (playing === voiceId) {
      setPlaying(undefined);

      return;
    }

    const audio = new Audio(`/voice-samples/${openai ? "openai" : "grok"}/${voiceId}.mp3`);

    audio.addEventListener(
      "ended",
      () => setPlaying((current) => (current === voiceId ? undefined : current)),
      { once: true },
    );
    sampleRef.current = audio;
    setPlaying(voiceId);
    void audio.play();
  };

  return (
    <>
      <div className="flex flex-col gap-3 p-4">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Model">
            <select value={model} onChange={(e) => changeModel(e.target.value)} className={CONTROL}>
              {TTS_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          {openai && (
            <Field label="Style instructions (OpenAI only)">
              <input
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="e.g. Speak with a gentle Irish accent."
                className={CONTROL}
              />
            </Field>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-sand-500">
            Voice — ▶ plays a short self-introduction sample, a name selects it
          </span>
          {(openai ? OPENAI_VOICE_GROUPS : GROK_VOICE_GROUPS).map((group) => (
            <div key={group.label} className="flex items-start gap-2">
              {group.label && (
                <span className="w-12 shrink-0 pt-1 text-[11px] text-sand-400">{group.label}</span>
              )}
              <div className="flex flex-wrap gap-1.5">
                {group.voices.map((v) => (
                  <span
                    key={v}
                    className={`inline-flex items-center overflow-hidden rounded-full border text-[12px] ${
                      voice === v
                        ? "border-sienna-400 bg-sienna-50 text-sienna-700"
                        : "border-sand-200/80 bg-white text-sand-700"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setVoice(v)}
                      aria-pressed={voice === v}
                      className="py-0.5 pl-2.5 pr-1 hover:text-sienna-600"
                    >
                      {v}
                    </button>
                    <button
                      type="button"
                      onClick={() => playSample(v)}
                      title={playing === v ? `Stop "${v}"` : `Play a "${v}" sample`}
                      className={`py-1 pl-1 pr-2 hover:text-sienna-500 ${
                        playing === v ? "text-sienna-500" : "text-sand-400"
                      }`}
                    >
                      {playing === v ? (
                        <SquareIcon className="size-3" />
                      ) : (
                        <PlayIcon className="size-3" />
                      )}
                    </button>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
        <Field label="Text">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            className={`${FIELD} resize-y`}
          />
        </Field>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => generate(voice)}
            disabled={speak.isPending || !text.trim()}
            className={BUTTON}
          >
            {speak.isPending && <LoaderIcon className="size-3.5 animate-spin" />}
            Generate with {voice}
          </button>
          <label className="flex items-center gap-1.5 text-[12px] text-sand-600">
            <input
              type="checkbox"
              checked={withTimestamps}
              onChange={(e) => setWithTimestamps(e.target.checked)}
              className="accent-sienna-500"
            />
            Word timing
          </label>
          {speak.isError && (
            <p className="text-[12px] text-danger-500 break-words">{speak.error?.message}</p>
          )}
        </div>
      </div>
      <div className="border-t border-sand-100">
        <History empty="Generated clips stack here, newest first, so voices can be compared side by side.">
          {history.map((item) => (
            <HistoryRow
              key={item.key}
              title={`${item.voice} · ${shortModel(item.model)}`}
              meta={[`${(item.elapsedMs / 1000).toFixed(1)}s`, item.timing]
                .filter(Boolean)
                .join(" · ")}
              requestLogId={item.requestLogId}
              onRemove={() => setHistory((items) => items.filter((i) => i.key !== item.key))}
            >
              {(!item.words || item.instructions) && (
                <p className="truncate text-[12px] text-sand-600" title={item.text}>
                  {!item.words && item.text}
                  {item.instructions && (
                    <span className="text-sand-400"> — {item.instructions}</span>
                  )}
                </p>
              )}
              <TimedPlayer src={item.src} words={item.words} autoPlay />
            </HistoryRow>
          ))}
        </History>
      </div>
    </>
  );
}

type SttItem = {
  key: number;
  clip: number;
  clipUrl: string;
  model: string;
  prompt?: string;
  text: string;
  elapsedMs: number;
  durationSec?: number;
  requestLogId?: number;
  words?: TimedWord[];
};

function SttPanel() {
  const [model, setModel] = useState(STT_MODELS[0]!);
  const [prompt, setPrompt] = useState("");
  // Each recording or upload is a numbered clip, so one clip run through several models reads as a
  // comparison in the history.
  const [audio, setAudio] = useState<{ blob: Blob; url: string; clip: number }>();
  const [recording, setRecording] = useState(false);
  const [audioError, setAudioError] = useState<string>();
  const [history, setHistory] = useState<SttItem[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const clipUrls = useRef<string[]>([]);
  const nextKey = useRef(0);
  const transcribe = QgridService.useTranscribeMutation();
  const openai = isOpenAI(model);

  // History rows keep playing their clips, so blob URLs are freed only when the page unmounts,
  // together with the microphone if a recording is still running.
  useEffect(
    () => () => {
      recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
      clipUrls.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );

  const takeAudio = (blob: Blob) => {
    const url = URL.createObjectURL(blob);

    clipUrls.current.push(url);
    setAudio({ blob, url, clip: clipUrls.current.length });
  };

  const toggleRecording = async () => {
    if (recording) {
      recorderRef.current?.stop();
      setRecording(false);

      return;
    }

    setAudioError(undefined);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];

      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        takeAudio(new Blob(chunks, { type: recorder.mimeType }));
      };

      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch (error) {
      setAudioError(error instanceof Error ? error.message : String(error));
    }
  };

  const submit = async () => {
    if (!audio) return;
    setAudioError(undefined);
    let wav: string;

    try {
      wav = await audioToWavBase64(audio.blob);
    } catch (error) {
      setAudioError(
        `could not decode audio: ${error instanceof Error ? error.message : String(error)}`,
      );

      return;
    }

    const params: TranscribeInput = {
      model,
      audio: wav,
      mediaType: "audio/wav",
      projectName: PROJECT_NAME,
    };

    if (openai && prompt.trim()) params.prompt = prompt.trim();
    const startedAt = performance.now();

    transcribe.mutate(
      { params },
      {
        onSuccess: (out) => {
          const item: SttItem = {
            key: nextKey.current++,
            clip: audio.clip,
            clipUrl: audio.url,
            model,
            prompt: params.prompt,
            text: out.text,
            elapsedMs: performance.now() - startedAt,
            durationSec: out.durationSec,
            requestLogId: out.requestLogId,
            words: out.words,
          };

          setHistory((items) => [item, ...items]);
        },
      },
    );
  };

  return (
    <>
      <div className="flex flex-col gap-3 p-4">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Model">
            <select value={model} onChange={(e) => setModel(e.target.value)} className={CONTROL}>
              {STT_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          {openai && (
            <Field label="Prompt (OpenAI only)">
              <input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="domain words, e.g. qgrid, Kuma"
                className={CONTROL}
              />
            </Field>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={toggleRecording}
            className={`${BUTTON} ${recording ? "bg-danger-500 hover:bg-danger-500" : ""}`}
          >
            {recording ? <SquareIcon className="size-3.5" /> : <MicIcon className="size-3.5" />}
            {recording ? "Stop" : "Record"}
          </button>
          <label className="text-[12px] text-sand-600 cursor-pointer hover:text-sienna-500">
            or upload a file
            <input
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];

                if (file) takeAudio(file);
              }}
            />
          </label>
          {audioError && <p className="text-[12px] text-danger-500 break-words">{audioError}</p>}
        </div>
        {audio && (
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-[11px] font-medium text-sand-500">
              clip {audio.clip}
            </span>
            {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- the user's own recording; transcripts appear below. */}
            <audio controls src={audio.url} className="h-8 w-full" />
          </div>
        )}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={submit}
            disabled={!audio || recording || transcribe.isPending}
            className={BUTTON}
          >
            {transcribe.isPending && <LoaderIcon className="size-3.5 animate-spin" />}
            Transcribe
          </button>
          {transcribe.isError && (
            <p className="text-[12px] text-danger-500 break-words">{transcribe.error?.message}</p>
          )}
        </div>
      </div>
      <div className="border-t border-sand-100">
        <History empty="Transcripts stack here, newest first; run one clip through several models to compare.">
          {history.map((item) => (
            <HistoryRow
              key={item.key}
              title={`clip ${item.clip} · ${shortModel(item.model)}`}
              meta={[
                `${(item.elapsedMs / 1000).toFixed(1)}s`,
                item.durationSec !== undefined ? `${item.durationSec.toFixed(1)}s audio` : "",
                item.prompt ? `prompt: ${item.prompt}` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
              requestLogId={item.requestLogId}
              onRemove={() => setHistory((items) => items.filter((i) => i.key !== item.key))}
            >
              {item.words && item.words.length > 0 ? (
                <TimedPlayer src={item.clipUrl} words={item.words} />
              ) : (
                <p className="rounded-lg bg-sand-50 px-3 py-2 text-[13px] text-sand-800 whitespace-pre-wrap">
                  {item.text || "(empty transcript)"}
                </p>
              )}
            </HistoryRow>
          ))}
        </History>
      </div>
    </>
  );
}

const TABS = [
  { id: "tts", label: "Text to speech" },
  { id: "stt", label: "Speech to text" },
] as const;

export function VoicePlayground() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("tts");

  // Both panels stay mounted (the inactive one is hidden) so switching tabs keeps form state,
  // history, and any running recording.
  return (
    <section className="rounded-xl border border-sand-200/70 bg-white overflow-hidden">
      <div role="tablist" className="flex gap-1 border-b border-sand-100 px-3 pt-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-[13px] transition-colors duration-150 ${
              tab === t.id
                ? "border-sienna-500 font-medium text-sand-800"
                : "border-transparent text-sand-500 hover:text-sand-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" hidden={tab !== "tts"}>
        <TtsPanel />
      </div>
      <div role="tabpanel" hidden={tab !== "stt"}>
        <SttPanel />
      </div>
    </section>
  );
}
