export function estimateTokens(text: string): number {
  if (!text || text.trim() === "") return 0;
  return Math.max(1, Math.ceil(text.trim().length / 4));
}
