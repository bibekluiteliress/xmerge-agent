// The guided report workflow and the revise workflow (follow-up chat on an existing template).
// Model steps stream their text to the UI through the step writer; code steps report a summary.
import type { Agent } from '@mastra/core/agent'
import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { callOptions, guardedContent, retrieveSamples, samplesSection } from '../../lib/bedrock.js'
import { catalog } from '../../lib/catalog.js'
import { gate } from '../../lib/gate.js'
import { MAX_REPAIRS, designRequest, extractDesign, extractTemplate, historySection, looksLikeDesign, parseDesign, repairPrompt, reviseRequest, stripTemplate, writeRequest } from '../../lib/flow.js'
import { ensureSiteFlags, groupsInTemplate } from '../../lib/siteflags.js'

// guard: the adviser's own text inside content, the only part the Bedrock guardrail checks (AWS-G19).
const Message = z.object({ role: z.enum(['user', 'assistant']), content: z.string(), guard: z.array(z.string()).optional() })
type Msg = z.infer<typeof Message>
type Writer = { write: (data: unknown) => Promise<void> } | undefined

const History = z.array(z.string()).default([]) // the adviser's earlier requests for this report

/**
 * Stream one agent reply to the UI as {kind:'delta'} events and return the full text. Each call is
 * stateless: the agents have no memory, so a call sees only the messages given here.
 */
async function streamAgent(agent: Agent, messages: Msg[], writer: Writer, step: string): Promise<string> {
  const out = await agent.stream(messages.map((m) => (m.role === 'user' ? { role: 'user' as const, content: guardedContent(m.content, m.guard) } : { role: 'assistant' as const, content: m.content })), callOptions())
  for await (const text of out.textStream) await writer?.write({ kind: 'delta', step, text })
  const text = await out.text
  // A failed model call does not throw: the stream just ends empty, with the cause in out.error.
  if (out.error) throw new Error(modelError(out.error))
  if ((await out.finishReason) === 'content-filter') throw new Error(`The Bedrock guardrail blocked this request${text.trim() ? `: ${text.trim()}` : '.'}`)
  if (!text.trim()) throw new Error('The model sent an empty reply. Try again.')
  return text
}

/** What the adviser needs to know about a failed Bedrock call. */
export function modelError(err: Error): string {
  const e = err as Error & { statusCode?: number; responseBody?: string }
  let detail = e.message
  try {
    const body = JSON.parse(e.responseBody ?? '{}') as { Message?: string; message?: string }
    detail = body.Message ?? body.message ?? detail
  } catch { /* not JSON */ }
  if (/expired|security token|credential|signature/i.test(detail) || e.statusCode === 401 || e.statusCode === 403) {
    return `Bedrock refused the call: ${detail}. Put a fresh AWS_BEARER_TOKEN_BEDROCK in .env and restart ./run.sh.`
  }
  return `The model call failed: ${detail}`
}

const Loop = z.object({
  messages: z.array(Message), // the writer conversation, so a repair sees what it wrote
  reply: z.string(),
  attempt: z.number(),
  calls: z.number(),
  done: z.boolean(),
  answerOk: z.boolean().default(false), // a follow-up may be a question: a reply without a template is an answer
  gate: z.any().optional(),
})

const designStep = createStep({
  id: 'design',
  description: 'Agent: request -> report design in the house style',
  inputSchema: z.object({ request: z.string(), history: History }),
  outputSchema: z.object({ request: z.string(), design: z.string(), calls: z.number() }),
  execute: async ({ inputData, mastra, writer }) => {
    const { request, history } = inputData
    if (looksLikeDesign(request)) {
      await writer?.write({ kind: 'info', step: 'design', text: 'Using your design as written.' })
      return { request, design: extractDesign(request), calls: 0 }
    }
    const reply = await streamAgent(mastra.getAgent('designerAgent'), [{ role: 'user', content: designRequest(request, history), guard: [request, historySection(history)] }], writer, 'design')
    return { request, design: extractDesign(reply), calls: 1 }
  },
})

const fieldsStep = createStep({
  id: 'fields',
  description: 'Code: design -> field sheet from the loaded fields, plus sample templates from the knowledge base',
  inputSchema: z.object({ request: z.string(), design: z.string(), calls: z.number() }),
  outputSchema: z.object({ user: z.string(), design: z.string(), calls: z.number() }),
  execute: async ({ inputData, writer }) => {
    // Site flags first (only when XWord came from a site), so the sheet shows each field's real policy.
    const [flags, kb] = await Promise.all([
      ensureSiteFlags(['entity', ...parseDesign(catalog, inputData.design).areas.map((a) => `entity_${a}`)]),
      retrieveSamples(inputData.request),
    ])
    const req = writeRequest(catalog, inputData.design, samplesSection(kb.samples))
    await writer?.write({
      kind: 'info', step: 'fields',
      summary: {
        points: req.parsed.points.length, areas: req.parsed.areas, warnings: req.parsed.warnings, unmatched: req.unmatched, notAllowed: req.blocked,
        sheetChars: req.sheetChars, source: catalog.source.label,
        flags: flags.length ? (flags.some((f) => f.status === 'failed') ? 'partly from the site' : 'from the site') : 'standard',
        flagErrors: flags.filter((f) => f.status === 'failed').map((f) => `${f.group}: ${f.message}`),
        samples: kb.samples.map((s) => s.source), samplesError: kb.error,
      },
    })
    return { user: req.user, design: inputData.design, calls: inputData.calls }
  },
})

