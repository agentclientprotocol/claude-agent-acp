# 续聊专家工具事件修复

- 开始：2026-10-24（Asia/Shanghai）。
- 目标与完成基线：`docs/plans/2026-10/2026-10-24-resumed-subagent-receipt.md`。
- 工作区：当前仓库，主 Agent 直接开发。
- 分支：`codex/fix-resumed-subagent-receipt`。
- 基线：`9b3a5c891c75e78b985adb31f4e4b59a16ad2ebc`。
- 既有并行/未知内容：`docs/plans/` 内旧计划和 `tmp/`，不覆盖、删除或暂存。
- 本官方仓库原无 `tasks/` 治理文件；本次只增加来源任务，不建立完整治理体系。

## 执行清单

- [x] 对齐依赖，检查真实非 AIR ACP 入口和已保存的真实回执证据。
- [x] 建立并运行最小失败回归，确认根因。
- [x] 完成最小共享修复并通过定向回归。
- [x] 使用真实 ACP stdio 验证同一专家续聊工具成功、失败及审批。
- [x] 完成构建、静态检查、测试和独立只读复核（全量门禁未通过，见边界）。
- [x] 更新最终证据、归档任务并完成本任务文件的提交准备；实际提交由 Git 记录。

## 进展与证据

- 已读取仓库约束及开发、TDD、计划、Git、复核和完成前验证 Skill；已有授权直接实施，无需再次确认。
- 发现 `node_modules` 与当前锁文件不符，先对齐再建立基线。
- `npm ci --ignore-scripts` 完成；实际依赖为 Agent SDK 0.3.303 / ACP SDK 2.0.0 / Vitest 5.0.5；`npm run build` 基线通过。
- 真实 stdio 已运行至 initialize、session/new、session/prompt；模型请求失败于本机配置的 `127.0.0.1:23333`（TCP ECONNREFUSED）。不是缺陷 RED，也不计作真实验收通过。已请求用户恢复连接，继续不依赖连接的回归修复。
- 只读核对既有真实验收 `ai-capability-center/tmp/module-capabilities/acceptance-20261023/sdk-resume-shapes.jsonl`：成功格式有 `inlineHandback` 对象、`pin.id` 和 `Resumed agent.` 消息特征，旧格式仍有 `resumedAgentId`。未修改来源工作树。
- RED：`npx vitest run src/tests/native-subagents.test.ts src/tests/acp-agent.test.ts -t 'resumedNativeSubagentId|inline-handback resume'`，退出 1；4 项预期失败（2 个字段识别、非 AIR 成功/失败工具生命周期均 0 事件），20 项通过。日志 `tmp/resumed-subagent-fix-20261024/red.log`。
- GREEN：同一命令退出 0，24 项通过。只修改共享回执解析；旧字段优先，新格式要求 success===true、inlineHandback/pin 非数组对象、消息以 `Resumed agent.` 开头、非空字符串 id。
- 用户确认使用 `C:\Users\ranzhenyu\.claude`。重新读取时配置已更新，当前网关 TCP 可达；继续使用原配置凭据（不打印、不修改），真实模型运行仍隔离测试目录和个人 hooks/skills。
- 正在用修复前 `dist/` 执行新一轮真实 stdio 基线，随后重建修复版作对照。
- 真实 SDK 0.3.303 基线：旧回执场景通过；前台 inline 场景捕获 `success/message/inlineHandback/pin`（无旧字段），也通过，因为 SDK 同时发出 task_started。故不声称最新版简单首次/续聊路径原本必然失败。
- 0.3.296 原验收运行端只读复用作兼容对照，同样捕获真实新回执及 task_started；一次首轮额外执行了只读 Bash，原“恰好一次”测试假设过严，改为首轮至少一次且全部检查归属/成功，不把这次夹具失败算产品缺陷。
- 真实补丁验收捕获必须处理的相邻时序：plain 模式的已完成 inline handback 被重新注册为 live task，导致 prompt 超时（`live-fixed-inline.log`）。新建 plain/RFD/AIR 持续开放 SDK 流回归；`inline-lifecycle-red.log` 中 plain 与 AIR 两项预期失败，修复后 `inline-lifecycle-green.log` 29 项通过。
- 相应最小调用方修正：区分已完成 handback 与后台恢复；不重开已结束/不同当前委派；仅 handback 唤醒缓冲的专家在交付后完成；原权限审批实现不变。此为真实测试揭示的必要调用链，不扩展 AIR 专属路由。
- 新增未知专家身份回归，RFD/AIR 均不能仅凭 pin 新建专家；非 AIR 成功/失败回归同时断言回复结束后子会话 idle。
- 全量测试在 Windows 的原有 ACP v2 测试出现关闭/超时并未自然结束，已停止；`npm run check` 的格式阶段遍历既有其他 `.worktrees/`，未修改其内容。改用明确限定的本任务格式检查和受影响回归，并保留全量未通过边界。
- 已用原版 native-subagents 源码替换编译输入（只在 tmp/Vite pre-transform，不改工作区）复跑受影响测试：原版 11 失败，补丁 9 失败；9 项均为相同 Windows 路径分隔符断言，新增失败 0。日志及机器可读对照 `baseline-comparison.json`；调用方修正后继续做最终全源基线对照。
- 独立复核指出 running-only 恢复占位不能当作另一个委派，重复 inline 不能重开 AIR 代际。先复现 RED，再用 `resumedWithoutTaskStart` 区分没有 task_started 的恢复，使用有界（256）SendMessage ID 集合记住已完成 inline；结果缓存剪枝后仍幂等。原有身份和审批代码保持不变。
- 最终定向回归：`node node_modules/vitest/vitest.mjs run src/tests/acp-agent.test.ts src/tests/native-subagents.test.ts -t 'NativeSubagent|resumedNativeSubagentId|subagent permission attribution|a failed subagent that SendMessage resumes|a failed child that the SDK resumes' --maxWorkers=2`，退出 0，177 通过、0 失败；其余 639 项被名称过滤，不把过滤项当通过。
- 最终完整受影响文件：816 项中 797 通过、9 失败、10 既有 skip。对照原始两个实现模块，同一当前测试集原版 20 失败；最终补丁没有新增失败，保留 9 项 Windows 路径分隔符失败。证据 `affected-final.log`、`baseline-complete.log`、`baseline-comparison-final.json`。
- 广泛测试快照：排除已挂起的 `acp-v2.test.ts` 后共 61 文件，2966 通过、180 失败、46 skip；仍含权限路径、符号链接和 session-index 等非本次目标失败。未对全部 180 项做原版对照，不能宣称它们全部已证明为基线问题，更不能宣称全量通过。不扩大本次修复。
- `npm run build`（`build-complete.log`）和 `npm run lint`（`lint-complete.log`）退出 0；本次文件 Prettier 定向检查通过。全仓格式检查会扫描原有 `.worktrees/`，明确保留未通过状态，不格式化并行工作树。
- 独立 reviewer 初审、定向复核和最后仅针对两项 Medium 的核对完成；最后结论为“两项 Medium 已关闭，本次限定范围无阻断结论”。

