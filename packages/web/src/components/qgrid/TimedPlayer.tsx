import { useEffect, useRef, useState } from "react";

export type TimedWord = { text: string; start: number; end: number };

/**
 * Audio player with the timed words under it; the word being spoken is highlighted. The current
 * time is read every animation frame while playing, since timeupdate fires only about 4 times a
 * second and short words would be skipped; timeupdate still feeds it when frames are throttled.
 */
export function TimedPlayer({
  src,
  words,
  autoPlay,
  className = "h-8 w-full",
}: {
  src: string;
  words?: TimedWord[];
  autoPlay?: boolean;
  /** Classes for the audio element. */
  className?: string;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const frame = useRef(0);
  const [time, setTime] = useState(-1);

  const tick = () => {
    setTime(audioRef.current?.currentTime ?? -1);
    frame.current = requestAnimationFrame(tick);
  };

  const stop = () => cancelAnimationFrame(frame.current);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  return (
    <>
      {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- the words are rendered under the player. */}
      <audio
        ref={audioRef}
        controls
        autoPlay={autoPlay}
        src={src}
        className={className}
        onPlay={() => {
          stop();
          tick();
        }}
        onPause={stop}
        // Fallback when animation frames are throttled (hidden tab or webview).
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onEnded={() => {
          stop();
          setTime(-1);
        }}
      />
      {words && words.length > 0 && (
        <p className="flex flex-wrap gap-x-0.5 gap-y-1 text-[13px] leading-relaxed">
          {words.map((word, i) => (
            <button
              key={i}
              type="button"
              // Clicking a word plays from its start.
              onClick={() => {
                const audio = audioRef.current;

                if (!audio) return;
                audio.currentTime = word.start;
                setTime(word.start);
                void audio.play();
              }}
              title={`${word.start.toFixed(2)}–${word.end.toFixed(2)}s · play from here`}
              className={`rounded px-1 transition-colors duration-75 ${
                time >= word.start && time < word.end
                  ? "bg-sienna-500 text-white"
                  : "text-sand-700 hover:bg-sand-100"
              }`}
            >
              {word.text}
            </button>
          ))}
        </p>
      )}
    </>
  );
}
