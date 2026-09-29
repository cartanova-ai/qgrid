import { type QgridContent } from "@/services/qgrid/qgrid.types";

type HistoryMessage = { role: "user" | "assistant"; text: string; images?: string[] };

export function buildChatHistory(messages: HistoryMessage[], includeImages: boolean): unknown[] {
  return messages.flatMap((message): unknown[] => {
    const images = includeImages ? (message.images ?? []) : [];
    if (message.role === "user") {
      return [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: message.text },
            ...images.map((url) => ({ type: "input_image", image_url: url })),
          ],
        },
      ];
    }
    return [
      ...(message.text
        ? [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: message.text }],
            },
          ]
        : []),
      // Generated images become visual references, not assistant input_image parts.
      ...(images.length
        ? [
            {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "Previously generated assistant images (reference for follow-up edits):",
                },
                ...images.map((url) => ({ type: "input_image", image_url: url })),
              ],
            },
          ]
        : []),
    ];
  });
}

export function chatGeneratedImages(content: QgridContent[]): string[] {
  return content.flatMap((part) =>
    part.type === "image" ? [`data:${part.mediaType ?? "image/png"};base64,${part.data}`] : [],
  );
}
