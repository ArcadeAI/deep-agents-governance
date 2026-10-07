/**
 * Reading the repo's Markdown the way GitHub renders it: prose lines outside
 * fenced code, headings, their anchors, and link targets. `readme.test.ts`
 * holds the README to Mastra's outline with these, and `docs-links.test.ts`
 * holds every page under `docs/` to the same link rules (#58), so both read the
 * text one way.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** The lines outside fenced code blocks, with their 1-based line numbers. */
export function proseLines(markdown: string): Array<{ n: number; text: string }> {
  const lines: Array<{ n: number; text: string }> = [];
  let fenced = false;
  markdown.split("\n").forEach((text, i) => {
    if (/^\s*```/.test(text)) {
      fenced = !fenced;
      return;
    }
    if (!fenced) lines.push({ n: i + 1, text });
  });
  return lines;
}

export function headings(markdown: string): Array<{ level: number; title: string }> {
  return proseLines(markdown).flatMap(({ text }) => {
    const match = /^(#{1,6}) (.+?)\s*$/.exec(text);
    return match ? [{ level: match[1]!.length, title: match[2]! }] : [];
  });
}

/** The text under one H2, up to the next H2. */
export function section(markdown: string, title: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line === `## ${title}`);
  if (start === -1) return "";
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

/** GitHub's heading anchors: lowercased, punctuation and emoji dropped, spaces to hyphens, repeats suffixed. */
export function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const found = new Set<string>();
  for (const { title } of headings(markdown)) {
    const base = title
      .replace(/`/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    found.add(count === 0 ? base : `${base}-${count}`);
  }
  return found;
}

export function links(markdown: string): string[] {
  return proseLines(markdown).flatMap(({ text }) => [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]!));
}

/** Relative links in `markdown`, read as the file `from`, whose file, or whose anchor in that file, does not exist. */
export function brokenRelativeLinks(markdown: string, from: string): string[] {
  return links(markdown).flatMap((target) => {
    if (/^(https?:|mailto:)/.test(target)) return [];
    const [path, anchor] = target.split("#") as [string, string | undefined];
    const file = path === "" ? from : resolve(dirname(from), path);
    if (!existsSync(file)) return [`${target}: no such file`];
    if (anchor === undefined) return [];
    if (statSync(file).isDirectory() || !file.endsWith(".md")) return [`${target}: an anchor into something that is not Markdown`];
    const text = file === from ? markdown : readFileSync(file, "utf8");
    return anchors(text).has(anchor) ? [] : [`${target}: no heading with that anchor`];
  });
}
