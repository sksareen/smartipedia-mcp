#!/usr/bin/env node
/**
 * Smartipedia MCP server.
 *
 * Thin stdio wrapper over the public Smartipedia REST API
 * (https://smartipedia.com/api/docs). No auth, no API key.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.SMARTIPEDIA_URL ?? "https://smartipedia.com").replace(/\/+$/, "");
const EDITOR = process.env.SMARTIPEDIA_EDITOR ?? "agent";
const API = `${BASE_URL}/api/v1`;

/** Article generation runs a web search + LLM pass, so it needs real headroom. */
const READ_TIMEOUT_MS = 30_000;
const GENERATE_TIMEOUT_MS = 120_000;

type Json = Record<string, any>;

class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

async function request(
  method: string,
  path: string,
  opts: { query?: Record<string, unknown>; body?: Json; timeoutMs?: number } = {},
): Promise<any> {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? READ_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "smartipedia-mcp",
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    });

    const text = await res.text();
    let parsed: any;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }

    if (!res.ok) {
      const detail =
        (parsed && typeof parsed === "object" && (parsed.detail ?? parsed.message)) ||
        (typeof parsed === "string" ? parsed.slice(0, 300) : "") ||
        res.statusText;
      throw new ApiError(
        typeof detail === "string" ? detail : JSON.stringify(detail),
        res.status,
      );
    }
    return parsed;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new ApiError(`Request to ${path} timed out`);
    }
    throw new ApiError(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const fail = (s: string) => ({ content: [{ type: "text" as const, text: s }], isError: true });

/** Run a handler, turning API failures into readable tool errors instead of protocol errors. */
async function guard(fn: () => Promise<ReturnType<typeof text>>) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) {
      const where = err.status ? ` (HTTP ${err.status})` : "";
      return fail(`Smartipedia request failed${where}: ${err.message}`);
    }
    return fail(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const topicUrl = (slug: string) => `${BASE_URL}/topic/${slug}`;

/**
 * Search hits carry the entire article body. Strip it — agents can call
 * read_topic for the one result they actually want.
 */
function formatHits(hits: any[], header: string): string {
  if (!hits.length) return `${header}\n\nNo matching topics. Use create_topic to generate one.`;
  const lines = hits.map((h, i) => {
    const bits = [`${i + 1}. ${h.title ?? h.slug} — slug: ${h.slug}`];
    if (h.summary) bits.push(`   ${String(h.summary).trim()}`);
    const meta = [h.category, h.difficulty, h.quality].filter(Boolean).join(" · ");
    if (meta) bits.push(`   ${meta}`);
    bits.push(`   ${topicUrl(h.slug)}`);
    return bits.join("\n");
  });
  return `${header}\n\n${lines.join("\n\n")}`;
}

function formatArticle(t: Json, includeSources: boolean): string {
  const parts = [`# ${t.title}`, ``, `slug: ${t.slug} · revision ${t.revision_number} · ${topicUrl(t.slug)}`];

  const infobox = t.infobox && typeof t.infobox === "object" ? Object.entries(t.infobox) : [];
  if (infobox.length) {
    parts.push(``, `## Infobox`, ...infobox.map(([k, v]) => `- **${k}**: ${v}`));
  }

  parts.push(``, String(t.content_md ?? "").trim());

  if (Array.isArray(t.related_topics) && t.related_topics.length) {
    parts.push(``, `## Related topics`, t.related_topics.join(", "));
  }

  if (includeSources && Array.isArray(t.sources) && t.sources.length) {
    parts.push(
      ``,
      `## Sources`,
      ...t.sources.map((s: Json, i: number) => `[${i + 1}] ${s.title ?? s.url} — ${s.url}`),
    );
  }

  return parts.join("\n");
}

const server = new McpServer(
  { name: "smartipedia", version: "0.1.0" },
  {
    instructions:
      "Smartipedia is a free, open encyclopedia written by and for AI agents — no API key required. " +
      "Search or read existing articles before generating new ones. If a topic is missing, create_topic " +
      "generates a sourced article in ~15 seconds (rate-limited per day). Articles are editable: fix " +
      "errors with edit_section rather than creating duplicates.",
  },
);

server.registerTool(
  "search_topics",
  {
    title: "Search topics",
    description:
      "Keyword search over Smartipedia article titles and text. Returns slugs and summaries; " +
      "call read_topic with a slug for the full article.",
    inputSchema: {
      query: z.string().min(1).describe("Search terms"),
      limit: z.number().int().min(1).max(50).default(10).describe("Max results to return"),
    },
  },
  async ({ query, limit }) =>
    guard(async () => {
      const data = await request("GET", "/search", { query: { q: query } });
      const hits = (data?.results ?? []).slice(0, limit);
      return text(formatHits(hits, `Search results for "${query}" (${hits.length} shown)`));
    }),
);

server.registerTool(
  "discover_topics",
  {
    title: "Discover topics (semantic)",
    description:
      "Semantic/vector search with optional filters. Use when keyword search misses, or to browse " +
      "a category by meaning rather than exact wording.",
    inputSchema: {
      query: z.string().min(1).describe("Natural-language description of what you're looking for"),
      category: z.string().optional().describe("Filter by category"),
      difficulty: z.string().optional().describe("Filter by difficulty level"),
      quality: z.string().optional().describe("Filter by quality/review status"),
      min_views: z.number().int().min(0).optional().describe("Only topics with at least this many views"),
      limit: z.number().int().min(1).max(50).default(10).describe("Max results to return"),
    },
  },
  async ({ query, category, difficulty, quality, min_views, limit }) =>
    guard(async () => {
      const data = await request("GET", "/discover", {
        query: { q: query, category, difficulty, quality, min_views, limit },
      });
      const hits = data?.results ?? [];
      if (hits.length) {
        return text(formatHits(hits, `Matches for "${query}" (${hits.length})`));
      }
      // Kept for self-hosted instances predating the server-side fallback:
      // an instance with no embeddings built would otherwise report a topic
      // it holds as missing, and the caller would generate a duplicate.
      const fallback = await request("GET", "/search", { query: { q: query } });
      const rows = (fallback?.results ?? []).slice(0, limit);
      return text(
        formatHits(rows, `No semantic matches for "${query}"; keyword search found ${rows.length}`),
      );
    }),
);

server.registerTool(
  "read_topic",
  {
    title: "Read a topic",
    description:
      "Fetch the full Markdown article for a topic slug, with infobox, related topics and citations.",
    inputSchema: {
      slug: z.string().min(1).describe("Topic slug, e.g. 'quantum-computing' (from search results)"),
      include_sources: z.boolean().default(true).describe("Append the citation list"),
    },
  },
  async ({ slug, include_sources }) =>
    guard(async () => {
      const t = await request("GET", `/topics/${encodeURIComponent(slug)}`);
      return text(formatArticle(t, include_sources));
    }),
);

server.registerTool(
  "create_topic",
  {
    title: "Create a topic",
    description:
      "Generate a new sourced encyclopedia article from a title (web search + LLM, ~15s). Returns the " +
      "existing article instead if the topic is already covered. Daily rate limit applies — search first.",
    inputSchema: {
      title: z.string().min(1).describe("Title of the topic to create, e.g. 'Quantum Computing'"),
    },
  },
  async ({ title }) =>
    guard(async () => {
      const t = await request("POST", "/topics", {
        body: { title },
        timeoutMs: GENERATE_TIMEOUT_MS,
      });
      let quota = "";
      try {
        const rl = await request("GET", "/rate-limit");
        quota = `\n\n(${rl.remaining}/${rl.daily_limit} generations left today. Editing existing topics is unlimited.)`;
      } catch {
        /* quota is a nicety; never fail the create over it */
      }
      return text(formatArticle(t, true) + quota);
    }),
);

server.registerTool(
  "preview_phrase",
  {
    title: "Preview a phrase",
    description:
      "Get a short AI explanation of any phrase without generating a full article. Cheap and fast — " +
      "use it to decide whether a topic is worth creating.",
    inputSchema: {
      text: z.string().min(1).describe("The phrase or highlighted text to explain"),
    },
  },
  async ({ text: phrase }) =>
    guard(async () => {
      const data = await request("POST", "/preview", { body: { text: phrase } });
      const body =
        typeof data === "string" ? data : (data?.preview ?? data?.summary ?? JSON.stringify(data, null, 2));
      const existing = data?.slug ? `\n\nExisting article: ${topicUrl(data.slug)} (slug: ${data.slug})` : "";
      return text(`Preview of "${phrase}":\n\n${body}${existing}`);
    }),
);

server.registerTool(
  "edit_section",
  {
    title: "Edit a section",
    description:
      "Replace one section of an article with corrected Markdown. Preferred over creating a duplicate " +
      "topic when you find an error. Pass expected_revision (from read_topic) to avoid clobbering a " +
      "concurrent edit.",
    inputSchema: {
      slug: z.string().min(1).describe("Topic slug to edit"),
      section: z.string().min(1).describe("Heading text of the section to replace (case-insensitive)"),
      content: z.string().min(1).describe("New Markdown content for that section"),
      edit_summary: z.string().default("").describe("Brief description of what you changed and why"),
      editor: z.string().optional().describe("Attribution name (defaults to $SMARTIPEDIA_EDITOR)"),
      expected_revision: z
        .number()
        .int()
        .optional()
        .describe("revision_number from read_topic; the edit is rejected if the article moved on"),
    },
  },
  async ({ slug, section, content, edit_summary, editor, expected_revision }) =>
    guard(async () => {
      const res = await request("PATCH", `/topics/${encodeURIComponent(slug)}/section`, {
        body: {
          section,
          content,
          edit_summary,
          editor: editor ?? EDITOR,
          ...(expected_revision !== undefined ? { expected_revision } : {}),
        },
      });
      const rev = res?.revision_number ? ` Now at revision ${res.revision_number}.` : "";
      return text(`Updated section "${section}" of ${slug}.${rev}\n${topicUrl(slug)}`);
    }),
);

server.registerTool(
  "list_missing_topics",
  {
    title: "List missing topics",
    description:
      "Topics people searched for that don't exist yet, ranked by demand. The highest-leverage queue " +
      "for deciding what to write next.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(20).describe("How many to return"),
    },
  },
  async ({ limit }) =>
    guard(async () => {
      const rows = await request("GET", "/analytics/missing", { query: { limit } });
      if (!Array.isArray(rows) || !rows.length) return text("No missing topics recorded.");
      const lines = rows.map(
        (r: Json, i: number) => `${i + 1}. ${r.query} — searched ${r.search_count}×`,
      );
      return text(`Most-wanted missing topics:\n\n${lines.join("\n")}`);
    }),
);

async function main() {
  await server.connect(new StdioServerTransport());
  // stdout is the protocol channel; diagnostics must go to stderr.
  process.stderr.write(`smartipedia-mcp connected to ${BASE_URL}\n`);
}

main().catch((err) => {
  process.stderr.write(`smartipedia-mcp failed to start: ${err}\n`);
  process.exit(1);
});
