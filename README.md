# WaveForge 多轨音频工作站

基于 React、TypeScript、Vite、MUI、Zustand、Web Audio API、Wavesurfer 和 React
Router 构建的浏览器多轨音频编辑工作站。

## 功能

- 麦克风录音、导入音频和内置合成鼓组 / 和弦 / 贝斯片段
- 多轨片段拖动、跨轨移动、左右裁剪和吸附
- 轨道音量、声像、静音、独奏和片段复制
- 淡入淡出、低通 / 高通 / Echo 基础效果
- Web Audio API 统一时钟调度，多轨播放保持同步
- 循环区间、时间轴缩放、播放头和标尺定位
- Wavesurfer 按缩放级别重采样波形
- localStorage 自动保存轨道与效果参数，支持 JSON 工程导出 / 导入
- 离线协作：导出包含合并基准（v2 包），导入时按轨道 / 片段三路合并，支持一键撤销导入

## 运行

```bash
export PATH="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin:$PATH"
corepack pnpm install
corepack pnpm dev
corepack pnpm build
```

首次进入无需麦克风权限或外部音频文件，可以直接使用内置合成素材。

## 离线协作合并

点「导出工程」会下载 v2 包（`kind: waveforge-project`，内含 `project` 与共同基准 `base`）。
同事各自离线编辑后，点「导入并合并」选择对方的 JSON，按三路合并（base / 本机 / 对方）处理：

- 轨道、片段分别比较：只有一边相对基准改动的，采用改动方；
- 两边都改的片段两份都保留，橙色「冲突」标记，对方版本名称带「（对方版本）」，
  在片段操作区或片段检查器点「确认此版本」即可清除标记；
- 轨道参数两边都改时保留本机值，轨道头与片段上标出冲突；
- 一边删除的片段 / 轨道不会复活；一边删、另一边改的情形会在合并报告中提示；
  片段被一边移走、原轨道被另一边删除时，片段保留在新轨道并标出冲突；
- 对方片段引用的素材自动并入素材库；素材 id 撞车但内容不同时，
  对方素材自动换 id 且只重映射对方片段；极端缺失时生成可播放占位素材，不留空片段；
- 旧版 v1 纯工程文件仍可导入，以文件本身回填基准（合并报告中会注明）；
- 「撤销导入」一步回到导入前的工程（含基准与选择状态）。

合并算法见 `src/utils/projectMerge.ts`，回归测试：`corepack pnpm test`。
