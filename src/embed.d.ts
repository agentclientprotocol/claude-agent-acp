// Type declaration for the embed module that only exists in the
// single-file bun build (CLAUDE_AGENT_ACP_IS_SINGLE_FILE_BUN).
declare module "@anthropic-ai/claude-agent-sdk/embed" {
  const cliPath: string;
  export default cliPath;
}

// The SDK ships sdk-tools.d.ts but doesn't export ./sdk-tools in
// package.json. This shim lets tsc resolve the .js import path used
// in src/tools.ts. The actual types come from the SDK's sdk-tools.d.ts
// which TypeScript finds via paths resolution.
/// <reference path="../node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts" />
declare module "@anthropic-ai/claude-agent-sdk/sdk-tools.js" {
  export {
    AgentInput,
    BashInput,
    FileEditInput,
    FileReadInput,
    FileWriteInput,
    GlobInput,
    GrepInput,
    TodoWriteInput,
    WebFetchInput,
    WebSearchInput,
  } from "@anthropic-ai/claude-agent-sdk/sdk-tools";
}
