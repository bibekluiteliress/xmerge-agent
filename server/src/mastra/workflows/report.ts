// The guided report workflow and the revise workflow (follow-up chat on an existing template).
// Model steps stream their text to the UI through the step writer; code steps report a summary.
import type { Agent } from '@mastra/core/agent'
import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { catalog } from '../../lib/catalog.js'
import { gate } from '../../lib/gate.js'
import { MAX_REPAIRS, extractDesign, extractTemplate, looksLikeDesign, parseDesign, repairPrompt, reviseRequest, stripTemplate, writeRequest } from '../../lib/flow.js'
import { ensureSiteFlags, groupsInTemplate } from '../../lib/siteflags.js'

const Message = z.object({ role: z.enum(['user', 'assistant']), content: z.string() })
type Msg = z.infer<typeof Message>
type Writer = { write: (data: unknown) => Promise<void> } | undefined

/** Stream one agent reply to the UI as {kind:'delta'} events and return the full text. */
async function streamAgent(agent: Agent, messages: Msg[], writer: Writer, step: string): Promise<string> {
  const out = await agent.stream(messages.map((m) => (m.role === 'user' ? { role: 'user' as const, content: m.content } : { role: 'assistant' as const, content: m.content })))
  for await (const text of out.textStream) await writer?.write({ kind: 'delta', step, text })
  return out.text
}

const Loop = z.object({
  messages: z.array(Message), // the writer conversation, so a repair sees what it wrote
  reply: z.string(),
  attempt: z.number(),
  calls: z.number(),
  done: z.boolean(),
  gate: z.any().optional(),
})

const designStep = createStep({
  id: 'design',
  description: 'Agent: request -> report design in the house style',
  inputSchema: z.object({ request: z.string() }),
  outputSchema: z.object({ design: z.string(), calls: z.number() }),
  execute: async ({ inputData, mastra, writer }) => {
    if (looksLikeDesign(inputData.request)) {
      await writer?.write({ kind: 'info', step: 'design', text: 'Using your design as written.' })
      return { design: extractDesign(inputData.request), calls: 0 }
    }
    const reply = await streamAgent(mastra.getAgent('designerAgent'), [{ role: 'user', content: inputData.request }], writer, 'design')
    return { design: extractDesign(reply), calls: 1 }
  },
})

const fieldsStep = createStep({
  id: 'fields',
  description: 'Code: design -> field sheet from the loaded fields',
  inputSchema: z.object({ design: z.string(), calls: z.number() }),
  outputSchema: z.object({ user: z.string(), calls: z.number() }),
  execute: async ({ inputData, writer }) => {
    // Site flags first (only when XWord came from a site), so the sheet shows each field's real policy.
    const flags = await ensureSiteFlags(['entity', ...parseDesign(catalog, inputData.design).areas.map((a) => `entity_${a}`)])
    const req = writeRequest(catalog, inputData.design)
    await writer?.write({
      kind: 'info', step: 'fields',
      summary: {
        points: req.parsed.points.length, areas: req.parsed.areas, warnings: req.parsed.warnings, unmatched: req.unmatched,
        sheetChars: req.sheetChars, source: catalog.source.label,
        flags: flags.length ? (flags.some((f) => f.status === 'failed') ? 'partly from the site' : 'from the site') : 'standard',
        flagErrors: flags.filter((f) => f.status === 'failed').map((f) => `${f.group}: ${f.message}`),
      },
    })
    return { user: req.user, calls: inputData.calls }
  },
})

const writeStep = createStep({
  id: 'write',
  description: 'Agent: design + field sheet + language reference -> template',
  inputSchema: z.object({ user: z.string(), calls: z.number() }),
  outputSchema: Loop,
  execute: async ({ inputData, mastra, writer }) => {
    const messages: Msg[] = [{ role: 'user', content: inputData.user }]
    const reply = await streamAgent(mastra.getAgent('writerAgent'), messages, writer, 'write')
    return { messages, reply, attempt: 0, calls: inputData.calls + 1, done: false }
  },
})

const reviseStep = createStep({
  id: 'revise',
  description: 'Agent: apply a follow-up request to the current template',
  inputSchema: z.object({ template: z.string(), instruction: z.string() }),
  outputSchema: Loop,
  execute: async ({ inputData, mastra, writer }) => {
    await ensureSiteFlags(groupsInTemplate(inputData.template))
    const { user } = reviseRequest(catalog, inputData.template, inputData.instruction)
    const messages: Msg[] = [{ role: 'user', content: user }]
    const reply = await streamAgent(mastra.getAgent('writerAgent'), messages, writer, 'revise')
    return { messages, reply, attempt: 0, calls: 1, done: false }
  },
})

const gateStep = createStep({
  id: 'check',
  description: 'Code: validator; Agent: repair when something must be fixed',
  inputSchema: Loop,
  outputSchema: Loop,
  execute: async ({ inputData, mastra, writer }) => {
    const template = extractTemplate(inputData.reply)
    const result = template ? await gate(template) : null
    const problems = result ? result.problems : ['the reply had no ```xmerge block; send the complete template in one']
    await writer?.write({ kind: 'info', step: 'check', attempt: inputData.attempt, problems })
    if (!problems.length || inputData.attempt >= MAX_REPAIRS) return { ...inputData, done: true, gate: result }
    const messages: Msg[] = [...inputData.messages, { role: 'assistant', content: inputData.reply }, { role: 'user', content: repairPrompt(problems) }]
    const reply = await streamAgent(mastra.getAgent('writerAgent'), messages, writer, 'repair')
    return { messages, reply, attempt: inputData.attempt + 1, calls: inputData.calls + 1, done: false, gate: result }
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
  inputSchema: z.object({ request: z.string() }),
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
  inputSchema: z.object({ template: z.string(), instruction: z.string() }),
  outputSchema: Result,
})
  .then(reviseStep)
  .dountil(gateStep, async ({ inputData }) => inputData.done)
  .then(finishStep)
  .commit()
