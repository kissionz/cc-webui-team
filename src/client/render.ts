import type { HtmlValue } from "./types.js";

export function escapeHtml(value: HtmlValue): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

export function safeText(value: HtmlValue, fallback = ""): string {
  const text = String(value ?? fallback).replace(/\s+/gu, " ").trim();
  return text || fallback;
}
