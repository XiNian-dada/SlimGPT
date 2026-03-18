# SlimGPT

SlimGPT 是一个 Chrome / Edge Manifest V3 扩展，只通过 Content Script 修改 ChatGPT 页面 DOM。

## 功能

- 长对话虚拟化
  - 仅保留视口附近的消息为完整 DOM
  - 远离视口的旧消息折叠为占位节点
  - 滚动时自动恢复附近内容，再把远处内容折叠掉
- Minimap
  - 右侧点位表示对话位置
  - 点击点位快速跳转
  - hover 显示该 turn 的快照预览
  - 支持搜索定位、JSON / Markdown / TXT / CSV 导出
- 行内公式
  - 补渲染 ChatGPT 未处理的 `$...$` 行内公式
  - 使用本地离线 KaTeX，不依赖 CDN
  - 点击公式可复制 TeX
- 输入框扩展
  - 一键把 composer 输入区放大
  - 再次点击或发送消息后恢复
- 性能统计
  - 可选显示 turns / full / collapsed / sync 耗时

## 原理

- 只用 DOM + `MutationObserver` + `requestAnimationFrame`
- 不依赖 ChatGPT 内部 React 状态
- 通过语义属性识别消息，例如 `data-message-author-role`
- 通过占位节点维持滚动高度，避免列表突变
- 对高频路径做节流和缓存，减少重建与查询开销
- KaTeX 和字体都放在 `vendor/katex`，离线加载

## 安装

1. 打开 `chrome://extensions` 或 `edge://extensions`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择这个仓库根目录
5. 打开 `https://chatgpt.com/c/...` 即可生效

## 目录

```text
SlimGPT/
├── manifest.json
├── content.js
├── styles.css
├── vendor/katex/
└── .github/workflows/package.yml
```
