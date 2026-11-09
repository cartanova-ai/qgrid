# GPT-Image-2.6 subscription-route probe — 2026-11-09

Context: OpenAI released Images 2.6 on 2026-11-04 (ChatGPT and Codex, all tiers; API ids `gpt-image-2.6-flare` / `gpt-image-2.6-sunburst`; new `complexity`, GIF, SVG, and markup features). This probe checks what changed on the private routes qgrid uses. The local Codex sign-in (Pro) was used and qgrid's real identity headers were imported. No qgrid source was changed. Tokens and auth headers were not saved.

## Standalone Images (`/backend-api/codex/images/generations`)

All requests used the same prompt, `quality: low`, and `size: 1024x1024`.

| Probe | Extra fields | HTTP | Result |
|---|---|---|---|
| invalid-model | `model: qgrid-invalid-image-model-control` | 200 | PNG 1536x1024, usage 21/343 |
| gpt-image-2 | — | 200 | same |
| gpt-image-2.6-flare | `model: gpt-image-2.6-flare` | 200 | same |
| gpt-image-2.6-sunburst | `model: gpt-image-2.6-sunburst` | 200 | same |
| complexity-low | `complexity: low` | 200 | same |
| complexity-bogus | `complexity: bogus-value` | 200 | same (field ignored) |
| gif | `output_format: gif, frame_count: 2, frame_duration_ms: 200` | 400 | `GIF output is not enabled for this request.` |

- The model id is still not selectable. A nonexistent id succeeds with identical usage, which was the D5 re-check condition. Exposing `openai/gpt-image-2.6-*` would only be a label.
- `complexity` is ignored on this route; even an invalid value is accepted.
- The size request was overridden: 1024x1024 returned 1536x1024 in every case.
- Responses no longer include a model field. New response fields since the 2026-09-09 probe: `safety_identifier` and per-image `generation_id`.
- New quota headers: `x-codex-active-limit: imagegen_premium` with a 1440-minute primary window. This looks like a separate daily image bucket, which qgrid's quota reader does not yet track. It is reported here only, not analyzed.
- GIF is blocked by a server-side gate. The 400 arrives in 0.18 s without any quota headers. A retry with the `x-codex-image-turn-id` header Codex sends (random UUID) got the same 400. The current Codex source (`codex-api/src/images.rs`, commit f9e7b19df, 2026-11-03) sends exactly this body shape. It enables GIF only behind a client feature, `image_generation_animation` (stage UnderDevelopment, default off). Its only other image header is optional turn metadata (`ext/image-generation/src/backend.rs`). So with qgrid's identity headers plus the turn id, the gate looks like an account or rollout decision on the backend.

## Hosted Responses `image_generation` tool (`/backend-api/codex/responses`, driver `gpt-6-astra`)

| Tool request | Driver `reasoning.effort` | Result |
|---|---|---|
| forced tool, image model flare, quality low or medium | low | failed: `Complexity 'low' is not supported for this image model.` (`param: complexity`) |
| same | medium | failed: `Complexity 'medium' ...` |
| same | high | failed: `Complexity 'high' ...` |
| same | (no `reasoning` field) | success; tools echo `model: gpt-image-2-codex`; image 1254x1254, quality low |
| qgrid shape: `{type: image_generation}`, `tool_choice: auto` | low | failed: `Complexity 'low' ...` |

- The backend passes the driver's reasoning effort to the hosted image tool as `complexity`. The effective tool model `gpt-image-2-codex` rejected low, medium, and high; xhigh/max and a summary-only `reasoning` block were not tested. A hosted image request carrying one of those efforts fails after `image_generation_call.generating`.
- Today this breaks qgrid's raw explicit chat-model route (`imageGeneration: true`, non-transparent) whenever the caller passes `effort` or `thinking: true` (`openai-dispatcher.ts` `asReasoning` → `requestOptions`). Requests without effort still work. Dashboard auto chat and SDK `generateImage` use standalone Images and are unaffected. When it started is unknown. The successful 2026-09-10 hosted probes echoed `effort: medium`, but their request bodies were not saved, so that may have been the server default rather than an explicit effort.
- The echoed effective model is still `gpt-image-2-codex`. It does not identify 2.6.

## Serving version

C2PA `softwareAgent` on every new PNG is `{name: "ChatGPT", version: "gpt-image"}`. It is unchanged since 2026-10-05 and carries no version number. The claim generator is still OpenAI Media Service API with c2pa_rs 0.79.2. Neither the responses, headers, nor provenance identify whether 2.6 serves these routes. OpenAI states that Images 2.6 is in Codex on all tiers, and Codex still requests `gpt-image-2`. So a server-side default upgrade is plausible but not observed. Latency (10–15 s at low quality) is not model evidence.

## Not probed

Markup (edits only; needs an overlay PNG), SVG output, `n > 1`, and quality `xhigh`/`max`.

## Resolution

qgrid now sends explicit chat-model `imageGeneration: true` requests to standalone Images for every background. It no longer registers or parses the hosted `image_generation` tool. These requests are PNG-only, run no text driver, and ignore driver effort.

Artifacts (local, not committed): `output/gpt-image-2-6-probe-2026-11-09/`. Each probe has a JSON record with the request, status, kept headers, response (image bytes replaced by their length), and provenance, plus the original image bytes.
