# XMerge Template Language Reference (AI authoring context)

> **Source of truth:** `xmerge_commands.json` (schema `xmerge_commands.schema.json`) lists
> every command, its status and its AI-use verdict, and is checked against the code by
> `tools/check_registry.py`. If this document and the registry disagree, the registry wins.

Purpose: a self-contained reference for generating XMerge report templates.
Written to be given to an AI model as grounding context. Every claim is backed
by code in this repo (paths relative to `src/py/` unless absolute) or by the
real template corpus in `data/` (235 `.odt` files, 90 of them in `data/test/xmerge`).
Note that much of the corpus is **not** client reports. Insurance, general
insurance and diary templates use symbols such as `$scenario`, `$product` and
`$writeMoney` that do not exist in `ClientReport`.

> **Confidence markers.** The core parser (`xlib.ooo.template.Template`) lives
> in the external package `iress-xlib` (`docker/dockerfiles/xplan3deps/depends/requirements.in:61`)
> and is **not** in this repo. Rules marked **[CORPUS]** are proven by real
> templates + tests but not by parser source. **[INFERRED]** = derived from the
> sibling HTML engine `xpt/template.py`, which uses the same `<: :>` delimiters.
> **[UNKNOWN]** = needs the xlib source.

---

## 1. What a template is

- An OpenDocument file (`.odt` / `.ods`), or `.docx` / `.xlsx`, which is
  converted to ODF when uploaded. It contains ordinary document content plus
  **XMerge markers** holding Python expressions or statements.
- Markers are stored XML-escaped in `content.xml` / `styles.xml`
  (`&lt;:=$client.first_name:&gt;`). They **may span several `<text:span>`
  runs** and still work, e.g. Word formatting splitting a marker.
  (`report_with_image.odt`; `xpt/report/tests/report_test.py:1240-1258`)
- Markers in headers and footers (`styles.xml`) are executed too. **[CORPUS]**
- Markers inside XML attributes (hyperlink hrefs, image names) were never
  observed. Treat this as unsupported. **[INFERRED]**
- Expressions are **Python 2** syntax and are converted with 2to3 before they
  run (`docs/markdown/xmerge/architecture.md`, "Python 2 to 3").

## 2. Marker grammar

### 2.1 Safe subset (use only these when generating)

Marker usage across the whole corpus: `=` 9921, `end` 4731, `if` 3723,
`let` 1100, `for` 1007, `else` 847. Nothing else appears.

| Marker | Meaning |
|---|---|
| `<:=expr:>` | Evaluate the expression and insert the result |
| `<:let name = expr:>` | Assign a template variable (no output) |
| `<:if cond:>` … `<:else:>` … `<:end:>` | Conditional |
| `<:for x in seq:>` … `<:end:>` | Loop. Tuple unpacking is allowed: `<:for i, x in enumerate(seq):>` |

- **Blocks close with an explicit `<:end:>`.** Indentation means nothing.
  `else` takes no argument and has no `end` of its own. **[INFERRED from
  `xpt/template.py:1026-1076`; CORPUS-consistent]**
- Whitespace inside markers is tolerated: `<:if $isTrust :>`, `<:= 2 / 3 :>`. **[CORPUS]**
- **Do not generate** `elif`, `while`, `def`, `include`, `py`, `<:# :>` comments
  or `<:"text":>`. These exist in the sibling HTML engine but are never used in
  XMerge templates. For `elif`, nest an `if` inside `else`.
- Emit straight quotes (`'` and `"`). The corpus contains smart quotes that
  still render (`report_test.py:872-921`), but don't rely on that.

### 2.2 Where a repeat or condition applies (layout scope) **[CORPUS]**

| Pattern | How to lay it out |
|---|---|
| Repeat paragraphs or whole tables | `<:for …:>` alone in its own paragraph, the body, then `<:end:>` alone in its own paragraph (`dependants.odt`, `client_goals.odt`) |
| Repeat table rows | Put a row whose first cell holds only `<:for x in …:>`, then the body row(s), then a row whose cell holds only `<:end:>` (`data/report/odf/general_insurance/product_comparison.odt`, `docnote/note.odt`) |
| Inline conditional | `<:if c:>☒<:else:>☐<:end:>` within one cell or span (`aml/company.odt`) |
| Loop within one cell | `<:for …:>` / `<:=f:>` / `<:end:>` as separate paragraphs in the cell (`note.odt`) |
| Loops in lists | Inside `<text:list-item>` (`identity_trust.odt`) |

