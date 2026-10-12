# 本地标准准备、重建与显式迁移

标准准备不需要 FairyGUI 工程。共享包 0.9.0 / 在线协议 1.7.0，作者 0.1.0 摘要不变。旧 1.1–1.6 回执和 1.3–1.6 准备结果继续读取。

## 输入与恢复

作者正文中的每个 material、asset、font 版本对应资源绑定数组一项：

```json
[{"logicalId":"skin","version":1,"path":"files/skin.png"}]
```

实际数组必须覆盖正文全部资源，不能只提交示例这一项。`path` 相对 `package_directory`。平台的资产版本、SHA-256、长度、RGBA 格式及图像尺寸都须与真实文件相符。

`ui_design_prepare` 接收 `document_path`、`resources_path`、`package_directory`、`base_revision`，以及可选 `submission_id` / `checkpoint_id`。它复制固定输入并建立独立 UUID 作业；不上传、不授权、不发布。最初没有在线 submission 时可先省略，后来以 `source_job_id` 及新关联建立新准备作业，旧输入和尝试不变。原工作区输入删除后，保留的副本仍可重建。

实际文件可直接位于工作区，也可通过 `ui_design_material_begin/chunk/action` 传入。每文件最多 64 MiB，块最多 512 KiB；每工作区最多 32 个未完成传输、合计 256 MiB。状态保存在桥接主机，`action=status` 不传 ID 可列出传输。相同已留存块可重放，冲突块拒绝；完成前检查整文件摘要。同卷临时文件加排他链接保护现有目标，即使状态目录和工作区在不同盘也可使用。完成只表示字节传输，后续还要按标准验证。

`ui_design_local_status` 查询作业及失败/中断尝试。`ui_design_reconstruct` 每次使用新工作区目录，保留输入和每次报告，不能覆盖已有目录。准备资源总量 256 MiB；重建最多 512 个 Image/Text 叶子、单图 3200 万像素、合计图层 1.28 亿像素。超过支持能力会明确拒绝。

## 产物和状态含义

重建输出 `Authoring.json`、`Manifest.json`、固定 `inputs/`、透明 `layers/`、`Preview.png`、`Overview.png`、`Provenance.json`。完整预览使用标准布局的顺序、实例状态、裁切、透明度和范围值；隐藏层保留，但不参与完整预览。素材总览是联系表，有自己的宽高。

固定字体检查来自旧渲染器中的 SFNT 家族、字形和字体冲突检查，独立复制到 `fonts.ts`。Pango 使用实际固定字体并关闭后备字形；缺字不能静默替换。行高使用 [Pango 官方绝对 line_height 规则](https://docs.gtk.org/Pango/pango_markup.html)。文字墨迹原点、塑形、换行和分数像素采样与平台 Java2D 可能不同，报告记录为限制；文字描边暂拒绝。总览只核对解码与尺寸，定稿和完整预览仍由平台做原尺寸测量。所有视觉审阅默认未执行。

准备和重建的 `savedLocally`、`SUCCEEDED` 均不表示平台保存。只有提交后校验通过的 COMMITTED 回执才能确认正式修订。使用重建返回的 bundle 路径调用 `ui_design_submit`；拒绝时读取平台字段诊断并显式修复。

CLI 等价入口是 `c2c ui-design prepare`、`preparations`、`reconstruct`、`legacy-source` 和 `migrate`。运行各子命令的 `--help` 获取准确参数。

## 旧 Scene 和原生 ID

旧 MCP/CLI 作业写入口统一返回 `LEGACY_READ_ONLY`；原作业、素材、PSD/FGUI 文件、预览仍可读。`ui_design_migrate` 只创建新目录和新准备作业，核对旧 scene/file/report hash，读取实际 package/component XML 交叉确认旧 package/resource/object ID，并保留源文件、文本/许可证字节及来源记录。旧原生 PASS 不继承。

当前迁移交集为固定 Image、显式 contain/stretch Loader、固定普通文字、普通容器、场景层组件实例。控制器、交互控件、关系/gear、九宫格、导出变体、嵌套实例、业务绑定等返回具体阻断字段。标准本身支持更多控件；此限制属于旧格式迁移器，不能通过删字段或展平绕过。

迁移扩展 `magicgamestudio/legacy-scene` 保存原模板、完整稳定映射和结构摘要。平台目标适配把当前标准文字、几何和资源版本应用到已保留的原生结构，并继续使用已核实的包/资源/对象 ID。结构改变需要新映射，不能重新 hash 冒充旧对象。没有旧构建时明确报告尚无原生源身份验证；旧导出 ID 也不证明游戏端后来未发生另一次 remap。

运行测试仅使用临时账号、数据库、工作区和合成资料；不修改原游戏工程，不部署正在运行的插件或平台。
