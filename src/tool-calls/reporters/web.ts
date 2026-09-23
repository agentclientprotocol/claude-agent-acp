import type {
  WebFetchInput,
  WebSearchInput,
  WebSearchOutput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { formatWebSearchHit, resultText, structuredResult, textContent } from "../content.js";
import type { ToolReporter, ToolResultContext, ToolResultFacts, ToolUseFacts } from "../facts.js";

/** WebFetch: the prompt is input that the user reads. The answer is the result. */
export class WebFetchReporter implements ToolReporter {
  toolUse(input: unknown): ToolUseFacts {
    const fetch = input as WebFetchInput | undefined;
    return {
      title: fetch?.url ? `Fetch ${fetch.url}` : "Fetch",
      kind: "fetch",
      ...(fetch?.prompt ? { display: [textContent(fetch.prompt)] } : {}),
    };
  }
}

/** WebSearch: the hits are the result to show. */
export class WebSearchReporter implements ToolReporter {
  toolUse(input: unknown): ToolUseFacts {
    const search = input as WebSearchInput | undefined;
    return {
      title: search?.query ? `Search "${search.query}"` : "Web search",
      kind: "fetch",
    };
  }

  toolResult({ result, structured }: ToolResultContext): ToolResultFacts {
    // The raw tool_result text is a model-directed dump. The structured
    // WebSearchOutput carries the hits: render them like server-side
    // web_search_result blocks ("Title (url)").
    const structuredSearch = structuredResult<WebSearchOutput>(structured);
    if (structuredSearch && Array.isArray(structuredSearch.results)) {
      const lines = structuredSearch.results.flatMap((entry) =>
        typeof entry === "string"
          ? [entry]
          : Array.isArray(entry?.content)
            ? // tool_use_result arrives untyped across CLI versions: skip
              // off-spec hits instead of "undefined (undefined)" lines.
              entry.content.flatMap((hit) =>
                typeof hit?.title === "string" && typeof hit?.url === "string"
                  ? [formatWebSearchHit(hit)]
                  : [],
              )
            : [],
      );
      if (lines.length > 0) return { content: [textContent(lines.join("\n"))] };
    }
    return resultText(result);
  }
}
