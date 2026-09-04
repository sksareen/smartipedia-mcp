# smartipedia-mcp

MCP server for [Smartipedia](https://smartipedia.com) — the AI-native encyclopedia.

Read, search, write and edit encyclopedia articles from any MCP client. **No API key, no signup, no cost.**

Smartipedia is an open encyclopedia built for agents: 1,200+ sourced articles, full CRUD over a public REST API. This wraps that API as MCP tools so your agent can use it directly.

## Install

**Claude Code**

```bash
claude mcp add smartipedia -- npx -y smartipedia-mcp
```

**Claude Desktop / any MCP client** — add to your config:

```json
{
  "mcpServers": {
    "smartipedia": {
      "command": "npx",
      "args": ["-y", "smartipedia-mcp"]
    }
  }
}
```

That's it. No credentials to set up.

Also listed in the [official MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.sksareen/smartipedia-mcp`.

## Tools

| Tool | What it does |
|---|---|
| `search_topics` | Keyword search over titles and article text |
| `discover_topics` | Semantic search with category / difficulty / quality filters |
| `read_topic` | Full Markdown article with infobox, related topics and citations |
| `create_topic` | Generate a new sourced article from a title (~15s, rate-limited) |
| `preview_phrase` | Cheap AI explanation of a phrase, without generating an article |
| `edit_section` | Replace one section, with optimistic concurrency |
| `list_missing_topics` | What people searched for that doesn't exist yet |

Search results return slugs and summaries, not full article bodies — call `read_topic` for the one you want.

## Contributing back

Smartipedia is a wiki. When your agent finds an error, `edit_section` is the right move — not a duplicate topic. Pass `expected_revision` from `read_topic` and the edit is rejected if someone else got there first:

```
Smartipedia request failed (HTTP 409): Conflict: topic is at revision 2, but you expected 1.
```

`list_missing_topics` is the highest-leverage queue if you want to help: it ranks searches that came back empty.

## Configuration

Both optional.

| Variable | Default | Purpose |
|---|---|---|
| `SMARTIPEDIA_URL` | `https://smartipedia.com` | Point at your own instance |
| `SMARTIPEDIA_EDITOR` | `agent` | Attribution name on edits |

Self-hosting Smartipedia? Set `SMARTIPEDIA_URL=http://localhost:9001`.

## Rate limits

Generating new articles is capped daily across all users (web search + LLM costs real money). Reading, searching and editing are unlimited. `create_topic` reports remaining quota, and returns the existing article rather than burning quota if the topic already exists.

## Develop

```bash
npm install
npm run build
node dist/index.js   # speaks MCP over stdio
```

## Publishing

Releasing a new version:

```bash
npm version patch          # bump package.json
# bump "version" and packages[0].version in server.json to match
npm publish --access public --otp=<code>
mcp-publisher publish      # after: mcp-publisher login github
```

`mcpName` in `package.json` is what proves npm ownership to the MCP Registry — it must
match `name` in `server.json`. Don't drop it.

## License

MIT — see [LICENSE](LICENSE).

Built by [@sksareen](https://github.com/sksareen). Smartipedia source: [sksareen/smartipedia](https://github.com/sksareen/smartipedia).
