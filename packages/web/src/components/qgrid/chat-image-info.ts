export function chatImageInfo(url: string): { extension: string; bytes: number } {
  const comma = url.indexOf(",");
  const mime = url.slice(0, comma).match(/^data:image\/(png|jpeg|webp);base64$/)?.[1];
  if (!mime) return { extension: "—", bytes: 0 };
  const padding = url.endsWith("==") ? 2 : url.endsWith("=") ? 1 : 0;
  return {
    extension: mime === "jpeg" ? "jpg" : mime,
    bytes: Math.max(0, Math.floor(((url.length - comma - 1) * 3) / 4) - padding),
  };
}

export function formatImageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
