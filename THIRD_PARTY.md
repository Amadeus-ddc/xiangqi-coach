# 第三方来源与许可

## 本项目

本仓库的插件代码、文档与原创训练内容按根目录 [MIT License](LICENSE) 提供。第三方文件和数据保留以下单独许可。星河纹理由本项目通过图像生成工具制作，生成说明在 [prompts.json](web/assets/star-river/prompts.json)。

## XiangqiNotebook — MIT

来源：[gooooloo/XiangqiNotebook](https://github.com/gooooloo/XiangqiNotebook)，基线提交 `043cc703ef43e15140687cb5ab069838f618f288`。

- `native/core/`：原样保留的规则、局面、着法与中文记谱文件；[许可](native/core/LICENSE)及[文件校验](native/core/provenance.json)。
- `test/fixtures/notebook/`：原样保留的 `PGNParser.swift`、`GameObject.swift`、`Utils.swift`，仅用于导出棋谱的回读测试；[许可](test/fixtures/notebook/LICENSE)及[文件校验](test/fixtures/notebook/provenance.json)。
- 新增输入校验与进程入口位于 `native/main.swift`，测试不依赖外部工程目录。

## Pikafish — GPL-3.0

来源：[official-pikafish/Pikafish](https://github.com/official-pikafish/Pikafish)，固定源码提交 `391d491a49b27ca276d50f993ae837a58b1a0354`，引擎标识 `Pikafish dev-20260213-391d491a`。

完整对应源码、作者名单、构建脚本及 GPL 文本保存在 [`vendor/pikafish/`](vendor/pikafish/)。本插件通过独立 UCI 进程调用引擎，没有修改引擎或 NNUE。macOS arm64 二进制与 NNUE 作为本仓库 Release 附件提供；它们的大小和 SHA-256 固定在 [`data/engine-manifest.json`](data/engine-manifest.json)。完整运行包同时包含对应源码和许可，不把这部分改授 MIT。

如需重新编译，可将固定版本的 NNUE 放到源码旁，使用原 Makefile；Apple Silicon 示例：

```sh
npm run setup:engine
cp dist/pikafish.nnue vendor/pikafish/src/pikafish.nnue
make -C vendor/pikafish/src -j4 build ARCH=apple-silicon COMP=clang
```

上游构建选项见 [Pikafish README](vendor/pikafish/README.md) 和 `make -C vendor/pikafish/src help`。自行编译的结果通过 `XIANGQI_ENGINE` / `XIANGQI_NNUE` 指定；`npm run package` 针对固定校验的发行文件。

## Chinese Chess Practical Dataset — CC BY 4.0

Yu-Han Tseng and Bo-Nian Chen (2026), Chinese Chess Practical Dataset (CCPD)。来源：[Yvonne761/Chinese-Chess-Practical-Dataset](https://github.com/Yvonne761/Chinese-Chess-Practical-Dataset)，固定提交 `368a47a947773dd8692c026e286dd19b6277b993`。

上游许可为 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)，Copyright (c) 2026 Yu-Han Tseng；许可文件原样保存在 [`data/CCPD-LICENSE.txt`](data/CCPD-LICENSE.txt)。

`server/ccpd-puzzles.json` 的75题经过 Big5 解码、完整合法回放、局面截取、去重及必胜答案树重建；中文标题、提示和本地难度由本项目新增。每题保留作者、原记录链接、固定提交、来源哈希、许可及改编说明，界面和 PGN 导出保留署名。[详细说明](CCPD_DATA.md)

## JavaScript 依赖

- `@modelcontextprotocol/sdk` 1.30.0 — MIT
- `@modelcontextprotocol/ext-apps` 1.7.5 — MIT
- `zod` 4.5.4 — MIT
- `esbuild` 0.28.2 — MIT，仅用于构建

传递依赖及完整性校验见 `package-lock.json`。完整运行包保留各依赖附带的许可。SQLite 来自 Node.js 内置模块。

## 天天象棋行为研究

`server/tiantian-analysis.mjs` 是根据客户端行为独立表达的数学规则。来源版本、文件哈希、观察到的边界和适配差异见 [TIANTIAN_RESEARCH.md](TIANTIAN_RESEARCH.md)。发布内容限于独立实现、数值测试及来源索引；不分发 APK、解密材料、腾讯业务脚本、题库或引擎权重。
