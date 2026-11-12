// The OpenAI transcription route accepts only PCM16 WAV or raw PCM, and browser recordings arrive
// as webm/opus. Every recording or upload is therefore decoded and re-encoded as mono PCM16 WAV
// before it is sent; Grok accepts the same WAV.
export const VOICE_SAMPLE_RATE = 24_000;

/** Mono PCM16 WAV from float samples in [-1, 1]; out-of-range samples are clipped. */
export function encodeWav(samples: Float32Array, sampleRate = VOICE_SAMPLE_RATE): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(out.buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);

  samples.forEach((sample, i) => {
    const clipped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true);
  });

  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";

  // Chunked so String.fromCharCode never receives more arguments than the engine allows.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }

  return btoa(binary);
}

/** Decodes any browser-playable audio, mixes it to mono at 24 kHz, and returns base64 WAV. */
export async function audioToWavBase64(blob: Blob): Promise<string> {
  const context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });

  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    const mono = new Float32Array(buffer.length);

    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel);

      for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
    }

    return bytesToBase64(encodeWav(mono));
  } finally {
    await context.close();
  }
}
