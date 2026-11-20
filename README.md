# XMerge Studio

Ask for a client report in plain words; Claude designs it, fills in the XPLAN fields and checks it.
You edit it inline, merge it for a client on an XPLAN site to see the real document, or download it as
a Word template. Internal tool.

```
web/      React (Vite)  Sign in · Load XWord · chat · versioned, editable document · Run in XPLAN · Download
server/   Mastra (TS)   agents, guided workflow, field sheet, validator, XWord, Word files, /studio API
prompts/                the prompt templates every run uses (<<slot>> marks a value) + the XMerge language reference
samples/                sample templates for the Bedrock knowledge base (upload samples/*.md)
engine/   Python        export_catalog.py only: rebuilds server/data/catalog.json from the XMerge AI docs
```

## Run

```bash
cd apps/xmerge-studio
./run.sh          # open http://127.0.0.1:5173
./run.sh --auth   # runs `authenticate --to=$XMS_AUTH_TO` first when tokens have expired
```

`run.sh` reads `.env` (chmod 600; parsed, not sourced), installs anything missing and starts the
Mastra server and the React app on 127.0.0.1 with a fresh random token. Only Node is needed (`.nvmrc`). Settings in `.env`:

| Key | Use |
|---|---|
| `AWS_BEARER_TOKEN_BEDROCK` | Bedrock API key. Short-term keys last 12 hours at most |
| `AWS_REGION`, `XMS_MODEL` | `ap-southeast-2`, `au.anthropic.claude-opus-5-5` (the AU inference profile) |
| `XMS_AUTH_TO` | account for `authenticate` (`wealth-dev-au`) |
| `XMS_GUARDRAIL_ID`, `XMS_GUARDRAIL_VERSION` | optional Bedrock guardrail applied to every model call; the version must be a published number (`DRAFT` is refused) |
| `XMS_KB_ID` | optional Bedrock knowledge base of sample templates (see below) |
| `ARTIFACTORY_*` | optional; normally come from `authenticate` |

Packages come from Iress Artifactory: Yarn 4 with the office `.yarnrc.yml` (reads
`ARTIFACTORY_USERNAME` / `ARTIFACTORY_ACCESS_TOKEN`). The app is self-contained: it reads nothing
outside this folder. Python is needed only to rebuild the field catalog (see Develop).

## How a report is made

The Mastra workflow `guided-report` (`server/src/mastra/workflows/report.ts`):

| Step | Who | What |
|---|---|---|
| design | designer agent | request -> report design in the house style (`prompts/design.md`) with `{{data points}}`, `[[for each AREA: ...]]`, `[[if partner]]` |
| fields | code | parses the design; field sheet from the loaded fields (standard catalog or XWord) with every field of each list used, best matches, choice codes; the closest sample templates from the knowledge base |
| write | writer agent | design + field sheet + samples + language reference -> template, no tools (`prompts/write_*.md`) |
| check | code (+ agent) | the validator; on blocking issues the writer repairs (at most 2) |

## Editing like an artifact

The document panel works like Claude's artifacts: you keep talking to change the document, and you can
edit it yourself at any time.

- Every reply that changes the template adds a **version**. The chat shows a card for it (click to open
  that version) and the panel steps through versions with ‹ ›. Opening an older version makes it the one
  your next message changes.
- Your own edits are marked **edited**. When you send a message they are saved as a version first
  ("your edits"), and the change is made to exactly what you see. Opening another version saves them
  the same way, so stepping through versions never loses an edit.
- While the agent writes, the template streams into the panel and the notes into the chat. **Stop**
  ends the run on the server too, so no more model calls are made.
- A message that asks *about* the document ("which fields does this use?") gets an answer and leaves
  the document as it is.
- The conversation and the versions are kept in this browser, so a page reload carries on where you
  were. **New report** clears them. Closing the panel only hides it (**Show document** brings it back).

A message sent while there is a document runs `revise-report`: it applies the change to the current
text, including your own edits, then runs the same check. If a model call fails (an expired Bedrock key,
a throttle, the guardrail) the run stops at that step and says why.

The agents keep no memory: each call sees only what the request sends. So the app sends the earlier
requests of the current report with each new one, which is how "now mix both" knows what "both" means,
and a revise also gets the fields the template already uses. **New report** clears that history, so
nothing from one report reaches the next.

