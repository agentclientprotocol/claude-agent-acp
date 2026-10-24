# 续聊专家工具事件修复与真实 ACP 验收

- 日期：2026-10-24（Asia/Shanghai）。
- 完成依据：用户要求修复非 AIR 链路中同一专家续聊的工具事件缺失，并使用真实 ACP 链路测试验收。
- 工作区：当前 `claude-agent-acp`；主 Agent 直接实施；分支 `codex/fix-resumed-subagent-receipt`。
- 基线：`9b3a5c891c75e78b985adb31f4e4b59a16ad2ebc`，Adapter 0.94.0，Agent SDK 0.3.303，ACP SDK 2.0.0。
- 约束：保留旧字段兼容、原专家身份关联、原权限和审批；不顺带修改 AIR 专属路由，不升级版本，不推送或发布。既有未跟踪文件保持原样。
- 依赖：本机已有模型认证及网络；真实运行使用隔离测试工作目录，不修改凭据或用户配置。

## Task 1：修复共享成功回执识别并验证真实链路

### 交付目标

同一专家首次执行与后续 SendMessage 续聊的工具调用，在非 AIR ACP 客户端上具有完整、正确归属的开始和成功/失败事件；权限请求仍使用原审批路径。inline handback 代表运行已经结束，不能重新创建后台 hold；仅 running patch、重复回执和晚到回执均需保持正确关联与幂等。

### 精确路径

- 实现：`src/native-subagents.ts`；仅在真实证据证明必要时修改调用方 `src/acp-agent.ts`。
- 回归：`src/tests/native-subagents.test.ts`、`src/tests/acp-agent.test.ts`。
- 可重复真实 ACP 验收：`src/tests/resumed-subagent-live.test.ts`（显式环境变量启用，默认不发模型请求；默认 inline 模式必须命中真实新回执，可用 `LIVE_SUBAGENT_RECEIPT=legacy` 单独验证旧字段）。
- 过程与证据：`tasks/2026-10/open/2026-10-24-resumed-subagent-receipt.md`，完成后移至同月 `done/`；原始脱敏日志存 `tmp/resumed-subagent-fix-20261024/`。

### 输入与输出

- 输入：真实 SDK 的 SendMessage 成功回执、Agent/SendMessage 调用缓存与专家身份。
- 输出：现有 ACP 工具事件及专家归属；不新增协议字段。
- 依赖：无其他功能 Task。

### Step 与验证

1. 对齐锁文件依赖，构建基线，通过 ACP stdio 连接真实 Adapter/SDK，捕获非 AIR 首次及续聊消息，核对成功回执和真实失败。
2. 按真实回执建立最小 RED 测试：旧格式继续有效；已确认的新成功格式能恢复原专家；失败、空值、错误类型及不匹配身份不会建立错误关联。运行定向测试并记录预期失败。
3. 最小修改共享解析，保持现有身份/权限机制；同一 RED 转 GREEN，运行专家路由及 Adapter 定向回归。
4. 再跑真实 ACP 场景：同一专家首次、续聊成功工具、续聊失败工具，验证 JSON-RPC `session/update` 生命周期、归属和可验证执行产物；保留审批请求与响应证据。若运行端无法产生新格式，只报告兼容路径自动回归和真实链路各自验证边界，不声称真实命中新格式。
5. 执行 `npm run build`、`npm run check`、`npm run test:run`；无关基线失败需定向对照，不顺带修复。
6. 由未参与实现的只读 reviewer 对照完成基线独立复核，处理本次阻断问题；更新任务、归档并显式提交本任务文件。

### 异常边界

- 未捕获真实回执前不把 `pin.id` 当作 SDK 已确认契约。
- 真实 ACP 被认证/模型/平台阻断时记录具体错误；不得用合成测试冒充验收。
- 同类失败两次后重新核对假设，不无限重试；不修改外部产品仓库、生产配置或账号设置。
- 如真实证据显示根因超出共享回执识别，先更新范围说明；权限语义改变不在授权范围。

### 完成标准

RED/GREEN 证据、真实非 AIR ACP 生命周期和审批证据齐全；所改范围检查通过；无阻断复核问题；未执行 UI 验收单独标记，不能把协议验收称为产品界面验收。

### 提交标题

`fix(subagents): restore tool events when continuing an expert`

## 完成证据与验收边界

- 真实 ACP stdio：Adapter 0.94.0 / SDK 0.3.303 / CLI 2.1.303，RFD 和普通 ACP 两种客户端共 2 项通过；实际命中仅 inlineHandback/pin.id 的回执，首轮和续聊成功/失败工具、审批、文件产物和 prompt 结算均核验。
- 定向回归 177 项通过，构建和 lint 通过；原版两个实现模块作编译输入对照，最终受影响文件无新增失败，保留 9 项 Windows 路径失败。
- 广泛测试与全仓格式检查没有全绿；不得将局部通过说成全量或可发布。产品界面及运行包未改动。
- 来源任务归档位置：`tasks/2026-10/done/2026-10-24-resumed-subagent-receipt.md`；脱敏原始证据：`tmp/resumed-subagent-fix-20261024/`。
