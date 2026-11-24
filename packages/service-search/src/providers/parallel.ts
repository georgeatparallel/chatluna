import { createRequire } from 'node:module'
import { z } from 'zod'
import { Context } from 'koishi'
import { ChatLunaPlugin } from 'koishi-plugin-chatluna/services/chat'
import { Config } from '..'
import { SearchManager, SearchProvider } from '../provide'
import { SearchResult } from '../types'

const { name, version } = createRequire(
    typeof __filename === 'string' ? __filename : import.meta.url
)('koishi-plugin-chatluna-search-service/package.json') as {
    name: string
    version: string
}

const searchResult = z.object({
    results: z.array(
        z.object({
            url: z
                .string()
                .url()
                .regex(/^https?:\/\//i),
            title: z.string().nullish(),
            excerpts: z.array(z.string())
        })
    )
})

interface JsonRpcResponse {
    id?: number
    error?: { message: string }
    result?: {
        isError?: boolean
        content: { type: string; text?: string }[]
        structuredContent?: unknown
    }
}

class ParallelSearchProvider extends SearchProvider {
    name = 'parallel'

    async search(
        query: string,
        limit = this.config.topK
    ): Promise<SearchResult[]> {
        // Parallel's MCP endpoint answers a single stateless JSON-RPC call,
        // so no initialize handshake is needed.
        const response = await this._plugin.fetch(
            'https://mcp.parallel.ai/mcp',
            {
                method: 'POST',
                redirect: 'error',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    // Identify the plugin so Parallel can measure aggregate free MCP usage.
                    'User-Agent': `${name}/${version}`
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: {
                        name: 'web_search',
                        arguments: {
                            objective: query,
                            search_queries: [query]
                        }
                    }
                })
            }
        )

        const body = await response.text()

        if (!response.ok) {
            throw new Error(`HTTP error ${response.status}: ${body}`)
        }

        const message = response.headers
            .get('content-type')
            ?.includes('text/event-stream')
            ? body
                  .split('\n')
                  .filter((line) => line.startsWith('data:'))
                  .map((line) => JSON.parse(line.slice(5)) as JsonRpcResponse)
                  .find((it) => it.id === 1)
            : (JSON.parse(body) as JsonRpcResponse)

        if (message?.error) {
            throw new Error(
                `Parallel web_search failed: ${message.error.message}`
            )
        }

        if (!message?.result || message.result.isError) {
            throw new Error('Parallel web_search failed')
        }

        const text = message.result.content.find(
            (block) => block.type === 'text'
        )
        const data = searchResult.parse(
            message.result.structuredContent ?? JSON.parse(text?.text ?? 'null')
        )

        return data.results.slice(0, limit).map((item) => ({
            url: item.url,
            title: item.title || item.url,
            description: item.excerpts.join('\n\n')
        }))
    }
}

export function apply(
    ctx: Context,
    config: Config,
    plugin: ChatLunaPlugin,
    manager: SearchManager
) {
    if (config.searchEngine.includes('parallel')) {
        manager.addProvider(new ParallelSearchProvider(ctx, config, plugin))
    }
}
