// Type declaration for the embed module that only exists in the
// single-file bun build (CLAUDE_AGENT_ACP_IS_SINGLE_FILE_BUN).
declare module "@anthropic-ai/claude-agent-sdk/embed" {
  const cliPath: string;
  export default cliPath;
}
