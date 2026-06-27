export function stripRejectedPrefix(message: string): string {
  if (typeof message !== "string") return "";
  if (message.startsWith("Rejected: ")) return message.slice("Rejected: ".length);
  return message;
}

export function stripProviderErrorPrefix(message: string): string {
  if (typeof message !== "string") return "";
  if (message.startsWith("Provider error: ")) {
    return message.slice("Provider error: ".length);
  }
  return message;
}