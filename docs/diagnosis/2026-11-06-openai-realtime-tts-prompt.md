# OpenAI realtime TTS prompt — 2026-11-06

Account: the user's ChatGPT Pro subscription token from `~/.codex/auth.json`. Voice `marin`. Runner: an uncommitted script that drives the direct realtime socket with the protocol helpers from `openai-realtime-protocol.ts` (headers, `buildSpeechSession`, events) and swaps only the system prompt and the user item. Fidelity is judged from the model's own `response.output_audio_transcript.done`: word error ≤ 5 % and no spoken `script` tag counts as verbatim. That catches answering and reading the prompt aloud. It does not catch garbled pronunciation (see "Separate observation").

## Problem

The realtime models are conversational. With the original one-sentence prompt ("You are a text-to-speech engine. … Do not answer, add, omit, translate, or comment.") and the raw text as the user item, `gpt-realtime-2.1` answered character-chat lines that ask the listener a question. For "I'm Sasha, really nice to meet you. Son is such an adorable name for a poodle, does it mean something special?" it said "Hi Sasha, it's lovely to meet you too! …". It also answered the statement "No, I was just wondering about you." once. The 2026-10-17 matrix used statements only, so it did not catch this.

## Variants

- **V0**: the original prompt, raw text as the user item.
- **V1**: V0 plus a delimited user item, `Read the text inside <script> aloud exactly.\n<script>{text}</script>`.
- **V2**: the system prompt now in `SPEECH_SYSTEM_PROMPT`, with labeled `# Role & Objective` / `# Rules` / `# Examples` sections, capitalized never-answer rules and two sample exchanges. The user item is `<script>{text}</script>` only.

Six English character lines (greeting question, long self-introduction ending in a question, correction sentence, excited question, numbers and place names, hesitant question) × 3 variants × 2 models × 2 repetitions = 72 runs.

## Results

| Model | Variant | Verbatim | First audio (median, incl. ~1 s connect) | Mean reasoning tokens | Mean cost per line (API prices) |
| --- | --- | --- | --- | --- | --- |
| `gpt-realtime-2.1` | V0 | 5/12 | 2.70 s | 83 | $0.0163 |
| `gpt-realtime-2.1` | V1 | 10/12 | 2.69 s | 93 | $0.0135 |
| `gpt-realtime-2.1` | V2 | **12/12** | 2.19 s | 13 | $0.0111 |
| `gpt-realtime-2.1-mini` | V0 | 12/12 | 2.11 s | 22 | $0.0030 |
| `gpt-realtime-2.1-mini` | V1 | 11/12 | 2.21 s | 38 | $0.0031 |
| `gpt-realtime-2.1-mini` | V2 | **12/12** | 2.08 s | 18 | $0.0030 |

- V0 failures on 2.1 were all answers (greeting ×2, self-introduction ×2, correction, numbers, hesitant).
- V1 failures were the model reading the user-item instruction and tags aloud (2.1 ×2, mini ×1). Instructions must stay in the system prompt.
- V2 also cut 2.1's reasoning tokens, which shortened first audio and lowered cost even though the longer system prompt roughly tripled input tokens.

After the change, the production `OpenAIVoiceClient.speak()` was run on the same six lines with caller instructions (a London-accent style, appended as `# Style`): 6/6 verbatim on both `gpt-realtime-2.1` and `gpt-realtime-2.1-mini`.

## Separate observation (V0, same day)

On the 2026-10-17 mixed Korean/English text, `gpt-realtime-2.1-mini` reported a verbatim transcript in 2/2 runs, but neither `gpt-4o-transcribe` nor `gpt-transcribe` could recover the English half of the audio. `gpt-realtime-2.1` was intelligible. A matching transcript therefore does not prove intelligible audio for mixed-language text. This was not re-run with V2.

## Sources for the prompt structure

- OpenAI Realtime Prompting Guide: https://developers.openai.com/cookbook/examples/realtime_prompting_guide (labeled sections, capitalized emphasis, sample phrases).
- OpenAI prompt engineering guide, "Message formatting with Markdown and XML": https://developers.openai.com/api/docs/guides/prompt-engineering (XML tags to delimit content).

The exact wording, including the `<script>` tag name, the rules and the examples, was written for this experiment. There is no official text-to-speech mode for realtime models.

## Not exercised

- `gpt-realtime-1.5` with V2.
- Korean-only and mixed-language text with V2.
- Repeated runs beyond 12 per model and variant. 12/12 is not a zero failure rate, so keep comparing the logged transcript with the input when fidelity matters.
