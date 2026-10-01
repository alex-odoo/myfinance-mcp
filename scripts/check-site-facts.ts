/**
 * Deploy gate for the static site: product facts are hand-copied across
 * ~16 pages, llms.txt and the README, and a release used to leave some of
 * them stale (the blog said 27 tools, the privacy page a 6-digit code).
 * Each fact is read from the code and every public text is checked
 * against it. Usage: bun run check:site
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const problems: string[] = [];

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path, ext) : ext.test(name) ? [path] : [];
  });
}

const pages = files("site", /\.html$/);
const texts = [...pages, "site/llms.txt", "README.md", "SECURITY.md"].map((path) => ({
  path,
  body: readFileSync(path, "utf8"),
}));

// 1. Tool count = registered tools
const tools = (readFileSync("src/tools.ts", "utf8").match(/server\.registerTool\(\s*"/g) ?? []).length;
for (const { path, body } of texts) {
  for (const m of body.matchAll(/\b(\d+) (?:finance )?tools\b/gi)) {
    if (Number(m[1]) !== tools) problems.push(`${path}: "${m[0]}" but the server registers ${tools} tools`);
  }
}

// 2. Email sign-in code length = EMAIL_CODE_DIGITS
const digits = Number(readFileSync("src/oauth/provider.ts", "utf8").match(/EMAIL_CODE_DIGITS = (\d+)/)?.[1]);
if (!digits) problems.push("src/oauth/provider.ts: EMAIL_CODE_DIGITS not found");
for (const { path, body } of texts) {
  for (const m of body.matchAll(/\b(\d+)-digit\b/g)) {
    if (Number(m[1]) !== digits) problems.push(`${path}: "${m[0]}" but sign-in codes have ${digits} digits`);
  }
}

// 3. Claims retired because they stopped being true
const RETIRED = [
  ["row-level isolation", "isolation is server-side per query, the RLS is deny-all"],
  ["encrypted tokens", "sign-in tokens are hashed; only bank tokens are encrypted"],
  ["30+ currencies", "150+ since the FX fallback (0.14.0)"],
  ["with your Google account", "email sign-in exists since 0.14.0"],
];
for (const { path, body } of texts) {
  for (const [phrase, why] of RETIRED) {
    if (body.toLowerCase().includes(phrase!)) problems.push(`${path}: "${phrase}" (${why})`);
  }
}

// 4. FAQ structured data says what the visible FAQ says
const decode = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/<[^>]+>/g, "").trim();
for (const path of pages) {
  const html = readFileSync(path, "utf8");
  for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let data: { "@type"?: string; mainEntity?: Array<{ name: string; acceptedAnswer: { text: string } }> };
    try {
      data = JSON.parse(block[1]!);
    } catch {
      problems.push(`${path}: JSON-LD does not parse`);
      continue;
    }
    if (data["@type"] !== "FAQPage") continue;
    const visible = new Map(
      [...html.matchAll(/<summary>([\s\S]*?)<\/summary>\s*<p class="fa">([\s\S]*?)<\/p>/g)].map((m) => [
        decode(m[1]!),
        decode(m[2]!),
      ])
    );
    for (const q of data.mainEntity ?? []) {
      const answer = visible.get(q.name);
      if (answer === undefined) problems.push(`${path}: FAQ JSON-LD question "${q.name}" is not on the page`);
      else if (answer !== decode(q.acceptedAnswer.text)) problems.push(`${path}: FAQ answer to "${q.name}" differs from its JSON-LD`);
    }
  }
}

if (problems.length) {
  console.error(`Site facts out of date (${problems.length}):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`site facts ok: ${texts.length} texts, ${tools} tools, ${digits}-digit codes`);
