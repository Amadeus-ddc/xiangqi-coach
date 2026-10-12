# 验证与边界

独立仓库发布版本：`0.1.0`。代码从已验证的聊天插件提取，现可在独立目录构建和测试。

2026-10-12，在独立目录完成 **142项测试，全部通过**，见[完整测试日志](validation/2026-10-12-standalone-tests.log)。规则程序明确以macOS 15.0为最低目标；测试没有借用原工程的规则或PGN源文件路径。

解压运行包的独立进程验收额外发现并修复了符号链接路径下入口判断失效的问题。新增两个实际进程启动回归，与下载校验合计[5项定向检查通过](validation/2026-10-12-standalone-entry-tests.log)；完整测试套件现有144项。最终远程结果以仓库Actions为准。

[解压运行包验收](validation/2026-10-12-standalone-runtime.json)通过：21个工具、93题、完整棋盘资源、真实皮卡鱼两手复盘、服务重启后棋谱与报告恢复；使用独立临时数据目录。

## 可复现检查

```sh
npm ci
npm run setup:engine
npm run verify
```

检查包括：Swift 规则与 PGN 回读、真实 Pikafish、MCP 工具及认证、历史棋局与请求去重、交互回归、93题完整答案树、计时挑战、持久化、新旧评分报告，以及固定引擎下载的校验与失败保留。

来源数值基准中，117个用例直接对照独立评分实现，另8个原解析器用例只保留作证据。评分依赖本地引擎，验证通过不代表与腾讯线上评分逐局相同。

## 保留的公开证据

- [原始训练题验证](validation/2026-10-12-puzzle-verification.json)
- [CCPD 导入与全部样本分母](validation/2026-10-12-ccpd-import.json)
- [天天象棋评分数值基准](validation/2026-10-12-tiantian-score-fixtures.json)
- [客户端规则取证索引](validation/2026-10-12-tiantian-analysis-evidence.json)
- [早期功能与协议索引](validation/2026-10-12-tiantian-evidence.json)

公开证据去除了开发者本机的绝对路径；没有发布正式棋局库、认证文件或逆向原始材料。原样源码和数据的哈希在对应 provenance 文件中保留。

## 界面与运行环境

本地 MCP Apps / AppBridge 棋盘已验证落子、复盘、负分呈现、提示和计时挑战；示例图片位于 `docs/`。宿主是否支持交互棋盘及模型讲解回填，需要在各自客户端实际验收，不能由工具列表替代。

当前运行包面向 macOS 15+ Apple Silicon；Node.js 22.13+，源码构建需要 Xcode Command Line Tools。标准 GitHub macOS arm64 runner 的标签依据 [GitHub 官方说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)，远程状态以仓库 Actions 实际结果为准。