A paragraph or table row that holds only a `for`/`end`/`let` marker is removed
from the output. This was confirmed by rendering with the real engine in the
`demo/` spike (2026-11-13).

## 3. Names: `$symbols`, globals and variables

- `$name` is resolved by the report helper:
  `AbstractReport.__handleTpl` → `handleTpl_<name>` (`xpt/report/tplutil.py:1094-1102`).
  **An unknown `$name` silently returns `""`. It does not raise an error.**
  A generator must therefore validate symbol names itself.
- Names without `$` are globals injected at `tplutil.py:977-998` and from
  `xpt/report/tplvars.py:_get_available` (`:393-415`).
- Variables created with `let` are plain names (no `$`).
- `$$` gives a literal `$`. **[INFERRED]**

### 3.1 Which `$symbols` exist depends on the report type

Every report has: `$user`, `$entity(id)`, `$docnote(path, part=, client=, params=, mode=)`,
`$mergeid`, `$barcodeid`, `$barcode`, `$signature`, `$logo`, `$logo_rr`,
`$logo_ss`, `$grouplogo`…`$grouplogo4`, `$iress_copyright`,
`$conflict_disclosure(...)` and `$chart` (`tplutil.py:512-916`).

| Report class (`tplutil.py`) | Context | Extra symbols |
|---|---|---|
| `ClientReport` :1344 | Single client (the main case for adviser reports) | `$client`, `$partner`, `$supplier`, `$referrer`, `$profadviser`, `$clientgroup(reltype)`, `$company`, `$individual`, `$partnership`, `$superfund`, `$trust`, `$associatedowner(id)`, `$identitycheck_options` |
| `TaskClientReport` :1518 | Client report started from a task | + `$task` |
| `FeeConsentReport` :1641 | Fee consent | as client; use `$client.fee_consent_account(s)` |
| `InvoiceReport` :1585 / `InvoicePaymentReport` :1544 | Invoicing | + `$invoice` / `$payment` |
| `DiaryEventReport` :1677 | Appointment | `$client`, `$clients`, `$diaryevent` |
| `EntityListReport` :1754 | Many clients in one document | `$entities` (**no `$client`**) |
| `SingleCampaignEntityListReport` :1802 / `MultiCampaignReport` :1816 | Campaigns | `$entities`, `$campaign` / `$campaigns` |
| `GroupplanReport` :2185 | Group plan member | `$client`, `$groupplan`, `$member` |
| `PortfolioGroupReport` :1322 | IPS account group | `$portfolio_group`, `$account_group` |
| `ComplianceReport` :1930, `EntityComplianceReport` :1891, `BreachReport` :2054 | Compliance | `$compliance`, `$occurrence`, `$breaches*`, `$breach`, `$entity` (in this context `$entity` is an object, not a function) |
| `IOSPlusAdviceClientReport` :1831 | IOS+ advice | `$client`, `$partner`, `$ios_advice_list`, … |

Notes:
- `$superplan` is broken (`xpt/report/superplan.py` is commented out). Never use it.
- Emails, auto-emails, note templates and diary text use a **different** engine
  (`xpt.factfind.templateobj`). This reference does not apply to them.

### 3.2 Built-in globals

> **Use the `$` form for helper functions.** The functions installed as
> `tpl[...]` items (`uda`, `var`, `call`, `flags`, `LOCALE`, …) appear in the
> corpus only with `$`: `$uda` 215 times, `$var` 107, `$LOCALE` 84. The bare
> forms (`uda(`, `var(`) never appear and are unproven. Globals from
> `setGlobalVars` / `tplvars` (`datetime_merge`, `dateutils`, `currency`,
> `htmlit`) are used **without** `$`.

