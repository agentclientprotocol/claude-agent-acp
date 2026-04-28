# Changelog

## [0.31.4](https://github.com/agentclientprotocol/claude-agent-acp/compare/v0.31.3...v0.31.4) (2026-04-28)


### Bug Fixes

* gate auto mode on model support ([#604](https://github.com/agentclientprotocol/claude-agent-acp/issues/604)) ([ec47d34](https://github.com/agentclientprotocol/claude-agent-acp/commit/ec47d3446fa22e5895621f57c0a4497dbe044505))

## [0.31.3](https://github.com/agentclientprotocol/claude-agent-acp/compare/v0.31.2...v0.31.3) (2026-04-28)


### Bug Fixes

* Rename effort config category to thought_level ([#609](https://github.com/agentclientprotocol/claude-agent-acp/issues/609)) ([76b4e96](https://github.com/agentclientprotocol/claude-agent-acp/commit/76b4e9650832e59a6b4915ad898fc66a065022fa))

## [0.31.2](https://github.com/agentclientprotocol/claude-agent-acp/compare/v0.31.1...v0.31.2) (2026-04-28)


### Bug Fixes

* tolerate invalid values in settings.json ([#601](https://github.com/agentclientprotocol/claude-agent-acp/issues/601)) ([67af018](https://github.com/agentclientprotocol/claude-agent-acp/commit/67af018d0216238d8f3cd5bad04a55200518239b))

## [0.31.1](https://github.com/agentclientprotocol/claude-agent-acp/compare/v0.31.0...v0.31.1) (2026-04-27)


### Bug Fixes

* detect glibc and use correct binary ([#599](https://github.com/agentclientprotocol/claude-agent-acp/issues/599)) ([f0801d5](https://github.com/agentclientprotocol/claude-agent-acp/commit/f0801d50b2390a3c48150b9b8507d30a70c18b84))

## [0.31.0](https://github.com/agentclientprotocol/claude-agent-acp/compare/v0.30.0...v0.31.0) (2026-04-24)


### Features

* allow configuring models through env vars ([#586](https://github.com/agentclientprotocol/claude-agent-acp/issues/586)) ([1e15f3d](https://github.com/agentclientprotocol/claude-agent-acp/commit/1e15f3d8b0a06076ee62764ab576ac29fe056a38))
* Support effort levels ([#464](https://github.com/agentclientprotocol/claude-agent-acp/issues/464)) ([9e1185b](https://github.com/agentclientprotocol/claude-agent-acp/commit/9e1185bfd55cbf83a653a0ff8c194f986cbd1574))
* Update to acp sdk v0.20 ([#589](https://github.com/agentclientprotocol/claude-agent-acp/issues/589)) ([92adcbd](https://github.com/agentclientprotocol/claude-agent-acp/commit/92adcbd1ace2f2103742ffcf5c589eb1ca41b9b8))
* Update to claude-agent-sdk 0.2.119 ([#587](https://github.com/agentclientprotocol/claude-agent-acp/issues/587)) ([ef1dbd1](https://github.com/agentclientprotocol/claude-agent-acp/commit/ef1dbd1cb457f0524d221ea07235abf49dc941a0))


### Bug Fixes

* Forward full systemPrompt preset options from _meta ([#591](https://github.com/agentclientprotocol/claude-agent-acp/issues/591)) ([b3ddfc3](https://github.com/agentclientprotocol/claude-agent-acp/commit/b3ddfc3b86703c23fe99d93611885c12b1e4812c))
* Session Replay and Permission rendering ([#593](https://github.com/agentclientprotocol/claude-agent-acp/issues/593)) ([5faefab](https://github.com/agentclientprotocol/claude-agent-acp/commit/5faefab8ab9b725f7a3374808bf5579e411884bc)), closes [#579](https://github.com/agentclientprotocol/claude-agent-acp/issues/579)

## [0.30.0](https://github.com/agentclientprotocol/claude-agent-acp/compare/v0.29.2...v0.30.0) (2026-04-20)


### Features

* Update to claude-agent-sdk 0.2.114 ([#572](https://github.com/agentclientprotocol/claude-agent-acp/issues/572)) ([e9dd452](https://github.com/agentclientprotocol/claude-agent-acp/commit/e9dd45207d396302f20de82561135bf9558c0e76))

## [0.29.2](https://github.com/agentclientprotocol/claude-agent-acp/compare/v0.29.1...v0.29.2) (2026-04-17)


### Bug Fixes

* Guard against null usage tokens ([#565](https://github.com/agentclientprotocol/claude-agent-acp/issues/565)) ([f7dc300](https://github.com/agentclientprotocol/claude-agent-acp/commit/f7dc300a165e70f6426f53920f12e24c04033cdc)), closes [#564](https://github.com/agentclientprotocol/claude-agent-acp/issues/564)

## [0.29.1](https://github.com/agentclientprotocol/claude-agent-acp/compare/v0.29.0...v0.29.1) (2026-04-17)


### Bug Fixes

* emit usage updates from Claude stream events ([#506](https://github.com/agentclientprotocol/claude-agent-acp/issues/506)) ([dd67450](https://github.com/agentclientprotocol/claude-agent-acp/commit/dd67450fd9bddc82db3e71273b535e07b2672804))
* Remove dot from auto mode description ([#561](https://github.com/agentclientprotocol/claude-agent-acp/issues/561)) ([2ecfa83](https://github.com/agentclientprotocol/claude-agent-acp/commit/2ecfa83b26db58deaded210463fa6ff21d0dff70))
* Update to claude-agent-sdk 0.2.112 to fix Auto bug with Opus 4.7 ([#562](https://github.com/agentclientprotocol/claude-agent-acp/issues/562)) ([079614a](https://github.com/agentclientprotocol/claude-agent-acp/commit/079614ab05afba17e2cce0d3d238df7b90e17389))

## [0.29.0](https://github.com/agentclientprotocol/claude-agent-acp/compare/v0.28.0...v0.29.0) (2026-04-16)


### Features

* Update to claude-agent-sdk 0.2.111 (Opus 4.7) ([#557](https://github.com/agentclientprotocol/claude-agent-acp/issues/557)) ([85cd70c](https://github.com/agentclientprotocol/claude-agent-acp/commit/85cd70c9f3be47c9c404958547c4046d866db1c9))

## [0.28.0](https://github.com/agentclientprotocol/claude-agent-acp/compare/v0.27.0...v0.28.0) (2026-04-15)


### Features

* Update to claude-agent-sdk 0.2.109 ([#549](https://github.com/agentclientprotocol/claude-agent-acp/issues/549)) ([07a0fbc](https://github.com/agentclientprotocol/claude-agent-acp/commit/07a0fbc2f6bc388541d064a436412bdd850772cb))

## [0.27.0](https://github.com/agentclientprotocol/claude-agent-acp/compare/v0.26.0...v0.27.0) (2026-04-13)


### Features

* allow clients to opt into receiving raw SDK messages ([#527](https://github.com/agentclientprotocol/claude-agent-acp/issues/527)) ([403a668](https://github.com/agentclientprotocol/claude-agent-acp/commit/403a668078c067868062ed26cd4d3e36665b66b6))
* Update to claude-agent-sdk 0.2.104 ([#537](https://github.com/agentclientprotocol/claude-agent-acp/issues/537)) ([6811943](https://github.com/agentclientprotocol/claude-agent-acp/commit/6811943f57ef08616be633a8197223d4072663cf))


### Bug Fixes

* Allow auto mode after plan mode and send description for auto mode ([#528](https://github.com/agentclientprotocol/claude-agent-acp/issues/528)) ([fb9aced](https://github.com/agentclientprotocol/claude-agent-acp/commit/fb9aced3151c40694f1f01fd95665c4f5d90eb67))
* Better remote check for auth methods ([#538](https://github.com/agentclientprotocol/claude-agent-acp/issues/538)) ([93f58c0](https://github.com/agentclientprotocol/claude-agent-acp/commit/93f58c0d2fcf7365c7ca5a6e52f56663e2065ddb))
* better shutdown logic ([#543](https://github.com/agentclientprotocol/claude-agent-acp/issues/543)) ([9fb631f](https://github.com/agentclientprotocol/claude-agent-acp/commit/9fb631f5d76a5c5f6f0a1b61bdef05fe368c754c))
* exit process when ACP connection closes ([#530](https://github.com/agentclientprotocol/claude-agent-acp/issues/530)) ([5c81e99](https://github.com/agentclientprotocol/claude-agent-acp/commit/5c81e99fe5ccdf774819b7ff3a2bc78a6519d730))
* guard tool info rendering when tool_use input is undefined ([#536](https://github.com/agentclientprotocol/claude-agent-acp/issues/536)) ([d627b8c](https://github.com/agentclientprotocol/claude-agent-acp/commit/d627b8c5e95be31ac03923ef67d91748ec8564c5))
* Remove backup auth check from new session ([#544](https://github.com/agentclientprotocol/claude-agent-acp/issues/544)) ([32b16c1](https://github.com/agentclientprotocol/claude-agent-acp/commit/32b16c1ad99394238b0e5cd6c2f761c12debe142))

## [0.26.0](https://github.com/agentclientprotocol/claude-agent-acp/compare/v0.25.3...v0.26.0) (2026-04-08)


### Features

* Update claude-agent-sdk to 0.2.96 ([#526](https://github.com/agentclientprotocol/claude-agent-acp/issues/526)) ([c073131](https://github.com/agentclientprotocol/claude-agent-acp/commit/c07313148808a55f27f385c10babbaf7511a7f12))


### Bug Fixes

* Remove bun builds from release ([#525](https://github.com/agentclientprotocol/claude-agent-acp/issues/525)) ([fcf5aaf](https://github.com/agentclientprotocol/claude-agent-acp/commit/fcf5aaf06dfe9f7d1b285b976eeb2d1e20ea8dec))
* Use TUI login for remote environments ([#523](https://github.com/agentclientprotocol/claude-agent-acp/issues/523)) ([cc73e37](https://github.com/agentclientprotocol/claude-agent-acp/commit/cc73e37b41678aa67813c4fbef66ba33ca538743))

## [0.25.3](https://github.com/agentclientprotocol/claude-agent-acp/compare/v0.25.2...v0.25.3) (2026-04-06)


### Bug Fixes

* Drop claude-agent-sdk back to 0.2.91 to fix broken import ([#513](https://github.com/agentclientprotocol/claude-agent-acp/issues/513)) ([26f3e8a](https://github.com/agentclientprotocol/claude-agent-acp/commit/26f3e8a5216295985fadb80fb3b977045c0c1b2c))
* Recreate resumed sessions when params change ([#515](https://github.com/agentclientprotocol/claude-agent-acp/issues/515)) ([aa82193](https://github.com/agentclientprotocol/claude-agent-acp/commit/aa82193330026bae132fed8391c47dde777dcf5a))

## [0.25.2](https://github.com/agentclientprotocol/claude-agent-acp/compare/v0.25.1...v0.25.2) (2026-04-06)


### Bug Fixes

* prioritize ANTHROPIC_MODEL env var over settings.model in model … ([#505](https://github.com/agentclientprotocol/claude-agent-acp/issues/505)) ([bea1a40](https://github.com/agentclientprotocol/claude-agent-acp/commit/bea1a40e9bfe1e06672b118a727f9339def3be23))

## [0.25.1](https://github.com/agentclientprotocol/claude-agent-acp/compare/v0.25.0...v0.25.1) (2026-04-06)


### Bug Fixes

* add `auto` to valid modes in applySessionMode to fix mode cycling ([#507](https://github.com/agentclientprotocol/claude-agent-acp/issues/507)) ([15e91fb](https://github.com/agentclientprotocol/claude-agent-acp/commit/15e91fb5c3449de2600b583cb7a8d36b5b510443))

## [0.25.0](https://github.com/agentclientprotocol/claude-agent-acp/compare/v0.24.2...v0.25.0) (2026-04-03)


### Features

* Add auto permission mode support ([#501](https://github.com/agentclientprotocol/claude-agent-acp/issues/501)) ([a161453](https://github.com/agentclientprotocol/claude-agent-acp/commit/a16145396fe2e6ead8734478961b2de65707e335))
* Add separate Claude and Console terminal logins ([#502](https://github.com/agentclientprotocol/claude-agent-acp/issues/502)) ([063cd35](https://github.com/agentclientprotocol/claude-agent-acp/commit/063cd353809df8f3dda9e57d8ea848c0a6d44257))
* Update to claude-agent-sdk 0.2.91 ([#500](https://github.com/agentclientprotocol/claude-agent-acp/issues/500)) ([65a2230](https://github.com/agentclientprotocol/claude-agent-acp/commit/65a223038576d72b74e1483fed10e982a1f842bd))


### Bug Fixes

* log warnings for malformed settings files instead of silent fallback ([#486](https://github.com/agentclientprotocol/claude-agent-acp/issues/486)) ([ae6c388](https://github.com/agentclientprotocol/claude-agent-acp/commit/ae6c38831415f9fc1de2d3dd1d4a247becbbd32f))
* prevent race conditions in SettingsManager setCwd and debounce ([#485](https://github.com/agentclientprotocol/claude-agent-acp/issues/485)) ([7506223](https://github.com/agentclientprotocol/claude-agent-acp/commit/7506223cffb1aba4b4560feda11f69a1395a8c9d))
* use current model's context window for usage_update size ([#412](https://github.com/agentclientprotocol/claude-agent-acp/issues/412)) ([d07799d](https://github.com/agentclientprotocol/claude-agent-acp/commit/d07799d7b3b4e438c8b158266c79723a0b592c07))

## [0.24.2](https://github.com/agentclientprotocol/claude-agent-acp/compare/v0.24.1...v0.24.2) (2026-03-27)


### Bug Fixes

* Add explicit type checks for MCP servers (http/sse) ([#487](https://github.com/agentclientprotocol/claude-agent-acp/issues/487)) ([e00a439](https://github.com/agentclientprotocol/claude-agent-acp/commit/e00a43901fa2b4fd7d582e1de57277be88233007))

## [0.24.1](https://github.com/agentclientprotocol/claude-agent-acp/compare/v0.24.0...v0.24.1) (2026-03-26)


### Bug Fixes

* Cleanup based on new idle state [#463](https://github.com/agentclientprotocol/claude-agent-acp/issues/463) ([#480](https://github.com/agentclientprotocol/claude-agent-acp/issues/480)) ([23b3073](https://github.com/agentclientprotocol/claude-agent-acp/commit/23b30730253752f0bc4e30b619a6236f16fafdb9))

## 0.24.0

Rename from `@zed-industries/claude-agent-acp` to `@agentclientprotocol/claude-agent-acp`.

We are moving this to the main ACP org to better allow multiple teams to contribute and maintain this adapter.

## 0.23.1

- Add back error_during_execution break point (#469)

## 0.23.0

- Use idle session state as end of turn (#463)
- Update claude-agent-sdk to 0.2.83 (#462)
- Fix handling of local-only slash commands (#432)
- fix: correct null check for gatewayAuthMeta in subscription validation (#455)
- fix: include both stdout and stderr in Bash tool output (#456)
- fix: prevent prompt loop hang when cancel races with first result (#458)
- fix: dispose SettingsManager on session close to prevent resource leaks (#454)
- fix: restore plan content in ExitPlanMode tool call (#451)

## 0.22.2

- Add experimental meta param for testing additional directories

## 0.22.1

- Fix: invalid auth required state in gateway mode

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
