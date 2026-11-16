# pi-scrapling

Pi Agent integration for [Scrapling](https://scrapling.readthedocs.io) — a Python web-scraping framework with stealth browsers, adaptive parsers, and concurrent spiders.

Installing this package gives Pi two things:

| Layer | Where it comes from | What it does |
|---|---|---|
| **Agent skill** `scrapling-official` | bundled in `skills/scrapling-official/` | The upstream Scrapling Agent Skill — `SKILL.md` + 12 reference docs (~150 KB) + 4 runnable examples. Pi implements the [Agent Skills specification](https://agentskills.io/specification), so the upstream skill loads unmodified. This is what teaches the agent the current Scrapling API. |
| **MCP server** `scrapling` | registered by `extensions/scrapling.ts` | The 16 Scrapling MCP tools as first-class Pi tools: `make_request`, `browser_fetch`, `browser_open`, `browser_actions`, `browser_screenshot`, `browser_extract`, `browser_save_state`, `browser_load_state`, `session_make_request`, `open_request_session`, `close_session`, `list_sessions`, and more. |

## Install

There is one command for everything. The bundled CLI (`pi-scrapling`) handles Python venv creation, pip install, browser install, and the Pi package install in one go.

### One-liner

```bash
node ./scripts/cli.mjs install        # from a checkout
# or, after `npm install -g pi-scrapling`:
pi-scrapling install                  # from anywhere
```

What it does:

1. creates a Python venv at `~/.venvs/scrapling` (`~/venvs/scrapling` on Windows)
2. installs `scrapling[all]>=0.5` plus its MCP extras (~70 MB)
3. downloads the Playwright browser cache (`scrapling install --force`, a few hundred MB)
4. runs `pi install` against this package so Pi discovers the skill + extension

`update`, `remove`, and `doctor` round out the lifecycle:

```bash
pi-scrapling update               # pip upgrade + browser refresh + pi reconcile
pi-scrapling doctor               # prints status of every component
pi-scrapling remove               # pi uninstall; venv kept
pi-scrapling remove --purge-venv  # also delete the venv after prompting
```

Flags (apply where relevant):

| Flag | Effect |
|---|---|
| `--venv-dir <path>` | override the venv location (default `~/.venvs/scrapling`) |
| `--source <path\|npm:\|git:>` | override the Pi install source (default: this package's root, resolved via `import.meta.url`) |
| `--skip-browser` | skip `scrapling install --force` (saves a few hundred MB; stealth fetches won't work until you run it) |
| `--purge-venv` | on `remove`, also delete the venv (prompts unless `--yes`) |
| `--reconcile-user-mcp` | opt-in: rewrite `~/.pi/agent/mcp.json`, removing any one-key `{command: "scrapling-mcp"}` stale entry with a timestamped `<path>.bak.<UTC>` snapshot. Configured entries with extra fields are NOT touched. Default: skip. |
| `--yes, -y` | answer yes to prompts |

### npm-script shortcuts

From the checkout, these wrap the same underlying `scripts/cli.mjs`:

```bash
npm run setup            # full install (with browser)
npm run setup:no-browser # install but skip browser
npm run setup:update
npm run setup:remove
npm run setup:purge      # remove --purge-venv --yes
npm run setup:doctor
```

### Manual install (only if the CLI doesn't fit your flow)

```bash
python3 -m venv ~/.venvs/scrapling
source ~/.venvs/scrapling/bin/activate
pip install --upgrade "scrapling[all]>=0.5"
scrapling install --force

pi install /absolute/path/to/pi-scrapling
```

If you'd rather run Scrapling from Docker, the upstream docs cover [`pyd4vinci/scrapling`](https://hub.docker.com/r/pyd4vinci/scrapling) — point the MCP `command` at your docker wrapper via the `SCRAPLING_MCP_COMMAND` env var or a `mcp.json` override.

### Verify

```bash
pi list                # pi-scrapling is listed
pi mcp list            # scrapling: connected, ~16 tools
pi-scrapling doctor    # one-shot status check across Python, venv, browser, Pi
```

Start a fresh Pi session — extensions load at startup, so a running session won't see new state. `/reload` works for the extension; fresh start is the reliable check.

## If the extension still can't find `scrapling-mcp`

The extension's resolution chain covers the common cases out of the box:

1. `SCRAPLING_MCP_COMMAND` env var (full path or command name) — explicit override wins.
2. `scrapling-mcp` on `PATH` (the upstream install style).
3. `SCRAPLING_MCP_VENV_DIR` env var → `<venv>/bin/scrapling-mcp` (or `Scripts\scrapling-mcp.exe` on Windows).
4. `~/.config/pi-scrapling/config.json` (`%APPDATA%\pi-scrapling\config.json` on Windows), which `pi-scrapling install|update` writes so non-default `--venv-dir` is remembered.
5. Canonical defaults: `~/.venvs/scrapling`, `~/venvs/scrapling`, `./.venv`, `./venv`.

If you have an unusual layout none of those probe, force a specific binary with one of:

```bash
# point the bundled extension at the binary without touching PATH
export SCRAPLING_MCP_COMMAND="$HOME/.venvs/scrapling/bin/scrapling-mcp"

# or tell Pi directly (an mcp.json entry overrides what the extension registered)
pi mcp add scrapling -- "$HOME/.venvs/scrapling/bin/scrapling-mcp"
```

A `scrapling` entry in `mcp.json` always wins over the extension's registration and is shown as an override in `/mcp`.

When no candidate resolves, the extension registers the server as **disabled** (instead of failing the probe at every startup) and `/mcp` lists the gap with a one-line hint.

## Project layout

```
pi-scrapling/
├── extensions/
│   └── scrapling.ts                  # registers the MCP server; reads ~/.config/pi-scrapling/config.json
├── skills/
│   └── scrapling-official/           # upstream skill, vendored verbatim
│       ├── SKILL.md
│       ├── LICENSE.txt
│       ├── references/  (parsing, fetching, spiders, integrations, MCP, RAG)
│       └── examples/    (4 runnable Python scripts)
├── scripts/
│   ├── cli.mjs                       # install/update/remove/doctor CLI; bin: "pi-scrapling"
│   ├── dev-prune-mcp.mjs             # maintainer-only tool; npm run dev:prune-mcp
│   ├── mcp-json.mjs                  # shared JSON IO + log helpers (extracted to dedupe)
│   ├── platform-paths.mjs            # shared configFilePath() (extension + CLI)
│   ├── platform-paths.d.mts          # type declarations for the above
│   └── validate.mjs                  # `npm run validate` static-check harness
├── package.json                      # pi-package + npm-bin manifest
├── tsconfig.json                     # typecheck only, not shipped
└── README.md
```

`scripts/platform-paths.mjs` and `scripts/mcp-json.mjs` are bundled so a
maintainer only ever has to change one copy. The dev-only prune tool
(`npm run dev:prune-mcp`) is intentionally not exposed as a CLI subcommand;
see § For maintainers.

## Development

```bash
npm run validate        # manifest, resource paths, bin entry, CLI syntax
npm pack --dry-run      # inspect the published tarball
node ./scripts/cli.mjs doctor   # quick local status check
```

Typechecking needs the host Pi package and Node types linked locally:

```bash
mkdir -p node_modules/@earendil-works
ln -sfn "$(npm root -g)/@earendil-works/pi-coding-agent" node_modules/@earendil-works/pi-coding-agent
ln -sfn /path/to/@types node_modules/@types
npx tsc --noEmit
```

Local subcommand development:

```bash
node ./scripts/cli.mjs --help
node ./scripts/cli.mjs install --source "$(pwd)" --venv-dir /tmp/test-venv --skip-browser
node ./scripts/cli.mjs doctor --venv-dir /tmp/test-venv
node ./scripts/cli.mjs remove --source "$(pwd)" --venv-dir /tmp/test-venv --purge-venv --yes
```

## Maintenance

When Scrapling publishes a new release:

1. Download `https://github.com/D4Vinci/Scrapling/raw/main/agent-skill/Scrapling-Skill.zip`.
2. Replace the contents of `skills/scrapling-official/`.
3. Bump `version` in `package.json`.
4. If the MCP tool list changed, update the `DESCRIPTION` in `extensions/scrapling.ts`.

The `scrapling-mcp` command name has been stable; if upstream renames it, change `DEFAULT_COMMAND` in the extension and note the old name in the migration section.

**Treat `--reconcile-user-mcp`'s match predicate as a public contract.** Changing what counts as a "stale entry" (currently a one-key `{command: "scrapling-mcp"}`) is a user-facing behavior change, not a refactor — call it out in the changelog.

## For maintainers (not part of the public CLI)

```bash
npm run dev:prune-mcp                    # actually prune
npm run dev:prune-mcp -- --dry-run       # show what would be pruned
HYGIENE=plan npm run dev:prune-mcp       # same as --dry-run, env-driven
```

These reach into `<pkg>/.pi/mcp.json` — Pi's runtime overlay inside the package directory. End users running a global install never have that file; this script is intentionally NOT exposed as a `pi-scrapling` subcommand. Use it when cleaning up a local dev checkout after a Pi session toggle left an orphan override fragment behind.

## Why not a subagent or native tools?

- **No subagent.** The skill plus MCP already cover the parent agent's palette. A specialist subagent mostly added routing ambiguity for single-shot scrapes the parent can do inline.
- **No native TypeScript tools.** The MCP server is the upstream-supported interface and the single source of truth. A parallel implementation would duplicate 16 tools and drift from upstream releases.
- **No `mcp.json` in the package.** Pi packages cannot ship MCP entries; they deliver extensions, skills, prompts, and themes only. The extension registers the server at load time instead, so installation stays a single command.