## 最终真实 ACP 验收

- 运行环境：Adapter 0.94.0 / Agent SDK 0.3.303 / 原生 CLI 2.1.303；从用户指定 `C:\Users\ranzhenyu\.claude` 读取当前连接配置，不打印/修改凭据。测试工作目录与个人 hooks/skills 隔离。
- 路径：真实 ACP JSON-RPC stdio → 本次构建 Adapter → 官方 Agent SDK/CLI → 已配置真实模型 → 本地 Bash → ACP 客户端事件；不是模拟 SDK、合成消息或 HTTP 探针。
- 命令（PowerShell）：设置 `RUN_LIVE_CAPABILITY_AUDIT=true`、`RUN_LIVE_RESUMED_SUBAGENT=true`、`LIVE_SUBAGENT_FORMS=rfd,plain`、`LIVE_SUBAGENT_RECEIPT=inline`、`LIVE_SUBAGENT_OUTPUT=tmp/resumed-subagent-fix-20261024/acceptance-final`，运行 `node node_modules/vitest/vitest.mjs run src/tests/resumed-subagent-live.test.ts`。
- 结果：退出 0，2 项通过，0 失败/跳过，75.26 秒。日志 `acceptance-final.log`；结构化摘要及 wire SHA256：`acceptance-summary.json`。
- RFD：同一 child `a326d7003d1777288`；续聊工具状态分别 `pending → completed`、`pending → failed`，均落在该 child session；首次 1 次、续聊 2 次审批请求；两个 prompt 均 `end_turn`。
- 普通 ACP：同一 child `ad58b6c6d5d791aa8`；两个工具状态完整，按原协议落在 root session；首次 1 次、续聊 2 次审批请求；两个 prompt 均 `end_turn`，不再挂起。
- 两种形式均实际收到 `success/message/inlineHandback/pin`，没有 `resumedAgentId`，pin.id 与首次专家相同；未用新的 Agent 替代原专家。真实文件 `first.txt` 和 `resumed.txt` 内容核验通过，另一个真实 Bash 以 7 退出并呈现 failed。
- 最终构建 `dist/acp-agent.js` SHA256：`0d7632e94f9e0dd207ed19553792b50329e4882f094785e152edc49e40db40dd`。

## 未完成与验收边界

- 本次共享修复和真实非 AIR ACP 协议验收完成；客户端 UI、产品运行包接入、全部 AIR 专属路由和发布门禁不在本次已验收声明中。
- 已安装产品与其他工作树未改动；未推送、建 PR、合并或发布。
- 验收证据保存在当前仓库 tmp 下，故保留本任务日志和复现脚本，不清理既有未知内容。
- 实施与验收结束：2026-10-24 14:26:05（Asia/Shanghai）；任务记录创建于 13:15:53，约 70.2 分钟。最终提交 SHA 以本文件的 Git 提交记录为准。
