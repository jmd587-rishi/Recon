# Recon

*Pipeline lineage and reconciliation — setup, operation and architecture · 2026-08-04*

## Table of contents

- Introduction
  - Three ways in
  - What has been built
- Getting started
  - Prerequisites
  - Install
  - Configure
  - Run the web app
  - Run the CLI
  - First-run troubleshooting
- The reconcile command line
  - Commands
  - Options
  - A typical session
- The web application
  - Databricks dashboard
  - Local-folder dashboard
  - Upload limits
- How Recon works
  - There is no database
  - The parsing layer
  - Layers and lineage
  - How a check is chosen
  - Where the model is used, and where it is not
- The analysis flows
- What gets generated
  - governance/ — the reconciliation
  - lineage/ — the approved graph
  - documentation/ — the write-up
  - diagrams/ — the lineage as shapes
- Configuration reference
  - Required for the LLM-backed steps
  - Optional tuning
  - How the Word template is found
- API reference
  - Status code conventions
- Working on the codebase
  - Layout
  - Commands
  - Invariants worth knowing before changing anything

---

## Introduction

Recon reads the SQL and Databricks notebooks that build a data warehouse and answers the two questions an engineer otherwise answers by hand: what feeds what, and does each hop still tie out. It analyses the code statically rather than running it, so it works on a folder of .sql files with no warehouse, no catalog and no credentials.

Two things come out of that. Lineage — every table, and every statement that reads one table to write another, drawn as a graph and exportable as editable PowerPoint shapes. And reconciliation — a runnable SQL query per pipeline hop that compares row counts, measure totals, label value sets and key integrity between each target table and the sources that build it.

What lands on disk at the end of a run:

- governance/ — one runnable .sql per hop, returning one status row per check.
- lineage/ — the approved graph as HTML, JSON and PowerPoint.
- documentation/ — the pipeline written up as a branded Word document plus Markdown.
- diagrams/ — the lineage as a .pptx of real shapes and one Office-ready .svg per hop.

### Three ways in

The same services back all three. Pick by what you have access to, not by what you want out of it.

| Entry point | What it needs | Best for |
| --- | --- | --- |
| reconcile CLI | A folder of .sql files or notebook exports on disk | Offline analysis, CI, and producing a handover document — no browser, no server |
| Web app — local folder | The server plus a browser; you pick a folder from disk | Exploring an unfamiliar SQL project interactively before committing to a run |
| Web app — Databricks | Workspace URL and a personal access token; a SQL warehouse for row counts | A live pipeline, where checks can be grounded in real COUNT(*) results |

### What has been built

Recon grew flow by flow. Every flow below is mounted and functional; the web UI surfaces the last two, and the rest are reachable over the API and reused as services.

| Capability | Lives in | Notes |
| --- | --- | --- |
| Cross-notebook duplicate detection | `routes/notebooks.ts, routes/reconcile.ts` | Groups likely forks by filename, then diffs their logic rather than their text |
| Medallion stage comparison | `routes/bronzeSilver.ts` | COUNT(*) between same-named tables in adjacent schemas; the model explains a mismatch |
| Table lineage and fan-out discovery | `routes/lineage.ts, services/tableLineage.ts` | Statements tagged by operation, so a source is never confused with a target |
| Intent vs. implementation validation | `routes/validateLogic.ts` | Checks a stated business rule against the code that writes the table |
| Level-by-level reconciliation review | `routes/levels.ts, services/levelAnalysis.ts` | Code-only review per hop; /levels/fixes grounds and verifies fixes against live counts |
| Local SQL folder analysis | `routes/local.ts, client/src/local/` | The offline entry point — no connection, catalog or warehouse involved |
| Reconciliation script generation | `services/reconciliationScripts.ts, reconciliationBundle.ts` | Derived from the columns, no LLM required; the model only adds what the schema cannot |
| The reconcile CLI | `server/src/cli/` | run, scripts, document, diagrams and layers, straight off disk |
| Word document generation | `services/documentation.ts, docModel.ts, docxWriter.ts` | Renders into the branded template; --no-ai yields the same document minus its prose |
| Lineage diagrams as Office shapes | `services/pptxWriter.ts, officeSvg.ts, dagLayout.ts` | Most recent work: curved connectors routed so edges no longer overlap |
| Label-column checks (category_values) | `services/reconciliationScripts.ts, llmClient.ts` | In progress at the time of writing — labels compared as value sets instead of summed |

