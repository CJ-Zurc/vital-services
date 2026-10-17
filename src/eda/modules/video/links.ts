import { createHash } from "node:crypto";

export type MeetingProviderValue = "gmeet";

function stripTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function normalizeMeetingUrl(value: string) {
  try {
    const parsed = new URL(value.trim());
    parsed.hash = "";
    if (parsed.protocol !== "https:") return null;
    parsed.hostname = parsed.hostname.toLowerCase();
    return stripTrailingSlash(parsed.toString());
  } catch {
    return null;
  }
}

export function hashMeetingUrl(normalizedUrl: string) {
  return createHash("sha256").update(normalizedUrl).digest("hex");
}

export function validateMeetingUrl(provider: string, url: string) {
  if (provider.toLowerCase() !== "gmeet") {
    return { valid: false, normalizedUrl: null, urlHash: null, message: "Only Google Meet is supported." };
  }

  const normalizedUrl = normalizeMeetingUrl(url);
  if (!normalizedUrl) {
    return { valid: false, normalizedUrl: null, urlHash: null, message: "Meeting link must be a valid HTTPS URL." };
  }

  const parsed = new URL(normalizedUrl);
  if (parsed.username || parsed.password || parsed.port) {
    return { valid: false, normalizedUrl, urlHash: null, message: "Meeting link must not include credentials or a custom port." };
  }
  if (parsed.hostname !== "meet.google.com") {
    return { valid: false, normalizedUrl, urlHash: null, message: "Meeting link must use meet.google.com." };
  }

  if (!/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(parsed.pathname)) {
    return { valid: false, normalizedUrl, urlHash: null, message: "Google Meet link must look like https://meet.google.com/abc-defg-hij." };
  }

  return { valid: true, normalizedUrl, urlHash: hashMeetingUrl(normalizedUrl), message: null };
}