const writeStep = createStep({
  id: 'write',
  description: 'Agent: design + field sheet + language reference -> template',
  inputSchema: z.object({ user: z.string(), design: z.string(), calls: z.number() }),
  outputSchema: Loop,
  execute: async ({ inputData, mastra, writer }) => {
    // The design stands in for the adviser's request here: it is their request in the house notation.
    const messages: Msg[] = [{ role: 'user', content: inputData.user, guard: [inputData.design] }]
    const reply = await streamAgent(mastra.getAgent('writerAgent'), messages, writer, 'write')
    return { messages, reply, attempt: 0, calls: inputData.calls + 1, done: false , answerOk: false }
  },
})

const reviseStep = createStep({
  id: 'revise',
  description: 'Agent: apply a follow-up request to the current template',
  inputSchema: z.object({ template: z.string(), instruction: z.string(), history: History }),
  outputSchema: Loop,
  execute: async ({ inputData, mastra, writer }) => {
    await ensureSiteFlags(groupsInTemplate(inputData.template))
    // Check the template as it is first (a pasted one, or a hand edit), so the writer fixes what is broken too.
    const { problems } = await gate(inputData.template)
    if (problems.length) await writer?.write({ kind: 'info', step: 'revise', text: `found ${problems.length} problem${problems.length === 1 ? '' : 's'} to fix` })
    const { user } = reviseRequest(catalog, inputData.template, inputData.instruction, inputData.history, problems)
    const messages: Msg[] = [{ role: 'user', content: user, guard: [inputData.instruction, historySection(inputData.history)] }]
    const reply = await streamAgent(mastra.getAgent('writerAgent'), messages, writer, 'revise')
    return { messages, reply, attempt: 0, calls: 1, done: false, answerOk: true }
  },
})

const gateStep = createStep({
  id: 'check',
  description: 'Code: validator; Agent: repair when something must be fixed',
  inputSchema: Loop,
  outputSchema: Loop,
  execute: async ({ inputData, mastra, writer }) => {
    const template = extractTemplate(inputData.reply)
    if (!template && inputData.answerOk && inputData.attempt === 0) {
      await writer?.write({ kind: 'info', step: 'check', attempt: 0, problems: [], text: 'answered; the document is unchanged' })
      return { ...inputData, done: true, gate: null }
    }
    const result = template ? await gate(template) : null
    const problems = result ? result.problems : ['the reply had no ```xmerge block; send the complete template in one']
    await writer?.write({ kind: 'info', step: 'check', attempt: inputData.attempt, problems })
    if (!problems.length || inputData.attempt >= MAX_REPAIRS) return { ...inputData, done: true, gate: result }
    const messages: Msg[] = [...inputData.messages, { role: 'assistant', content: inputData.reply }, { role: 'user', content: repairPrompt(problems) }]
    // The repair runs inside this step, so it reports its own start and end for the chat's step list.
    await writer?.write({ kind: 'step', step: 'repair', status: 'running' })
    const reply = await streamAgent(mastra.getAgent('writerAgent'), messages, writer, 'repair')
    await writer?.write({ kind: 'step', step: 'repair', status: 'success' })
    return { ...inputData, messages, reply, attempt: inputData.attempt + 1, calls: inputData.calls + 1, done: false, gate: result }
  },
})

const Result = z.object({ template: z.string().nullable(), notes: z.string(), calls: z.number(), gate: z.any() })

const finishStep = createStep({
  id: 'finish',
  inputSchema: Loop,
  outputSchema: Result,
  execute: async ({ inputData }) => ({
    template: extractTemplate(inputData.reply),
    notes: stripTemplate(inputData.reply),
    calls: inputData.calls,
    gate: inputData.gate ?? null,
  }),
})

export const reportWorkflow = createWorkflow({
  id: 'guided-report',
  description: 'Design the report, build the field sheet, write the template, then check and repair it.',
  inputSchema: z.object({ request: z.string(), history: History }),
  outputSchema: Result,
})
  .then(designStep)
  .then(fieldsStep)
  .then(writeStep)
  .dountil(gateStep, async ({ inputData }) => inputData.done)
  .then(finishStep)
  .commit()

export const reviseWorkflow = createWorkflow({
  id: 'revise-report',
  description: 'Apply a follow-up request to the current template, then check and repair it.',
  inputSchema: z.object({ template: z.string(), instruction: z.string(), history: History }),
  outputSchema: Result,
})
  .then(reviseStep)
  .dountil(gateStep, async ({ inputData }) => inputData.done)
  .then(finishStep)
  .commit()
