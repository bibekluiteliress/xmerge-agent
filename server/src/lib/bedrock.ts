// Amazon Bedrock settings every model call shares: the guardrail, prompt caching and the sample-template
// knowledge base. All of them are optional and come from .env (run.sh exports them):
//
//   XMS_GUARDRAIL_ID, XMS_GUARDRAIL_VERSION   a Bedrock guardrail on every model call (published version)
//   XMS_KB_ID                                 a Bedrock knowledge base of sample templates
//
// The knowledge base Retrieve API does not accept the Bedrock API key (it answers 403 asking for a
// SigV4 signature), so it is signed with AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN,
// which `authenticate` exports (./run.sh --auth). The model keeps using the API key when one is set.
import { AwsClient } from 'aws4fetch'

const region = () => process.env.AWS_REGION ?? 'ap-southeast-2'

const guardrailId = () => process.env.XMS_GUARDRAIL_ID?.trim() || ''

/**
 * Converse options for every call: the guardrail when XMS_GUARDRAIL_ID is set. The version must be a
 * published number (infra/bedrock-guardrails/deploy.sh prints it), never DRAFT, which anyone with edit
 * rights can change under a running app (AWS-G18).
 */
export function callOptions() {
  const id = guardrailId()
  if (!id) return {}
  const version = process.env.XMS_GUARDRAIL_VERSION?.trim() ?? ''
  if (!/^[1-9]\d*$/.test(version)) {
    throw new Error(`XMS_GUARDRAIL_VERSION must be a published guardrail version number, not "${version || 'unset'}" (see infra/bedrock-guardrails/deploy.sh).`)
  }
  return { providerOptions: { bedrock: { guardrailConfig: { guardrailIdentifier: id, guardrailVersion: version } } } }
}

type TextPart = { type: 'text'; text: string; providerOptions?: { bedrock: { guardContent: true } } }

/**
 * A user message's content with the adviser's own text marked as guardContent. With a guard block in
 * the call, the guardrail checks only that text, not the field sheet, samples or template around it
 * (AWS-G19). Each guard is found in the content as written; one that is not there is skipped. Without
 * a guardrail, or with nothing to guard, the content stays a plain string.
 */
export function guardedContent(content: string, guard: string[] = []): string | TextPart[] {
  if (!guardrailId()) return content
  const spans: [number, number][] = []
  for (const g of new Set(guard.filter((s) => s.trim()))) {
    const at = content.indexOf(g)
    if (at >= 0) spans.push([at, at + g.length])
  }
  spans.sort((a, b) => a[0] - b[0])
  const parts: TextPart[] = []
  let pos = 0
  for (const [start, end] of spans) {
    if (start < pos) continue // overlaps an earlier guard, which already covers it
    if (start > pos) parts.push({ type: 'text', text: content.slice(pos, start) })
    parts.push({ type: 'text', text: content.slice(start, end), providerOptions: { bedrock: { guardContent: true } } })
    pos = end
  }
  if (!parts.length) return content
  if (pos < content.length) parts.push({ type: 'text', text: content.slice(pos) })
  return parts
}

/** A system prompt Bedrock caches: the writer's rules and language reference are the same every call. */
export const cachedSystem = (content: string) => ({
  role: 'system' as const,
  content,
  providerOptions: { bedrock: { cachePoint: { type: 'default' } } },
})

export interface Sample {
  text: string
  source: string
  score: number
}

// samples/*.md are at most about 16K characters (one SOA section); the budget keeps a call slim, so a big
// closest sample goes in whole rather than two cut ones.
const MAX_SAMPLE_CHARS = 16_000
const SAMPLES_BUDGET = 20_000

// Knowledge bases found to be managed ones, which search with managedSearchConfiguration.
const managedKbs = new Set<string>()

/** The sample templates closest to the request, from the knowledge base. No XMS_KB_ID: none. */
export async function retrieveSamples(query: string, count = 2): Promise<{ samples: Sample[]; error?: string }> {
  const kb = process.env.XMS_KB_ID?.trim()
  if (!kb || !query.trim()) return { samples: [] }
  const url = `https://bedrock-agent-runtime.${region()}.amazonaws.com/knowledgebases/${encodeURIComponent(kb)}/retrieve`
  const retrieve = async () => {
    const search = managedKbs.has(kb) ? 'managedSearchConfiguration' : 'vectorSearchConfiguration'
    const res = await post(url, JSON.stringify({
      retrievalQuery: { text: query.slice(0, 1000) },
      retrievalConfiguration: { [search]: { numberOfResults: count } },
    }))
    return { res, data: (await res.json().catch(() => ({}))) as { message?: string; retrievalResults?: Result[] } }
  }
  try {
    let { res, data } = await retrieve()
    // A managed knowledge base rejects vectorSearchConfiguration and names the one it takes: switch once, remember.
    if (!res.ok && !managedKbs.has(kb) && /managedSearchConfiguration/.test(data.message ?? '')) {
      managedKbs.add(kb)
      ;({ res, data } = await retrieve())
    }
    if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`)
    const samples: Sample[] = []
    let used = 0
    for (const r of data.retrievalResults ?? []) {
      const text = r.content?.text?.trim().slice(0, MAX_SAMPLE_CHARS)
      if (!text || (samples.length && used + text.length > SAMPLES_BUDGET)) continue
      samples.push({ text, source: sourceOf(r), score: r.score ?? 0 })
      used += text.length
    }
    return { samples }
  } catch (err) {
    const message = `knowledge base ${kb}: ${err instanceof Error ? err.message : String(err)}`
    console.warn(`retrieve: ${message}`)
    return { samples: [], error: message }
  }
}

interface Result {
  content?: { text?: string }
  location?: { s3Location?: { uri?: string }; customDocumentLocation?: { id?: string }; type?: string }
  score?: number
}

// S3 data sources give the object URI; custom ones the document id, which upload-samples.sh sets to the file name.
const sourceOf = (r: Result) =>
  r.location?.s3Location?.uri?.split('/').pop() || r.location?.customDocumentLocation?.id || r.location?.type || 'sample'

async function post(url: string, body: string): Promise<Response> {
  const { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey, AWS_SESSION_TOKEN: sessionToken } = process.env
  if (!accessKeyId || !secretAccessKey) throw new Error('no AWS credentials; the Bedrock API key does not work for knowledge bases (run ./run.sh --auth)')
  const aws = new AwsClient({ accessKeyId, secretAccessKey, sessionToken, region: region(), service: 'bedrock' })
  return aws.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
}

/** The samples as one prompt section; empty when there are none. */
export function samplesSection(samples: Sample[]): string {
  if (!samples.length) return ''
  const parts = samples.map((s, i) => `<sample n="${i + 1}" source="${s.source}">\n${s.text.trim()}\n</sample>`)
  return [
    '<sample_templates>',
    'House examples from the template library. Follow their layout, wording style and XMerge idioms, but',
    'write only what the design asks for and use only fields from the field sheet.',
    ...parts,
    '</sample_templates>',
  ].join('\n')
}