| Name | Use |
|---|---|
| `$var('%key%')` | Run-time prompt or substitute values. Built-in keys include `clientid`, `partnerid`, `__user_id`, `wizard_scenarioid`, `fee_consent_id`. Regex `%key(:opt=val)?%` (`tplutil.py:1227-1258`). Values are passed through `str()`. A key with an **empty** value is dropped (`reportstate.py:502-508`) and then renders as the literal `%key%`. In `%key:opt=val%`, the `:opt=val` part is matched and **discarded** at merge time; the whole token becomes the value (`tplutil.py:1249-1257`) |
| `$possiblevar('%name%', domain, subdomain)` | Design-time pick-list prompt. At run time it returns the substitute value or `""` (`tplutil.py:1105-1112`; design-time scan in `xpt/report/possiblevar.py:652-727`) |
| `$uda(path, valtype='html'|'image'|'file', ignoremissing=False, **kw)`, `$udaexists(path)`, `$udalist(path)` | Read XTools / UDA tree output (`tplutil.py:1114-1224`). Raises when the path is missing unless `ignoremissing=True` |
| `call('cashflow', income=, summary=, year=, month=, value=)` | Cashflow table. This is the only registered `call` (`xpt/report/call.py:49`) |
| `flags('output_by_syntax', value=[...])` | Controls the output filename (`xpt/report/flag_value.py`) |
| `_('text')`, `gettext`, `ngettext`, `set_language('af_ZA')` | Translation and language |
| `LOCALE` | Site locale string: `AU`, `NZ`, `GB`, `ZA`, … |
| `datetime_merge` | The current time as `OOoDateTime`: `<:=datetime_merge.format('%d %B %Y'):>` |
| `currency(v, has_decimal=True, blank_zero=False, has_symbol=False)`, `convert_currency`, `currency_fx_rate` | Money formatting (`tplvars.py:208-272`) |
| `htmlit(html)`, `table_it(rows, table_format)`, `remove_format`, `pagenum()`, `pagecount()`, `code128`, `to_yesno` | Rich content |
| `multikeysort`, `average`, `floatify`, `filter_entities`, `math.*`, `json_encode`/`json_decode`, `reduce`, `cmp` | Utilities |
| `dateutils.*` (e.g. `dateutils.dateToStr(int, format=...)`), `getToday`, `get_date`, `datediff`, `now`, `Week`/`Day`/… | Dates |
| `portfolio_account(pid, sfid)`, `accounts_by_portfolio(pid)`, `group_by_groupcode(code)` | IPS portfolio objects |

## 4. The `$client` data model

### 4.1 How `$client.X` is resolved (`xpt/report/entity.py:152-176`)

1. Real Python attributes and properties on `TemplateEntity` are tried first.
   These are computed attributes such as `partner`, `client_adviser`,
   `portfolios()` and `DoReport`.
2. `X == "value"` returns the entity id.
3. Wizard-scenario indirection, when a wizard scenario is active. `.original`
   bypasses it.
4. **List**: `getList(X)`. If a ufield group `entity_<X>` exists, the result
   is a `TemplateList`. Some lists are special-cased: `insurance`,
   `insurance_group`, `retirement_fund`/`fund_za`, `annuity`, `feeforservice`.
5. **Field**: `getField(X)` looks in ufield group `entity`. An invalid name
   raises `ValueError`, which appears as an in-document merge error.

So **scalar fields** = ufield group `entity`; **lists** = groups `entity_<list>`.
Definitions live in `data/ufield/*.xml` plus site custom fields stored in the
DB (see `requirements.md` §5 for how to get the catalog).

### 4.2 Field value objects (`tplutil.py:575-610`, `xpt/report/ooo.py`)

| Field type | Object | Key behaviour |
|---|---|---|
| Most fields | `UFieldOOoElement` | `<:=x:>` gives the **formatted** value (choice label, money format). `x.value` gives the **raw** value (choice code, number). `x.text` is plain text. `str(x)` is the **raw** value. `x == v` compares raw values. `float(x)`/`int(x)` give 0 when empty |
| Date | `OOoDateTime` | `.format('medium' or '%d/%m/%Y')`, `.date`, `.value`, `int(x)` gives YYYYMMDD. Falsy when empty |
| Date with `dateonly`/`no_year` flag | **Plain string** | No `.format()` |
| Image | `ImageOOoElement` | Callable to resize: `<:=$logo(width='4cm', height='1cm'):>` |
| Questionnaire | `QuestionnaireOOoElement` | `[key]`, `qa_value`, iteration |
| Ownership | `OOoOwnership` | Iterable |

**Rule for choice fields:** compare raw codes, print formatted values.
`<:if str(item.owner.value)=='client':>` / `<:=item.owner:>`.

### 4.3 Lists (`TemplateList`, `entity.py:3647+`)

- `for` over a list gives `TemplateListItem`s. Supports `len()`, `[i]` and `get_item_by_id(id)`.
- `.filter('field=val, f2>3')`. Operators: `= != <> < > ~` (`~` is "contains").
  There is **no `>=` or `<=`**, and values **cannot contain commas**, because
  the filter string is split on `,`.
