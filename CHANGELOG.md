# Changelog

## 0.22.0

- Use stable list sessions method (#429)
- Use correct Claude CLI path for static binaries (#428)
- Update claude-agent-sdk to 0.2.76 (#427)
- fix: resolve model aliases in setSessionConfigOption (#401) (#403)
- Reuse existing sessions for load/resume if possible (#426)
- Remove interrupt flag from deny responses (#425)
- Allow Bypass permissions mode after Exiting plan (#410)
- Don't get out of sync when background task creates new init/result (try 2) (#400)
- Add session/close support (#409)

## 0.21.0

- Update to claude-agent-sdk 0.2.71
- show project-relative paths in tool call titles
- Lib: pass through tools array to control built-in tool availability
- fix: skip user replay
- fix: handle renamed Agent tool in toolInfoFromToolUse

## 0.20.2

- Update to @anthropic-ai/claude-agent-sdk@0.2.68

## 0.20.1

- fix: inherit process.env when spawning agent subprocess

## 0.20.0

- Update to @anthropic-ai/claude-agent-sdk@0.2.63
- Respect user settings for permission mode and model selection
- Better handling of concurrent prompts
- Support --cli for node as well
- Propagate max_tokens stop reason instead of throwing internal error
- fix: throw resourceNotFound when loadSession fails to resume
- fix: add missing zod dependency
- Surface better error message when Claude Code process exits unexpectedly

## 0.19.2

- Fix for broken notifications when reloading session messages

## 0.19.1

- Support windows arm builds and clean up artifact files

## 0.19.0

- Update to @anthropic-ai/claude-agent-sdk@0.2.62
- Use SDK functions for listing and loading session history
- Build single-file executables using bun.
- Fix for overwritten disallowed tools.

## 0.18.0

- Switch over to built-in Claude tools. We no longer replicate specific ACP tools and just rely on sending updates based on Claude's internal tools. This means it won't use client capabilities for files or terminals, but also means there will be less difference and hopefully issues arising from the differences in behavior.
- Support ACP session config options: https://agentclientprotocol.com/protocol/session-config-options
- Fix for image output from tool calls.

## 0.17.1

- Update to @anthropic-ai/claude-agent-sdk@0.2.45 to add access to Sonnet 4.6

## 0.17.0

Rename from `@zed-industries/claude-code-acp` to `@zed-industries/claude-agent-acp` to align with the current [branding guidelines](https://platform.claude.com/docs/en/agent-sdk/overview#branding-guidelines)

## 0.16.2

- Update to @anthropic-ai/claude-agent-sdk@0.2.44
- fix: Replace all non-alphanumeric characters for session loading in encodeProjectPath (#307)
- don't include /login slash command in login command (#315)

## 0.16.1

- Update to @anthropic-ai/claude-agent-sdk@0.2.38
- Fix incorrect paths for session/list
- Fix available commands after loading a session
- Make loading session more permissive for finding events
- Fix overriding user-provided disallowedTools

## 0.16.0

- Update to @anthropic-ai/claude-agent-sdk@0.2.34
- Experimental support for session loading

## 0.15.0

- Update to @anthropic-ai/claude-agent-sdk@0.2.32 (adds support for Opus 4.6 and 1M context Opus)

## 0.14.0

- Update to @anthropic-ai/claude-agent-sdk@0.2.29
- Update to using the recommended `CLAUDE_CONFIG_DIR` env variable for setting where config files are kept
- Support /context command
- Fix incorrect context type mapping for tool calls
- Fix glob metching for file permissions on Windows
- Support the `IS_SANDBOX` env var for supporting bypass permissions in root mode
- Fix missing notification for entering plan mode
- Experimental unstable support for listing sessions

## 0.13.2

- Update to @anthropic-ai/claude-agent-sdk@0.2.22
- Fix: return content from ACP write tool to help with issues with alternate providers.

## 0.13.1

- Update to @anthropic-ai/claude-agent-sdk@0.2.7
- Add TypeScript declaration files for library users
- Fixed error handling in custom ACP focused MCP tools

## 0.13.0

- Update to @anthropic-ai/claude-agent-sdk@0.2.6
- Update to @agentclientprotocol/sdk@0.13.0

## 0.12.6

- Fix model selection

## 0.12.5

- Update to @anthropic-ai/claude-agent-sdk@v0.1.70
- Unstable implementation of resuming sessions

## 0.12.4

- Update to @anthropic-ai/claude-agent-sdk@v0.1.67
- Better respect permissions specified in settings files
- Unstable implementation of forking

## 0.12.3

- Update to @anthropic-ai/claude-agent-sdk@v0.1.65
- Update to @agentclientprotocol/sdk@0.9.0
- Allow agent to write plans and todos to its config directory
- Fix experimental resume ids

## 0.12.2

- Fix duplicate tool use IDs error

## 0.12.1

- Update to @anthropic-ai/claude-agent-sdk@v0.1.61
- Update to @agentclientprotocol/sdk@0.8.0

## 0.12.0

- Update to @anthropic-ai/claude-agent-sdk@v0.1.59
  - Brings Opus to Claude Pro plans
  - Support "Don't Ask" profile
- Unify ACP + Claude Code session ids

## 0.11.0

- Update to @anthropic-ai/claude-agent-sdk@v0.1.57
- Removed dependency on @anthropic-ai/claude-code since this is no longer needed

## 0.10.10

- Update to @agentclientprotocol/sdk@0.7.0

## 0.10.9

- Update to @anthropic-ai/claude-agent-sdk@v0.1.55
- Allow defining a custom logger when used as a library
- Allow specifying custom options when used as a library
- Add `CLAUDECODE=1` to terminal invocations to match default Claude Code behavior

## 0.10.8

- Update to @anthropic-ai/claude-agent-sdk@v0.1.51 (adds support for Opus 4.5)

## 0.10.7

- Fix read/edit tool error handling so upstream errors surface
- Update to @anthropic-ai/claude-agent-sdk@v0.1.50

## 0.10.6

- Disable experimental terminal auth support for now, as it was causing issues on Windows. Will revisit with a fix later.
- Update to @anthropic-ai/claude-agent-sdk@v0.1.46

## 0.10.5

- Better error messages at end of turn if there were any
- Add experimental support for disabling built-in tools via \_meta flag
- Update to @anthropic-ai/claude-agent-sdk@v0.1.44

## 0.10.4

- Fix tool call titles not appearing during approval in some cases
- Update to @anthropic-ai/claude-agent-sdk@v0.1.42

## 0.10.3

- Fix for experimental terminal auth support

## 0.10.2

- Fix incorrect stop reason for tool call refusals

## 0.10.1

- Add additional structured metadata to tool calls
- Update to @anthropic-ai/claude-agent-sdk@v0.1.37

## 0.10.0

- Update to @anthropic-ai/claude-agent-sdk@v0.1.30
- Use `canUseTool` callback instead of launching an HTTP MCP server for permission checks.

## 0.9.0

- Support slash commands coming from MCP servers (Prompts)

## 0.8.0

- Revert changes to filename for cli entrypoint
- Provide library entrypoint via lib.ts

## 0.7.0

- Allow importing from this package as a library in addition to running it as a CLI. Allows for easier integration into existing node applications.
- Update to @anthropic-ai/claude-agent-sdk@v0.1.27

## 0.6.10

- Provide `agentInfo` on initialization response.
- Update to @agentclientprotocol/sdk@0.5.1
- Fix crash when receiving a hook_response event
- Fix for invalid locations when read call has no path

## 0.6.9

- Update to @anthropic-ai/claude-agent-sdk@v0.1.26
- Update to @agentclientprotocol/sdk@0.5.0

## 0.6.8

- Fix for duplicate tokens appearing in thread with streaming enabled
- Update to @anthropic-ai/claude-agent-sdk@v0.1.23
- Update to @agentclientprotocol/sdk@0.4.9

## 0.6.7

- Fix for invalid plan input from the model introduced in latest agent-sdk

## 0.6.6

- Do not enable bypassPermissions mode if in root/sudo mode, because Claude Code will not start

## 0.6.5

- Fix for duplicated text content after streaming

## 0.6.4

- Support streaming partial messages!
- Update to @anthropic-ai/claude-agent-sdk@v0.1.21

## 0.6.3

- Fix issue where slash commands were loaded before initialization was complete.

## 0.6.2

- Fix bug where mode selection would sometimes fire before initialization was complete.
- Update to @anthropic-ai/claude-agent-sdk@v0.1.19

## 0.6.1

- Fix to allow bypassPermissions mode to be selected (it wasn't permitted previously)

## 0.6.0

- Provide a model selector. We use the "default" model by default, and the user can change it via the client.
- Make sure writes require permissions when necessary: https://github.com/zed-industries/claude-code-acp/pull/92
- Add support for appending or overriding the system prompt: https://github.com/zed-industries/claude-code-acp/pull/91
- Update to @anthropic-ai/claude-agent-sdk@v0.1.15
- Update to @agentclientprotocol/sdk@0.4.8

## 0.5.5

- Migrate to @agentclientprotocol/sdk@0.4.5
- Update to @anthropic-ai/claude-agent-sdk@v0.1.13

## 0.5.4

- Update to @anthropic-ai/claude-agent-sdk@v0.1.11
- Enable setting CLAUDE_CODE_EXECUTABLE to override the executable used by the SDK https://github.com/zed-industries/claude-code-acp/pull/86

## 0.5.3

- Update to @anthropic-ai/claude-agent-sdk@v0.1.8
- Update to @zed-industries/agent-client-protocol@v0.4.5

## 0.5.2

- Add back @anthropic-ai/claude-code@2.0.1 as runtime dependency

## 0.5.1

- Update to @anthropic-ai/claude-agent-sdk@v0.1.1
- Make improvements to ACP tools provided to the model

## 0.5.0

- Migrate to @anthropic-ai/claude-agent-sdk@v0.1.0

## v0.4.7

- More efficient file reads from the client.

## v0.4.6

- Update to @anthropic-ai/claude-code@v1.0.128

## v0.4.5

- Update to @anthropic-ai/claude-code@v1.0.124
- Update to @zed-industries/agent-client-protocol@v0.4.3

## v0.4.4

- Update to @anthropic-ai/claude-code@v1.0.123
- Update to @zed-industries/agent-client-protocol@v0.4.2

## v0.4.3

- Move ACP tools over MCP from an "http" MCP server to an "sdk" one so more tool calls can stay in-memory.
- Update to @anthropic-ai/claude-code@v1.0.119
- Update to @zed-industries/agent-client-protocol@v0.4.0

## v0.4.2

- Fix missing package.json metadata

## v0.4.1

- Add support for /compact command [ecfd36a](https://github.com/zed-industries/claude-code-acp/commit/ecfd36afa6c4e31f12e1daf9b8a2bdc12dda1794)
- Add default limits to read tool [7bd1638](https://github.com/zed-industries/claude-code-acp/commit/7bd163818bb959b11fd2c933eff73ad83c57abb8)
- Better rendering of Tool errors [491efe3](https://github.com/zed-industries/claude-code-acp/commit/491efe32e8547075842e448d873fc01b2ffabf3a)
- Load managed-settings.json [f691024](https://github.com/zed-industries/claude-code-acp/commit/f691024350362858e00b97248ac68e356d2331c2)
- Update to @anthropic-ai/claude-code@v1.0.113
- Update to @zed-industries/agent-client-protocol@v0.3.1
