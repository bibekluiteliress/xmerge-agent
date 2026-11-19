import { bedrock } from '@ai-sdk/amazon-bedrock'
import { Agent } from '@mastra/core/agent'
import { catalog } from '../lib/catalog.js'
import { designerInstructions, writerInstructions } from '../lib/flow.js'

// Claude on Amazon Bedrock through the AI SDK provider (Converse API). It reads AWS_REGION and
// AWS_BEARER_TOKEN_BEDROCK (or the usual AWS credential chain) from the environment.
// au.anthropic.claude-opus-5-5 is the Australian inference profile enabled in wealth-dev-au.
const model = bedrock(process.env.XMS_MODEL ?? 'au.anthropic.claude-opus-5-5')

/** Step 1: turns the adviser's request into a report design in the house style (prompts/design.md). */
export const designerAgent = new Agent({
  id: 'designer',
  name: 'Report designer',
  description: 'Designs a client report document with {{data points}} and [[for each]] sections.',
  // A function, so the list areas follow the loaded field source (stock catalog or a site's XWord list).
  instructions: () => designerInstructions(catalog),
  model,
})

const writerSystem = writerInstructions()

/** Steps 3 and 5: writes, repairs and revises XMerge templates from a design and a field sheet. No tools. */
export const writerAgent = new Agent({
  id: 'writer',
  name: 'Template writer',
  description: 'Turns a report design and a field sheet into an XMerge template.',
  instructions: writerSystem,
  model,
})