- `.sort('field,-field2')`.
- `.sum('field')` (formatted) and `.sum_raw('field')` (float). Multi-currency values are converted.
- `.table(column='*', sort=, width='3,2,1', filter=, total=, heading=True, format=None)` returns a ready-made table.
- An item's attributes are the fields of group `entity_<list>`, plus `index`,
  `list_name`, `note`, `last_updated_by`, `last_updated_at`.
- Some lists have richer item classes (`entity.py:3648-3705`):
  - `asset`: `owner_list`, `linked_liabilities`, `net_position`, `provider`, `underlying_funds`
  - `liability`: `asset_links`
  - `fund`: `beneficiary_list`, `insurance_policies`, `contributions`, `investment_options`
  - `employment`: `linked_income`
  - `objectives`: `linked_goals`, `review_chart(...)`

### 4.4 Key computed attributes on `TemplateEntity`

- **Advisers:** `client_adviser`, `client_adviser_{administrator,insurance,investment,mortgage,paraplanner,secondary,service,accountant,general_insurance}`
- **People:** `partner` / `marriage_partner`, `clientgroup(reltype)`, `company_directors`, `trust_trustees`, `get_entity(id)`
- **Address:** `preferred_address` (falls back to the partner's), `address` list
- **Notes and workflow:** `note` (documents; `.filter(date=, keyword=)`), `tasks_client`, `threads_client[_current|_past]`, `containers_client`
- **Insurance:** `insurance` (covers), `insurance_group` (policies), `insurance_by_policy`, `iqm2_scenario(...)` (implementation differs by locale)
- **Portfolio:** `portfolios(joint, shared)`, `portfolio_accounts(...)`, `account_groups(...)`, `portfolio_progress_chart`
- **Cashflow:** `budget_tracking(...)`, `actual_cashflow_list(...)`, `get_cashflow()`
- **Super and retirement:** `super_contribution_summaries`, `retire_invest_scenarios`, `savings_scenario(name)`
- **Risk:** `risk_profile` (`.attitude_to_risk(is_joint).risk_profile_desc`)
- **Commission:** `commpay_policies(from_date, to_date, ...)` and the other `commpay_*` methods
- **Raw helpers:** `valueOf(field)` (raw value), `imageOf(field, w, h)`, `table(listname, ...)`
- **`DoReport`:** pluggable report data. `$client.DoReport.<ns>.<report>(valtype='html'|'image'|'value', **kw)`.
  Namespaces: `ips`, `ipsv` (raw values), `ipsr`, `ipsp`, `aegis*`, `iress_riskprofiler`.
  Example: `$client.DoReport.ipsv.any_report('value', portfolios='CX', date='a-b', report_source='commpay_policies')`.
  The names of the individual reports are registered at run time **[not catalogued]**.

### 4.5 Empty and missing values

- `$partner` when there is no partner is a falsy `TemplateEntity(None)`.
  **Accessing any field on it raises "Entity does not exist".** Always guard:
  `<:if $partner:> … <:end:>`.
- `$supplier`, `$referrer` and `$profadviser` are `None` unless passed in.
- An unknown `$symbol` gives `""` silently. An unknown field gives an error.
- `$uda(...)` raises when the path is missing unless `ignoremissing=True`.
- **Output depends on who runs the report.** `tfn` becomes `tfn_supplied` in
  AU when the user lacks `view_tfn`, and `xpt_aml_risk_management_*` fields
  are masked when the user lacks the AML capability (`entity.py:729-745`).

## 5. Rich content

- **HTML:** `<:=htmlit('<b>x</b>'):>`. HTML fields are sanitised (`HtmlTextOOoElement`).
- **Tables:** `list.table(...)`, `table_it(rows, 'FormatName')` (named site table formats, `xpt/report/tablefmt.py`).
- **Charts:** `$chart.bar(data, opts)`, `.pie`, `.donut`, `.line`, `.boxline` (`xpt/report/chart.py`).
  `data` for `bar` is `{'labels': [...], 'values': [(a, b), ...]}`. All of them return images.
- **Images:** `$logo`, `$grouplogo`, `$signature`, `imageOf(field, w, h)`, `uda(path, 'image')`,
  `render_app(app, w, h, params)`.
- **Embed a library document:** `<:=$docnote('Category/Subject', part='file.txt'):>`.
- **Page numbers:** `pagenum()`, `pagecount()`. No dedicated page-break or section API was found.

## 6. Execution semantics that matter for generation

- **Errors do not abort the merge by default.** Each failing marker is
  replaced by `Err: <message>` in the output document and the merge continues
  (`src/py/xtest/report/assertions.py:3-9`). In the ODF the error marker is
  `<text:span text:style-name="OOOb">Err</text:span>:`.
  An automated flow must therefore **scan the rendered output for that span**.
  Strict mode (`exclude_report_with_merge_error`, `producer.py:1431`) is set
  only by the mass, recipients and groupplan runners. It **cannot be reached
  through the ad hoc or template-v3 RAPI**.
- **Sandbox:** `xlib/reval.py` (in `iress-xlib`) only allows certain kinds of
  Python code, and refuses every attribute or key starting with `_` (not just
  dunders); `xpt/decoratorutil.py:184-205` only guards wrapper objects,
  DB transaction objects are forbidden (`xpt/report/__init__.py:8-18`), and
  `open`/`eval`/`exec`/`__import__` are blocked in the sibling engine
  (`xpt/template.py:477-547`). Write only pure expressions. No imports, no I/O.
- **Python 2 idioms work** (`<>`, `dict.has_key`, integer `/`) because of 2to3
  plus helper functions (`xpt/template_helpers.py`). Generated code should
  still be Python 2/3-neutral.
- **Locale:** which fields exist is gated per locale (`#ifdef LOCALE_AU` in the
  ufield XML). Dates use babel with the current language; explicit strftime
  patterns bypass the locale. Branch on `LOCALE` when needed.
- **Limits:** output is capped at 1 GB (`producer.py:125`). Async jobs can run
  for up to 2 days (`JF_LONG_JOB`). There is no per-template CPU limit.

## 7. Debugging snippets (from `architecture.md`)

> **For people only. Remove this section from the RAG corpus.** These snippets
> introspect the template scope, and `dev/guardrails.json` forbids them in
> generated templates.

```
<:=repr($client.DoReport.ipsv.management_fee):>
<:=sorted(globals().keys()):>
<:for k in sorted(vars(__tpl).keys()):><:=str(k):> => <:=str(vars(__tpl)[k]):>
<:end:>
```

`dir($client)` will **not** show ufield fields, because they are resolved
dynamically in `__getattr__`.

## 8. Canonical idioms (real corpus snippets)

```
Dear <:=$client.first_name:>,                                  (scalar field)
<:=datetime_merge.format('%d %B %Y'):>                         (today)
<:=$partner.dob.strftime('%d/%m/%Y'):>                         (date)

<:if $partner:>Partner: <:=$partner.name:><:end:>              (guard)

<:let count=0:><:for item in $client.goals:>                   (paragraph loop)
Goal <:=count + 1:>
<:let count=count+1:>
<:end:>

<:for item in $client.address.filter('preferred=True'):>       (filtered list)
<:=item.street:>
<:end:>

<:if str(item.owner.value)=='client':>☒<:else:>☐<:end:>        (choice code test)

<:let tax_list=[t for t in $client.tax_residency if t.country.value!='AU' and t.is_tax_resident]:>

<:let start_date=$var('%date1_start_date_YYYYMMDD%'):>         (run-time prompt)
<:=dateutils.dateToStr(int(start_date), format='%d %B %Y'):>

<:let groupid = int($client.client_adviser.user_group_primary.value):>
<:=$entity(groupid).preferred_phone:>                          (related entity)

<:=$client.table('asset', column='*', total=True):>            (auto table)
<:=$chart.bar({'labels':['A','B'], 'values':[(1,2)]}, {'chart_title':'X'}):>
<:=$docnote('XMERGE Library/the-top-docnote', part='plain.txt'):>
<:=$uda('xtools/output/client %clientid%/CALM/scenario %scenario%/Chart/Individual/CALM', 'image'):>
                                                               (extra kwargs such as View_All are passed to the
                                                                XTools C++ side; no Python code reads them)
```

## 9. Generation checklist (for the AI)

1. Confirm which report type is in use, which decides the available `$symbols`. Default: `ClientReport`.
2. Every `$client.<x>` / `item.<x>` must exist in the site field catalog or in
   the computed-attribute catalog. Never invent a name; an unknown `$symbol` fails silently.
3. Guard optional entities (`$partner`, `$supplier`) and optional UDA paths.
4. Compare raw values (`.value`) and print formatted values.
5. Use only `= let if else for end`. Every block is closed with `<:end:>`.
6. Put loop markers in their own paragraph or table row, as in §2.2.
7. No imports, no I/O, no dunders, straight quotes only.
8. Use the `$` form for `tpl` helpers (`$var`, `$uda`, `$LOCALE`).
9. After rendering, fail the job if the output contains the `OOOb` `Err` span.