---

## Getting started

### Prerequisites

| Requirement | Needed for | Notes |
| --- | --- | --- |
| Node.js 20.19+ (22 LTS recommended) | Everything | Vite 8 sets the floor; the server is ESM with NodeNext resolution |
| npm | Everything | Two separate installs — there is no root workspace |
| Azure OpenAI deployment | The reviewer model and every /analyze endpoint | Optional. Without it, every derived check and diagram still works |
| Databricks workspace + PAT | Flows 1–5 in the web app | Optional. The local-folder flow and the whole CLI never touch it |
| A Databricks SQL warehouse | Row counts and fix verification | Optional even within the Databricks flows — /levels/* works code-only without one |

### Install

The repository is two separately-installed sibling projects, server and client. There is no root workspace configuration, so plain npm install at the root installs only the root devDependency.

```sql
git clone <repo-url>
cd recon
npm run install:all
```

### Configure

Copy the example environment file and fill in the Azure OpenAI settings. Only the LLM-backed endpoints need it; the rest of the app runs without.

```sql
cp server/.env.example server/.env

# server/.env
PORT=4000
AZURE_OPENAI_ENDPOINT=https://your-foundry.openai.azure.com/
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_DEPLOYMENT=your-deployment-name
```

The server resolves .env relative to its own source file rather than the working directory, so it loads the same way however the process is started. The CLI resolves it differently — see the configuration reference.

### Run the web app

```sql
npm run dev
```

That starts both halves: the API on http://localhost:4000 (or PORT) and the Vite dev server, which proxies /api/* to it. Open the URL Vite prints. GET /api/health returns { ok: true } if the server is up.

### Run the CLI

From the server folder, against any folder of SQL on disk:

```sql
cd server
npm run cli -- run --dir "C:\projects\my-warehouse"
```

Or build once and install it as a global binary, which is how it is meant to be used day to day:

```sql
npm run build --prefix server
npm install -g ./server

cd /projects/my-warehouse
reconcile run
```

### First-run troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| "No .sql files or notebooks found" | --dir points somewhere else, or every file was filtered out | Check the path; raise --max-files; drop --no-notebooks if the source is notebooks |
| Scripts say they are the standard schema-derived checks only | Azure OpenAI is not configured, or the call failed | Set AZURE_OPENAI_* in .env, or accept it — the derived checks are the grounded ones |
| reconcile document wrote only the .md | No Word template was found | "Document Title.docx" is in .gitignore, so a fresh clone has none — see the note below |
| The .docx table of contents is empty | Word has not refreshed its fields yet | It refreshes on open; otherwise press Ctrl+A then F9 |
| 409 from an /api/ route | Not connected to Databricks, or no folder uploaded | Connect first, or POST /api/local/scan before the local routes |
| 503 from /api/levels/* or /api/local/governance | Azure OpenAI is not configured | Set AZURE_OPENAI_* in server/.env and restart the server |

> Setup note: .gitignore excludes "Document Title.docx" at every level, which covers both the copy at the repository root and the one bundled at server/templates/. A fresh clone therefore has no template, and reconcile document degrades to Markdown-only until you drop the template back in or pass --template. The same applies to server/test, which is also gitignored.

---

## The reconcile command line

reconcile is flow 6 taken off the browser: it scans a folder, works out the layers and the lineage, and writes the reconciliation, the write-up and the diagrams straight back to disk. No server runs and nothing is uploaded.

### Commands

| Command | What it does | Writes into |
| --- | --- | --- |
| `reconcile run` | The whole pass: layers, lineage, a confirmation gate, then the scripts — and the document if you say yes | `lineage/, governance/, documentation/` |
| `reconcile scripts` | The reconciliation only, one query per hop, with no lineage gate in front of it | `governance/` |
| `reconcile document` | The pipeline written up as a Word document and Markdown, reading whatever earlier commands left behind | `documentation/, diagrams/` |
| `reconcile diagrams` | The lineage as editable PowerPoint shapes plus one Office-ready SVG per hop | `diagrams/` |
| `reconcile layers` | Prints the detected layers and stops — writes nothing | `(nothing)` |

run is the one to reach for. The reconciliation is only as good as the lineage it is derived from, and that lineage is parsed out of SQL by heuristics a real project can defeat — so run draws the lineage first, asks you to confirm it, and applies your corrections to the underlying facts rather than only to the picture. Approving the diagram approves what the scripts are built on.

### Options

| Option | Effect |
| --- | --- |
| `--dir <path>` | Project folder to scan (default: the current directory) |
| `--out <name>` | Output folder for the reconciliation (default: governance) |
| `--lineage-out <name>` | Folder for the lineage diagram and data (default: lineage) |
| `--doc-out <name>` | Folder for the document (default: documentation) |
| `--diagrams-out <name>` | Folder for the deck and the SVGs (default: diagrams) |
| `--template <path>` | Word template to render into (default: the one bundled with Recon) |
| `--layers a,b,c` | Schema names, most-raw first, overriding auto-detection |
| `--env-file <path>` | Where to read AZURE_OPENAI_* from (default: <dir>/.env, then ./.env) |
| `--no-ai` | Skip the reviewer model — write only the schema-derived standard checks |
| `--no-notebooks` | Read .sql files only, ignoring Databricks notebook exports |
| `--no-diagrams` | document: skip the diagrams that normally accompany the write-up |
| `--auto-approve` | run: accept the extracted lineage without prompting (for CI) |
| `--document / --no-document` | run: answer the document question in advance |
| `--no-open` | run: do not try to open the lineage diagram in a browser |
| `--split` | Also write the per-table scripts, one folder per hop, beside each query |
| `--one-file` | Fold every hop into a single reconciliation.sql instead of one file per hop |
| `--max-files <n>` | Cap on how many files are read (default: 5000) |
| `-h, --help` | Show usage |

### A typical session

1. cd into the project folder and run reconcile layers to check the schema names were understood.
1. If they were not, re-run with --layers raw,staged,mart to name them explicitly.
1. Run reconcile run. It draws the lineage and opens it for review.
1. Correct anything the parser got wrong, then approve. The corrections are applied to the facts, not just the drawing.
1. The reconciliation queries are written. Answer yes to the document question to get the write-up too.
1. Run each governance/<hop>.sql against the warehouse and read the status column.

```sql
cd /projects/my-warehouse
reconcile layers
reconcile run --layers raw,staged,mart

# non-interactive equivalent, for CI
reconcile run --auto-approve --document --no-open
```

---

## The web application

A thin Express API on port 4000 and a React single-page app in front of it. The client only ever talks to the backend through client/src/api/client.ts, whose return types double as the client-side view of the server's contract.

The app opens on Connect and then forks. Give it a Databricks workspace and it goes to the pipeline setup and the S-dashboard; choose a local folder instead and it goes to the L-dashboard. The two never run at once, and they infer their layers differently — from the catalog's schema list on one side, from schema qualifiers in the SQL on the other.

### Databricks dashboard

| Tab | What it shows |
| --- | --- |
| S1 · Layers & tables | The layers as detected, the tables in each, and their row counts when a warehouse is set |
| S2 · Exclusions | Filters each hop applies and how many rows each one drops — the expected, explainable loss |
| S3 · Table lineage | The extracted graph: which statement reads which table to write which other one |
| S4 · Project summary | The pipeline described as a whole, tables classified by their role |
| S5 · Governance & fixes | The governance gate: responsible notebooks found automatically, fixes proposed, and — with a warehouse — verified against live counts |

### Local-folder dashboard

| Tab | What it shows |
| --- | --- |
| L1 · Files & tables | Every .sql file found, the statements parsed out of it, and the tables discovered |
| L2 · Table lineage | The same lineage graph, derived from the SQL alone with no catalog to consult |
| L3 · Governance & fixes | One hop's statements reviewed at a time — or all of them when the SQL never qualifies its tables |
| L4 · Reconciliation scripts | The reconciliation for every hop, downloadable as a zip: the bundle and the per-table scripts, one folder per hop |

### Upload limits

Only SQL text crosses the wire — the browser walks the chosen folder and sends file contents, never the folder handle. Both sides cap it.

| Cap | Browser | Server | CLI |
| --- | --- | --- | --- |
| Files | 300 | 500 | 5000 (--max-files) |
| Per file | 512 KB | — | 4 MB |
| Total | 6 MB | 8 MB | 64 MB |

---

## How Recon works

### There is no database

Everything the server knows lives in services/../store/memoryStore.ts — a single in-process object holding the connection, the catalog, the notebooks, the parsed local SQL folder and the results derived from them. It resets whenever a new Databricks connection is established. That makes the server single-session and single-user by design, and means state is lost on restart. The CLI sidesteps the question entirely by holding the project in memory for one command.

### The parsing layer

Almost everything else is built on a handful of primitives, each answering one narrow question about one piece of code. Extend the primitive rather than post-processing its output at a call site — that is what keeps notebooks and .sql files answering the same way.

| Primitive | Question it answers | Notes |
| --- | --- | --- |
| `notebookParser.ts` | Where do a Databricks notebook export's cells begin and end? | Understands # COMMAND ---------- separators and # MAGIC %sql prefixes |
| `sqlFileParser.ts` | Where does each statement in a .sql file begin and end? | Records byte spans, so a corrected statement can be spliced back with every other byte preserved |
| `sqlAnalyzer.ts` | What does this statement parse to? | node-sql-parser across hive → transactsql → postgresql → mysql, with a regex fallback |
| `tableLineage.ts` | Which tables does this statement read, and which does it write? | The single place that decision is made; MERGE, CTAS and 3-part names fall back to regex |
| `sqlColumns.ts` | What columns are in this table? | Hand-written, not AST-based — node-sql-parser rejects real SSDT DDL in all four dialects |
| `whereClauseAnalyzer.ts` | What does this transformation filter on? | Quoted in the script as the difference a count check is expected to show |
| `columnRole (in reconciliationScripts.ts)` | Is this column a key, a measure, a label or a timestamp? | The head noun decides; the declared type only breaks ties |

### Layers and lineage

- Layers are inferred from schema names by keyword — bronze/silver/gold and their equivalents — and ordered most-raw first. Adjacent pairs become hops.
- Lineage is a graph of facts: each statement contributes the tables it reads and the table it writes, tagged by operation so a source is never mistaken for a target.
- SSDT projects need two repairs before the graph is usable: T-SQL temp tables are redrawn onto the real tables at either end of the chain, and targets the SQL left unqualified take the schema their folder names.
- Corrections made at the confirmation gate are recorded and replayed onto later scans, so the document and the scripts describe the lineage you approved, not the one the parser first guessed.

### How a check is chosen

The standard checks are derived, with no model involved. A script naming a column the table does not have is worse than no script, and the columns are already known exactly.

| Decision | How it is made |
| --- | --- |
| The join key | The declared PRIMARY KEY where the project has DDL; failing that, columns both sides share whose names end in _key or _id — flagged inferred, with the duplicate-key check in the same script there to disprove the guess |
| Measures | Shared columns whose head noun reads as an amount or a quantity. These are totalled on both sides |
| Labels | A status, type, code, flag, region or period. Compared as sets of values instead, because SUM(status) errors and SUM(fiscal_year) succeeds and reconciles to nothing. Capped per source, filtered-on ones first |
| Expected loss | The WHERE predicate the transformation itself applies, quoted in the script header as the difference a count check is expected to show |

Emitted SQL is portable — no TOP, no LIMIT — so it runs on SQL Server and Databricks SQL alike. That is also why the label check full-outer-joins the two value sets on an equi-key with NULLs excluded beforehand: Spark refuses a full outer join whose condition is not an equality.

### Where the model is used, and where it is not

| Step | Model? | Why |
| --- | --- | --- |
| Lineage extraction | No | Parsed from the SQL; a graph has to be reproducible |
| Layer detection | No | Keyword matching on schema names, correctable by hand |
| The standard checks | No | Derived from columns that are already known exactly |
| Extra checks per target | Yes | Only what reading the transformation can reveal — grain changes, dedup, fan-out |
| Mismatch explanation, fix suggestions | Yes | Flows 2–5; grounded in live counts when a warehouse is available |
| Document prose | Yes | The one thing the SQL cannot state: what each layer and hop is for |
| Diagrams | No | Shapes are derived from the graph — the one command that cannot degrade |

No flow sends whole notebooks or files to Azure OpenAI. Only the specific extracted cell or statement snippets go, kept small deliberately. Every model step degrades rather than fails: with no Azure OpenAI configured you get the derived checks and a document without prose.

---

## The analysis flows

Seven flows share the parsing layer but solve different problems. All are mounted; the UI surfaces flows 5 and 6, and the rest are reachable over the API and reused as services rather than duplicated.

| # | Flow | Reached by | What it answers |
| --- | --- | --- | --- |
| 1 | Cross-notebook reconciliation | `/api/notebooks, /api/reconcile` | Which notebooks are forks of each other, and where has their logic actually diverged? |
| 2 | Medallion stage comparison | `/api/bronze-silver` | Do same-named tables in adjacent schemas have the same row count — and if not, which code did it? |
| 3 | Lineage / fan-out discovery | `/api/lineage` | What reads this table, and what does it write as a result? |
| 4 | Intent vs. implementation | `/api/validate-logic` | Does the code that writes this table actually implement the stated business rule? |
| 5 | Level-by-level review | `/api/levels/analyze, /fixes` | For one hop and the notebooks responsible for it: what could break reconciliation, and what is the fix? |
| 6 | Local SQL folder analysis | `/api/local` | Everything above, from a folder of .sql files with no workspace at all |
| 7 | The run, written up | `reconcile document` | What does this pipeline do, and how is it reconciled — as a document a reader can be handed |

Flows 1–5 go through the requireConnection middleware, which returns 409 when no Databricks connection is established. Flow 6 sits deliberately outside it, because its whole point is working with no workspace. Flow 7 has no route at all — it is CLI-only.

---

## What gets generated

### governance/ — the reconciliation

One .sql per hop by default, each the hop's whole reconciliation as a single query. --split also writes the per-table scripts behind it; --one-file folds every hop into one file instead. The bundle is the file to run; the scripts are the detail behind it, and the row-listing queries the fold turns into counts are repeated at the foot of the bundle inside block comments.

Every bundle returns the same ten columns, one row per check:

| Column | Meaning |
| --- | --- |
| `check_seq` | Ordering, so the result reads top to bottom in the order the checks were written |
| `scope` | The hop this row belongs to — the only column that matters under --one-file |
| `target_table` | The table being reconciled |
| `source_table` | The table it is being reconciled against |
| `check_name` | Which check this row is |
| `metric` | What was measured — a count, a total, a value set |
| `source_value / target_value` | The two numbers |
| `difference` | target_value − source_value; 0 when the hop ties out |
| `status` | PASS, REVIEW or FAIL |

| Status | What it means |
| --- | --- |
| PASS | The two sides agree |
| REVIEW | The numbers differ and something has to explain it — a filter, an aggregation, a deliberate exclusion |
| FAIL | Wrong on its own terms: duplicate keys, null keys, or target rows no source accounts for |

A check whose key was inferred rather than declared reports REVIEW where a declared key would report FAIL — the guess is not trusted enough to call it a failure. SUMMARY.txt in the same folder records the counts, the hop split, and whether the reviewer model contributed.

The check kinds:

| Kind | Compares |
| --- | --- |
| `row_count` | Rows in the target against rows in each source |
| `measure_totals` | SUM of each shared measure column on both sides |
| `category_values` | The distinct value sets of a shared label column — values that appeared or vanished |
| `missing_keys` | Source keys with no target row |
| `orphan_keys` | Target keys no source accounts for |
| `duplicate_keys` | Keys appearing more than once in the target |
| `null_keys` | Key columns that are null |
| `custom` | Anything the reviewer model added from reading the transformation itself |

### lineage/ — the approved graph

| File | Contents |
| --- | --- |
| `lineage.html` | The diagram you reviewed at the confirmation gate |
| `lineage.pptx` | The same diagram as editable PowerPoint shapes |
| `lineage.json` | The approved graph — read back by document and diagrams on later runs |
| `lineage-feedback.json` | Each round of corrections, so they can be replayed onto a fresh scan |

### documentation/ — the write-up

A .docx rendered into the branded Word template and the same content as .md. Both, always: the .docx is what gets circulated and the Markdown is what can be diffed, grepped or read in a terminal. Its sections:

- Introduction — what the project is and what was scanned
- Pipeline layers — each layer, its tables, and what the layer is for
- Table lineage — the graph as a table of edges
- Business context, layer by layer — the one part the model writes, grounded in each hop's own SQL
- How the pipeline is reconciled — the join keys, measures and filters behind the checks
- Gaps and open questions — what the scan could not resolve
- Appendices — files scanned, and the full table inventory

### diagrams/ — the lineage as shapes

| File | Contents |
| --- | --- |
| `<project>-lineage.pptx` | One slide per diagram — the overview, then one per hop. Every table is a real shape and every arrow a connector bound to the two shapes it joins |
| `svg/<hop>.svg` | The same diagrams one at a time, for dropping a single hop into an existing document |
| `README.txt` | How to get either into Word or PowerPoint, and the Convert-to-Shape caveat |

File names match the governance folder: bronze_to_silver.svg is the diagram for bronze_to_silver.sql.

---

## Configuration reference

The server reads server/.env. The CLI reads the first .env it finds: an explicit --env-file, then <dir>/.env, then ./.env — so a project folder can carry its own settings.

### Required for the LLM-backed steps

| Variable | Purpose |
| --- | --- |
| `AZURE_OPENAI_ENDPOINT` | Your Azure OpenAI / AI Foundry endpoint URL |
| `AZURE_OPENAI_API_KEY` | API key for that endpoint |
| `AZURE_OPENAI_DEPLOYMENT` | The deployed model name |

### Optional tuning

| Variable | Default | Effect |
| --- | --- | --- |
| `PORT` | 4000 | Server port |
| `AZURE_OPENAI_TIMEOUT_MS` | 120000 | Ceiling for one LLM call |
| `AZURE_OPENAI_REASONING_EFFORT` | unset | Only on a reasoning deployment — a non-reasoning one rejects it outright. low is the biggest latency win for the reconciliation flow |
| `RECON_TARGETS_PER_CALL` | 2 | Target tables per call — lower means shorter answers and more calls |
| `RECON_CONCURRENCY` | 4 | Calls in flight at once |
| `RECON_LLM_TIMEOUT_MS` | 75000 | Per-call ceiling; an overrun degrades to the derived checks, it never hangs |
| `RECON_MAX_OUTPUT_TOKENS` | 1600 | Output budget per target table |
| `RECON_DOC_CONCURRENCY` | 3 | Parallel calls while writing the document |
| `RECON_DOC_LLM_TIMEOUT_MS` | 100000 | Per-call ceiling for the document's prose |
| `RECON_DOC_TEMPLATE` | unset | Word template path, below --template but above the bundled copy |

### How the Word template is found

1. --template <path> — an explicit path wins, and is an error if it does not exist
1. $RECON_DOC_TEMPLATE
1. A copy named "Document Title.docx" in the project folder being scanned
1. The copy bundled at server/templates/, shipped by package.json's files
1. Up to five directories above the running module — so a git clone needs no configuration

Finding nothing is a warning, not an error: the Markdown is still the whole document. Note that the file name is gitignored, so a clone will fall through to step 5 or to no template at all.

---

## API reference

All routes are mounted under /api. Everything except /api/local and /api/health goes through the requireConnection middleware.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Liveness — returns { ok: true } |
| POST | `/api/connections` | Establish a Databricks connection; resets the store |
| GET | `/api/connections/status` | Whether a connection is established |
| DELETE | `/api/connections` | Drop the connection |
| GET | `/api/catalogs` | List catalogs |
| GET | `/api/catalogs/:catalog/schemas` | List schemas in a catalog |
| GET | `/api/catalogs/:catalog/schemas/:schema/tables` | List tables in a schema |
| GET | `/api/notebooks/browse` | Browse the workspace tree |
| GET | `/api/notebooks` | List notebooks under a root |
| GET \| PUT | `/api/notebooks/groups` | Read or override the likely-fork grouping |
| POST \| GET | `/api/reconcile, /api/reconcile/results` | Run the cross-notebook diff, then read it back |
| POST | `/api/bronze-silver/compare` | COUNT(*) across adjacent schemas |
| GET | `/api/bronze-silver/mismatches` | The mismatches found |
| POST | `/api/bronze-silver/analyze` | Ask the model which code caused a mismatch |
| POST \| GET | `/api/lineage, /api/lineage/results` | Discover fan-out from a source table |
| POST | `/api/lineage/explain` | Explain every discovered candidate in one call |
| POST | `/api/validate-logic` | Check a business rule against the code that writes a table |
| POST | `/api/levels/analyze` | Combined reconciliation report for one hop (code-only) |
| POST | `/api/levels/fixes` | Governance fixes for one hop, verified when a warehouseId is given |
| GET | `/api/pipeline/warehouses` | List SQL warehouses |
| POST | `/api/pipeline/table-counts` | Row counts for the selected tables |
| POST | `/api/pipeline/analyze` | The pipeline analysis behind S2 and S3 |
| POST | `/api/pipeline/summary` | The project summary behind S4 |
| POST \| GET | `/api/local/scan` | Upload a SQL folder, or read back the parsed one |
| DELETE | `/api/local` | Forget the uploaded folder |
| POST | `/api/local/reconciliation` | The reconciliation suite for every hop (L4) |
| POST | `/api/local/governance` | Review one hop's statements (L3) |

### Status code conventions

Consistency here matters more than the individual codes — keep new routes on the same table.

| Code | Means |
| --- | --- |
| 400 / 404 | A client mistake — a malformed body, or something that does not exist |
| 401 | The Databricks personal access token was rejected |
| 409 | Not connected — or, on /api/local, no folder uploaded yet |
| 502 | A Databricks call failed |
| 503 | Azure OpenAI is not configured |

---

## Working on the codebase

### Layout

| Path | Contents |
| --- | --- |
| `server/src/routes/` | One router per flow; thin, with the work in services |
| `server/src/services/` | All the analysis — parsing, lineage, checks, LLM client, writers |
| `server/src/cli/` | The reconcile binary and its disk-side helpers |
| `server/src/store/` | memoryStore.ts — the entire persistence layer |
| `server/src/types/index.ts` | The API contract |
| `server/templates/` | The branded Word template, shipped with the package |
| `server/test/` | Vitest suites (gitignored in this repository) |
| `client/src/pipeline/` | The Databricks dashboard, S1–S5 |
| `client/src/local/` | The local-folder dashboard, L1–L4 |
| `client/src/api/client.ts` | The only place the client calls the backend |
| `client/src/types.ts` | The client-side mirror of the server contract |

### Commands

| Command | Does |
| --- | --- |
| `npm run install:all` | Install both packages (root) |
| `npm run dev` | Server and client together (root) |
| `npm run build` | Build server then client (root) |
| `npm test --prefix server` | Run the vitest suites |
| `npx vitest run test/sqlAnalyzer.test.ts` | One test file (from server/) |
| `npm run typecheck --prefix server` | tsc --noEmit |
| `npm run lint --prefix client` | oxlint |
| `npm run cli -- <command>` | The CLI from source, via tsx (from server/) |
| `npx tsx scripts/buildProjectDoc.ts` | Regenerate this document (from server/) |

### Invariants worth knowing before changing anything

- server/src/types/index.ts and client/src/types.ts mirror each other by hand. There is no shared or generated types package — change an API shape and you change both.
- splitSqlTablesByOp in tableLineage.ts is the single place a statement's read/write tables are decided, for notebook cells and uploaded files alike. Extend it rather than post-processing at a call site.
- sqlColumns.ts is the only place a table's columns are worked out. Its scanner is deliberately not AST-based, so dialect quirks belong in it rather than in SQL_DIALECTS.
- columnRole is the single place a column's kind of check is decided. Add a word to its tables rather than special-casing a check — a name it misreads as a measure produces a SUM over a label everywhere at once.
- A new check belongs in both writers: reconciliationScripts.ts for the per-table script and reconciliationBundle.ts for the single query. Otherwise it exists in the scripts and silently not in the file people actually run.
- A new kind of document content is a new DocBlock in docModel.ts plus a case in both renderers. TypeScript's exhaustiveness check on the union is what enforces the second one.
- Never hard-code fonts, sizes or colours in docxWriter.ts. If a block needs a look the template does not define, add the style to the template. Everything written goes through escapeXml, and anything read off disk also through sanitize — one stray control byte in a SQL comment makes Word refuse to open the file.
- Route handlers that hit Databricks return 502 on failure. 400 and 404 are reserved for client mistakes, 409 for not-connected, 401 for a bad token, 503 for unconfigured Azure OpenAI.
- Two parsers, two formats: notebookParser.ts splits notebook exports into cells, sqlFileParser.ts splits .sql files into statements with byte spans. Pick by where the code came from, not by its language.
