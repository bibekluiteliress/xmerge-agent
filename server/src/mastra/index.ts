import { Mastra } from '@mastra/core/mastra'
import { designerAgent, writerAgent } from './agents.js'
import { studioRoutes } from './routes.js'
import { reportWorkflow, reviseWorkflow } from './workflows/report.js'

export const mastra = new Mastra({
  agents: { designerAgent, writerAgent },
  workflows: { reportWorkflow, reviseWorkflow },
  server: {
    host: '127.0.0.1', // local only; the React app reaches it through the Vite proxy
    port: Number(process.env.XMS_SERVER_PORT ?? 4111),
    apiRoutes: studioRoutes,
    // Mastra cuts requests off at 3 minutes by default; a site's XWord list can take longer (xplan.ts allows 30).
    timeout: 35 * 60_000,
    // A big site's downloaded XWord file is larger than Mastra's 4.5 MB default request body.
    bodySizeLimit: 64 * 1024 * 1024,
  },
})
