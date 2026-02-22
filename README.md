# SlimGPT

SlimGPT 是一个 Chrome / Edge Manifest V3 扩展，目标是让 ChatGPT 在超长对话里依然保持流畅。

核心思路：只做减法，只操作 DOM，不碰 ChatGPT 内部 React 状态。

## 解决的问题

长对话中 ChatGPT 会累积大量消息节点，导致：

- 滚动时卡顿
- 输入框打字变慢
- 快速跳转体验变差
- 页面首次进入和刷新变慢

SlimGPT 通过“对话虚拟化 + 视口优先恢复 + 后台折叠”降低主线程压力。

## 主要功能

### 1. 动态对话虚拟化（核心）

- 仅保留视口附近的 turn 为完整 DOM
- 远离视口的旧消息替换为等高 placeholder
- 上翻/下翻时自动恢复附近消息
- 保持滚动高度稳定，不出现跳动

### 2. 输入优先策略

- 检测输入焦点、键入、组合输入（IME）
- 打字期间显著降低折叠/重建预算
- 避免输入线程被后台 DOM 工作抢占

### 3. Minimap 快速导航

- 左侧迷你轨道展示对话位置
- 点击点位可快速跳转到对应 turn
- 当前视口对应点位高亮（绿色呼吸效果）
- hover 预览该段上下文摘要（上一个 GPT / 用户 / 下一个 GPT）

### 4. 行内公式渲染与复制

- 补渲染 ChatGPT 未处理的 `$...$` 行内公式
- 使用本地离线 KaTeX（`vendor/katex`），不依赖 CDN
- 点击公式即可复制对应 TeX
- 支持增量流式渲染，同时带稳定性节流

### 5. 输入框扩展按钮

- 在 composer 区域注入扩展按钮
- 一键把输入区高度放大到约 5 倍（受视口上限保护）
- 回车发送或再次点击可收起

### 6. 会话切换与刷新恢复

- 监听 URL 变化，自动重建模型
- 刷新后有引导重试机制，避免首次模型为空导致 UI 丢失

## 技术特性

- Manifest V3
- 纯 Content Script（`content.js` + `styles.css`）
- 基于 `MutationObserver` 监听消息变化
- 不写死易碎 class 作为唯一判断依据（优先语义与 data 属性）
- 无 OpenAI API 调用
- 不保存用户隐私数据
- 零配置安装即生效

## 项目结构

```text
SlimGPT/
├── manifest.json
├── content.js
├── styles.css
├── vendor/
│   └── katex/
│       ├── katex.min.js
│       ├── katex.min.css
│       └── fonts/
└── .github/
    └── workflows/
        └── package.yml
```

## 安装方式（Chrome / Edge）

1. 打开 `chrome://extensions` 或 `edge://extensions`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择 SlimGPT 项目根目录

## 开发与调试

- 修改 `content.js` / `styles.css` 后，在扩展管理页点击“重新加载”
- 在 ChatGPT 页面刷新后验证行为
- 建议观察以下指标：
  - 输入延迟
  - 快速滚动时恢复速度
  - 长对话内 DOM 数量变化
  - 控制台是否出现扩展自身报错

## CI 打包

仓库包含 GitHub Actions 工作流：每次 push 自动打包扩展 zip 并上传 artifact。

文件位置：`.github/workflows/package.yml`

## 非目标

- 不改写 prompt
- 不接 OpenAI API
- 不做账号体系/云同步
- 不做复杂设置面板

## 兼容性

- Chrome（Manifest V3）
- Edge（Manifest V3）
- 目标站点：
  - `https://chatgpt.com/*`
  - `https://chat.openai.com/*`