The writer's system prompt (rules + the 20 KB language reference) is the same on every call and carries
a Bedrock cache point, so write, repair and revise calls reuse it instead of paying for it each time. Typical cost: 2 model calls and
about 30 s for a new report, 1 call for a change. Paste a design in the notation above to skip the
design step.

Every edit in the document panel is re-checked by the validator after you stop typing. Download and
Run in XPLAN are disabled while there are blocking problems.

There is no local preview. The real test is **Run in XPLAN** on a test client: XPLAN merges the
template with its own engine and data, and the result is scanned for `Err` markers. Note that XPLAN
runs templates with debug off, so a failing `<:if:>` comes out as False without an `Err`; check
conditional sections in the merged document.

## Guardrail and sample templates

**Guardrail.** Set `XMS_GUARDRAIL_ID` and `XMS_GUARDRAIL_VERSION` in `.env` and every designer and
writer call goes through that Bedrock guardrail. The version must be a published number;
`infra/bedrock-guardrails/deploy.sh` creates the guardrails and prints both values. The guardrail checks
only the adviser's own text, which is sent as guard content: the request and earlier requests, the
design the writer gets, and the revise instruction. The field sheet, samples and template around it are
not checked. When it intervenes, the run stops with "The Bedrock guardrail blocked this request" and the
guardrail's message.

**Sample templates.** Set `XMS_KB_ID` to a Bedrock knowledge base whose data source holds the files in
`samples/*.md`. For each new report the server sends the request to the knowledge base's Retrieve API and
gives the writer the closest samples (up to two, 20 000 characters in all) to follow for layout and
style. The step line shows which samples were used. Without `XMS_KB_ID`, or when Retrieve fails, the
report is written without samples.

- Each sample is one `.md` file: a `# Sample template:` title, a `Purpose:` line (what retrieval
  matches on) and the template in ```` ```xmerge ```` blocks (body, plus page header/footer where the
  original has them). Long documents are split per section, `risk-insurance-soa-01-...` to `-12-...`,
  and each part repeats the `<:let:>` setup lines it needs, so every part stands alone. No part is
  bigger than 16 000 characters, the size of the largest single block of template code.
- The originals (Word/ODT) are in `samples/source/`, which git ignores because they carry author
  metadata. Upload only `samples/*.md`: knowledge bases cannot read `.odt`, and the `.md` files have no
  metadata.
- `infra/bedrock-kb/upload-samples.sh` uploads them: it checks each sample (title, `Purpose:` line,
  xmerge block, size, nothing that looks like client data), then sends `samples/*.md` to the knowledge
  base. A custom data source gets them directly, with the file name as document id, so a re-run replaces
  them; an S3 data source gets them in its bucket plus an ingestion job. Last, it checks that Retrieve
  finds each sample by its title. `--plan`
  shows what would change, `--list` shows the knowledge bases in the account.
- Set the data source's chunking to **No chunking** so each sample comes back whole, and use an
  embedding model that reads 8 000 tokens (Titan Text Embeddings V2); a 512-token model would only
  embed the start of each sample.
- Retrieve does not accept the Bedrock API key, so it is signed with the AWS keys from `authenticate`.
  `run.sh` runs `authenticate` when `XMS_KB_ID` is set and there are none, and keeps them alongside the
  API key. The role needs `bedrock:Retrieve` on the knowledge base.
- Samples are examples only. The field sheet still decides which fields exist, and the validator checks
  every template against the loaded fields (XWord when loaded).

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
3. The server scans a Word result for `Err` markers (`server/src/lib/docx.ts`) and the dialog lists them.

It is an ad hoc run (`xpt/resourceful/api/xmerge/adhoc.py`): no template is saved on the site and no
document note is added. It needs the `list_client` capability.

## Develop

```bash
node .yarn/releases/yarn-4.10.3.cjs test        # server unit tests (vitest)
node .yarn/releases/yarn-4.10.3.cjs typecheck
python3 -I engine/export_catalog.py   # after the catalog in the XMerge AI docs is regenerated (ai/, or XMS_AI_DOCS)
```

The earlier Python/Chainlit version is kept, unchanged, in `apps/xmerge-studio-py-legacy`.
