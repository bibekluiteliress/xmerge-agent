# XMerge Studio

Ask for a client report in plain words; Claude designs it, fills in the XPLAN fields and checks it.
You edit it inline, merge it for a client on an XPLAN site to see the real document, or download it as
a Word template. Internal tool.

```
web/     React (Vite)     Sign in · Load XWord · chat · editable document · Run in XPLAN · Download
server/  Mastra (TS)      agents, guided workflow, field sheet, validator, XWord, /studio API
engine/  Python (stdlib)  packs the template as .docx; scans merged reports for Err markers
prompts/                  the prompt templates every run uses (<<slot>> marks a value)
```

## Run

```bash
cd apps/xmerge-studio
./run.sh          # open http://127.0.0.1:5173
./run.sh --auth   # runs `authenticate --to=$XMS_AUTH_TO` first when tokens have expired
```

`run.sh` reads `.env` (chmod 600; parsed, not sourced), installs anything missing and starts the three
processes on 127.0.0.1 with fresh random tokens. Settings in `.env`:

| Key | Use |
|---|---|
| `AWS_BEARER_TOKEN_BEDROCK` | Bedrock API key. Short-term keys last 12 hours at most |
| `AWS_REGION`, `XMS_MODEL` | `ap-southeast-2`, `au.anthropic.claude-opus-5-5` (the AU inference profile) |
| `XMS_AUTH_TO` | account for `authenticate` (`wealth-dev-au`) |
| `ARTIFACTORY_*` | optional; normally come from `authenticate` |

Packages come from Iress Artifactory: Yarn 4 with the office `.yarnrc.yml` (reads
`ARTIFACTORY_USERNAME` / `ARTIFACTORY_ACCESS_TOKEN`). The engine service needs only `python3` (3.8 or
newer, standard library): there is no local preview, so neither the XMerge engine source nor a venv is
needed.

## How a report is made

The Mastra workflow `guided-report` (`server/src/mastra/workflows/report.ts`):

| Step | Who | What |
|---|---|---|
| design | designer agent | request -> report design in the house style (`prompts/design.md`) with `{{data points}}`, `[[for each AREA: ...]]`, `[[if partner]]` |
| fields | code | parses the design; field sheet with every field of each list used, best matches, choice codes |
| write | writer agent | design + field sheet + language reference -> template, no tools (`prompts/write_*.md`) |
| check | code (+ agent) | the validator; on blocking issues the writer repairs (at most 2) |

A message sent while a document is open runs `revise-report` instead: it applies the change to the
current text, including your own edits, then runs the same check. Typical cost: 2 model calls and
about 30 s for a new report, 1 call for a change. Paste a design in the notation above to skip the
design step.

Every edit in the document panel is re-checked by the validator after you stop typing. Download and
Run in XPLAN are disabled while there are blocking problems.

There is no local preview. The real test is **Run in XPLAN** on a test client: XPLAN merges the
template with its own engine and data, and the result is scanned for `Err` markers. Note that XPLAN
runs templates with debug off, so a failing `<:if:>` comes out as False without an `Err`; check
conditional sections in the merged document.

## Sign in

The app opens on a sign-in screen: site URL plus the browser's `XPLANID` cookie (DevTools ›
Application › Cookies). The server checks it with `GET /resourceful/session/user` and keeps it in
memory only (never written to disk, never sent back to the browser) until **Sign out** or a restart.
A page reload stays signed in. **Continue without a site** works offline with the standard fields.
Cookie sessions are for testing only (`docs/restful/tutorials/authentication.rst`), which is why this
is an internal tool. When the cookie expires the next call says so (401); sign in again.

## Load XWord

XWord is XPLAN's Word plugin for template authors. **Load XWord** switches the validator and the
field sheet from the standard catalog to one site's own fields, including its custom fields:
**Fetch from <site>** (`GET /resourceful/xmerge/xword` with the sign-in), or **Choose an XWord file**
(the `<xword-data-xml>` file the plugin downloads, or a saved xmerge/xword JSON response).

XWord carries no sensitivity flags. While signed in, the server reads each used list's flags from the
site with `GET /resourceful/ufield/{group}` (only the groups a report or template touches, once each;
`server/src/lib/siteflags.ts`). A field that ufield leaves out is treated as hidden, because XPLAN
omits hidden fields from that listing. When not signed in, or a ufield call fails, fields the standard
catalog knows keep its flags and fields only the site has need a person's approval. Whatever the
source, the validator still runs: XWord says which names exist, and the validator checks the template
against them, plus syntax, safety rules and sensitive fields.

## Run in XPLAN

**Run in XPLAN** (document panel, when signed in and the checks have no blockers) merges the current
template for one client id, Word or PDF, and downloads the result:

1. `GET entity/client-v3/{id}` shows whose report it is (**Find**).
2. The server re-checks the template, packs it as .docx and calls
   `POST /resourceful/xmerge/template/adhoc?_method=run` (falls back to `adhoc-v2`; a returned
   `location` is downloaded only from the same site).
3. The engine service scans a Word result for `Err` markers and the dialog lists them.

It is an ad hoc run (`xpt/resourceful/api/xmerge/adhoc.py`): no template is saved on the site and no
document note is added. It needs the `list_client` capability.

## Develop

```bash
node .yarn/releases/yarn-4.10.3.cjs test        # server unit tests (vitest)
node .yarn/releases/yarn-4.10.3.cjs typecheck
python3 -I engine/export_catalog.py   # after the docs catalog is regenerated
```

The earlier Python/Chainlit version is kept, unchanged, in `apps/xmerge-studio-py-legacy`.
