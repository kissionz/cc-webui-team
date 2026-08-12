import type { HtmlValue } from "./types.js";
import { escapeHtml } from "./render.js";

function inline(value: HtmlValue): string {
  return String(value ?? "").split(/(`[^`]*`)/g).map((part) => {
    if (part.startsWith("`") && part.endsWith("`")) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
    return escapeHtml(part).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  }).join("");
}

function cells(line: string): string[] { return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()); }
function tableSeparator(line: string): boolean { const row = cells(line); return row.length > 1 && row.every((cell) => /^:?-{3,}:?$/.test(cell)); }
function table(lines: string[]): string {
  const header = cells(lines[0]); const rows = lines.slice(2).map(cells).filter((row) => row.some(Boolean));
  return `<div class="markdown-table-wrap"><table class="markdown-table"><thead><tr>${header.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${header.map((_, index) => `<td>${inline(row[index] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function blocks(text: HtmlValue): string {
  const lines = String(text || "").split(/\r?\n/); const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    if (!lines[index].trim()) { index += 1; continue; }
    if (lines[index].includes("|") && lines[index + 1] && tableSeparator(lines[index + 1])) {
      const values = [lines[index], lines[index + 1]]; index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) values.push(lines[index++]);
      output.push(table(values)); continue;
    }
    const heading = lines[index].match(/^(#{1,4})\s+(.+)$/);
    if (heading) { output.push(`<h${Math.min(heading[1].length + 2, 5)}>${inline(heading[2])}</h${Math.min(heading[1].length + 2, 5)}>`); index += 1; continue; }
    if (/^>\s?/.test(lines[index])) { const quote: string[] = []; while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, "")); output.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`); continue; }
    const task = /^\s*[-*]\s+\[[ xX]\]\s+/;
    if (task.test(lines[index])) { const items: string[] = []; while (index < lines.length && task.test(lines[index])) { const line = lines[index++]; items.push(`<li><input type="checkbox" disabled ${/\[[xX]\]/.test(line) ? "checked" : ""}>${inline(line.replace(task, ""))}</li>`); } output.push(`<ul class="task-list">${items.join("")}</ul>`); continue; }
    const unordered = /^\s*[-*]\s+/; const ordered = /^\s*\d+\.\s+/;
    if (unordered.test(lines[index]) || ordered.test(lines[index])) { const pattern = unordered.test(lines[index]) ? unordered : ordered; const tag = pattern === unordered ? "ul" : "ol"; const items: string[] = []; while (index < lines.length && pattern.test(lines[index])) items.push(lines[index++].replace(pattern, "")); output.push(`<${tag}>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</${tag}>`); continue; }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !(lines[index].includes("|") && lines[index + 1] && tableSeparator(lines[index + 1])) && !unordered.test(lines[index]) && !ordered.test(lines[index])) paragraph.push(lines[index++]);
    output.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
  }
  return output.join("");
}

export function renderMarkdown(text: HtmlValue): string {
  const chunks = String(text || "").split(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g);
  let html = "";
  for (let index = 0; index < chunks.length; index += 1) {
    if (index % 3 === 0) html += blocks(chunks[index]);
    if (index % 3 === 2) html += `<div class="markdown-code-wrap"><button class="code-copy" data-copy-code="${escapeHtml(encodeURIComponent(chunks[index]))}">复制</button><pre class="markdown-code"><code>${escapeHtml(chunks[index])}</code></pre></div>`;
  }
  return html;
}
