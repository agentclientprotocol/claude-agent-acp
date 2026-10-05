import type { BashInput, BashOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import type { BetaBashCodeExecutionResultBlock } from "@anthropic-ai/sdk/resources/beta.mjs";
import { structuredResult, textContent, toAcpContentUpdate } from "../content.js";
import type { ToolReporter, ToolResultContext, ToolResultFacts, ToolUseFacts } from "../facts.js";

/** Bash and PowerShell: a command whose output goes to the terminal channel. */
export class BashReporter implements ToolReporter {
  toolUse(input: unknown): ToolUseFacts {
    const bash = input as BashInput | undefined;
    return {
      title: bash?.command ? bash.command : "Terminal",
      kind: "execute",
      command: true,
      ...(bash?.description ? { display: [textContent(bash.description)] } : {}),
    };
  }

  /** A client with a terminal reads a failed command from the terminal channel. */
  errorResult(context: ToolResultContext): ToolResultFacts | undefined {
    return context.capabilities.terminalOutput ? this.toolResult(context) : undefined;
  }

  toolResult({ result, structured }: ToolResultContext): ToolResultFacts {
    const content = result.content;
    const isError = result.is_error === true;
    // The output comes from one of these forms:
    // 1. The structured BashOutput (message-level tool_use_result): its
    //    stdout/stderr exclude the model-directed suffixes the raw text
    //    carries (stale-read hints, gh rate-limit hints, the persisted-output
    //    wrapper for too-large outputs). The interruption and truncation facts
    //    are re-established from the structured flags below. Skipped for image
    //    output (the raw content array carries the image blocks) and
    //    backgrounded commands (the raw text carries the background notice).
    // 2. BetaBashCodeExecutionResultBlock.
    // 3. Plain string content from a regular tool_result.
    // 4. Array content: text blocks for stdout, or image blocks when the
    //    command produces an image.
    let output = "";
    // Claude Code accepts a non-zero code as a success only with a
    // `returnCodeInterpretation` (grep's "No matches found"), so a success
    // without one exited with 0.
    let exitCode: number | undefined = isError ? undefined : 0;

    const structuredBash = structuredResult<BashOutput>(structured);
    if (
      structuredBash &&
      typeof structuredBash.stdout === "string" &&
      typeof structuredBash.stderr === "string" &&
      !structuredBash.isImage &&
      structuredBash.backgroundTaskId === undefined
    ) {
      output = [structuredBash.stdout, structuredBash.stderr].filter(Boolean).join("\n");
      // The CLI appends its abort marker only to the model-facing text. The
      // result does not carry the code of the aborted command.
      if (structuredBash.interrupted) {
        output = [output, "[Command was aborted before completion]"].filter(Boolean).join("\n");
        exitCode = undefined;
      }
      if (structuredBash.returnCodeInterpretation !== undefined) exitCode = undefined;
      // Structured stdout is clipped when the full output was persisted to
      // disk. Without this note the clip is silent.
      if (typeof structuredBash.persistedOutputPath === "string") {
        const size =
          typeof structuredBash.persistedOutputSize === "number"
            ? ` (${structuredBash.persistedOutputSize} bytes total)`
            : "";
        output = [
          output,
          `[Output truncated${size}: full output saved to ${structuredBash.persistedOutputPath}]`,
        ]
          .filter(Boolean)
          .join("\n");
      }
    } else if (
      content &&
      typeof content === "object" &&
      "type" in content &&
      content.type === "bash_code_execution_result"
    ) {
      const bashResult = content as BetaBashCodeExecutionResultBlock;
      output = [bashResult.stdout, bashResult.stderr].filter(Boolean).join("\n");
      exitCode = bashResult.return_code;
    } else if (typeof content === "string") {
      output = content;
    } else if (Array.isArray(content) && content.length > 0) {
      const textOnly = content.every(
        (c: any) => c && typeof c === "object" && typeof c.text === "string",
      );
      if (!textOnly) {
        // Binary payloads cannot travel in the terminal channel, so image
        // output is a result to show.
        return toAcpContentUpdate(content, isError);
      }
      output = content.map((c: any) => c.text).join("\n");
    }
    if (isError && exitCode === undefined) exitCode = failureExitCode(output);
    // A backgrounded command is still running: the result only announces it.
    if (structuredBash?.backgroundTaskId !== undefined) exitCode = undefined;
    return { command: { output, ...(exitCode !== undefined ? { exitCode } : {}) } };
  }
}

/**
 * The exit code that the text of a failed command names. Claude Code starts the
 * text of a command that exited with a failing code with `Exit code N`. Other
 * failures, such as a denial or a command that could not start, name none.
 */
function failureExitCode(text: string): number | undefined {
  const match = /^Exit code (\d+)(?:\n|$)/.exec(text);
  return match ? Number(match[1]) : undefined;
}
