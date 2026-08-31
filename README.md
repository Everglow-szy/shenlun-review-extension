# 申论智能练习与多引擎批改助手

这是一个面向 Microsoft Edge / Chromium Manifest V3 的本地优先浏览器扩展。它从当前申论网页提取试卷，在 Edge Side Panel 中提供独立答题、字数统计、计时、草稿恢复、历史练习，以及 ChatGPT 网页或 DeepSeek API 批改。

ChatGPT 使用已登录的网页版，不需要 API Key；DeepSeek 使用官方 API，需要在设置中填写 Key，并按官方规则产生费用。API Key、试卷、答案、计时、对话绑定和批改结果均保存在浏览器扩展自己的 IndexedDB 中，其中 API Key 是本机明文存储，不会写入源码或日志。输入停止前的短暂 debounce 窗口与每次计时状态切换都会先使用扩展源 `localStorage` 做同步写前镜像，IndexedDB 保存成功后再精确清除对应镜像。

## 安装

要求：

- Node.js 20 或更高版本
- Microsoft Edge / Chromium 141 或更高版本
- 使用 ChatGPT 网页批改时，需先登录 ChatGPT
- 使用 DeepSeek API 时，需准备可用的官方 API Key 和账户余额

在项目目录执行：

```powershell
npm install
npm run build
```

构建产物位于 `dist/`。然后：

1. 打开 `edge://extensions`。
2. 开启“开发人员模式”。
3. 点击“加载解压缩的扩展”。
4. 选择本项目的 `dist/` 目录。
5. 将扩展固定到工具栏。

每次修改源码后重新运行 `npm run build`，再在扩展管理页点击“重新加载”。

## 基本使用

1. 在普通 HTTP/HTTPS 标签页打开一套申论试卷。
2. 点击扩展图标。Side Panel 会打开并扫描当前页面。
3. 在原试卷网页查看题目和材料，在 Side Panel 中选择小题并开始作答。
4. 答案停止输入 700ms 后自动保存；debounce 窗口内另有同步本地草稿镜像。计时每 10 秒保存 checkpoint，暂停、切题和面板关闭时还会先写入同步恢复镜像。
5. 在答案下方选择“批改引擎”和该引擎的“具体模型”。
6. 点击“提交本题”将当前题发送到所选引擎；同一题可以重复提交批改。
7. 点击“全部提交批改”可交接当前 Attempt 下的整卷 Prompt。
8. 扩展等待引擎完成回复，并自动把内容保存到“AI 批改结果”；可按批改次数切换历史结果。

顶部“已置顶”按钮默认表示扩展固定在浏览器侧栏。点击后会切换为独立悬浮窗，可拖动系统窗口边缘自由调整大小；再次点击“置顶”会恢复到原浏览器窗口的侧栏。扩展会记住悬浮窗上次使用的宽高。这里的“置顶”指固定到 Edge 侧栏，不是让窗口始终覆盖在其他 Windows 程序之上。

网页引擎会在非活动标签页中自动填充、发送并读取回复，不会主动切走当前试卷页；DeepSeek 则由扩展后台直接请求官方接口。需要核对网页原始对话或 API 用量时，可在批改结果区点击“打开页面查看”。若网页输入框里已有其他未发送内容，扩展会拒绝覆盖它。

如果发送后消息通道意外中断，Side Panel 会进入“发送结果未确认”状态，不会自动重试或继续计时。请先检查对应批改页面或结果记录，再明确选择“我确认已发送”或“确认未发送”，以免产生重复消息或 API 请求。

再次扫描同一套试卷时，可以选择继续最近一次练习，也可以创建新的 Attempt。每个 Attempt 都有自己的答案、计时、反馈和 ConversationBinding。

## 批改引擎配置

设置页提供以下配置：

- ChatGPT 网页：Project 名称和 Project URL；具体模型沿用该 Project 当前的默认模型。
- DeepSeek API：官方 Base URL 和 API Key；提交界面可选择 V4 Flash / V4 Pro 及思考 / 非思考模式。

切换引擎时，第二个下拉框会自动切换到该引擎的默认模型并立即保存。DeepSeek Base URL 仅允许 `https://api.deepseek.com` 或兼容路径 `https://api.deepseek.com/v1`。

## ChatGPT Project 配置

在 Side Panel 的“设置”页配置：

- Project 名称，默认 `申论训练`
- Project URL，建议直接从浏览器地址栏复制
- 提交与结果读取固定在后台自动完成

Project URL 比名称查找更稳定。也可以在答题页展开“批改 Project”，直接粘贴 `https://chatgpt.com/g/g-p-.../project` 并保存；这里与设置页使用同一份配置。扩展不会创建 Project；如果 Project 不存在，请先在 ChatGPT 网页中创建并复制其 URL。

对话命名规则为：

```text
{试卷名称}-申论批改
```

发送第一条消息后，扩展会识别 `/c/...` URL、保存绑定并尝试重命名。ChatGPT DOM 改版导致自动重命名失败时，绑定仍保持在当前 Attempt 下，界面会要求手动修改标题。

## 数据隔离

核心关系是：

```text
PaperDefinition
└── PaperAttempt (attemptId)
    ├── QuestionAttempt (attemptId + questionId)
    ├── FeedbackRecord (attemptId)
    └── ConversationBinding (attemptId → conversationUrl)
```

- 日期从不作为对话归属判断依据。
- 所有 Prompt 构建前都会验证 QuestionAttempt 属于目标 `attemptId`。
- debounce 写前草稿镜像也使用 `attemptId + questionId` 键，重复试卷之间不会串稿。
- 计时写前镜像使用 `attemptId` 键；旧的异步保存完成时不会清掉更新的暂停或切题状态。
- Prompt 待发送状态会锁定对应答案；另一 Attempt 也不能在该状态解除前覆盖这次交接。
- 每次点击提交都会先写入带唯一 `requestId` 的不可变 Outbox 快照；只有该快照能被发送、确认或取消，避免页面或 Service Worker 重载造成重复发送。
- 单题提交会冻结该题计时，整卷提交会冻结总计时和全部单题计时；发送结果不确定时仍保持锁定，需由用户核对后明确处理。
- 一个 Conversation URL 不能自动绑定给多个 Attempt。
- Conversation URL 的历史归属会永久保留；即使 Attempt 后来重新绑定，旧 URL 也不能交给另一 Attempt。
- 已绑定的 Conversation URL 不会被后台静默替换；只能通过界面中的“重新绑定对话”显式修改。
- ChatGPT 标签页的临时占用关系保存在 `chrome.storage.session`，持久绑定保存在 IndexedDB。

## 数据库结构

数据库名称为 `shenlun-practice-assistant`，当前版本带顺序 migration。主要 stores：

| Store | 主键 | 关键索引 | 内容 |
| --- | --- | --- | --- |
| `papers` | `paperId` | `fingerprint`、`paperName`、`sourceUrl` | 去重后的试卷定义和题目快照 |
| `attempts` | `attemptId` | `paperId`、`updatedAt`、`status` | 某次独立练习及总计时 |
| `questions` | QuestionAttempt `id` | `attemptId`、`attemptId + questionId` | 作答、单题计时与题目状态 |
| `conversationBindings` | `attemptId` | `paperId`、`conversationUrl` | Project 和独立对话绑定 |
| `conversationClaims` | `conversationUrl` | `attemptId` | Conversation URL 的永久 Attempt 所有权 |
| `submissionOutbox` | `requestId` | `attemptId`、`status` | 不可变 Prompt、答案/计时快照及提交状态机 |
| `feedback` | `feedbackId` | `attemptId`、`questionId`、`createdAt` | 本题或整卷批改文本 |
| `settings` | `key` | — | 批改引擎、网页地址、DeepSeek Key 与答题显示设置 |

持久化实体都包含 `schemaVersion`。数据库升级逻辑集中在 `src/database/indexedDB.ts`。

## 项目结构

```text
public/manifest.json                 Manifest V3 与最小权限
src/background/                     Service Worker、活动页提取与多引擎编排
src/content/                        考试页与 ChatGPT 页 Content Script
src/adapters/                       考试/网页引擎 Adapter、集中 selector 与 DOM 等待
src/database/                       IndexedDB migration 与 repositories
src/services/                       Practice facade、计时、字数、Prompt、FeedbackProvider
src/sidepanel/                      React Side Panel、答题/历史/设置 UI
src/types/                          跨层消息和持久化对象的严格类型
src/utils/                          指纹、ID、日期和 Conversation 命名
tests/                              数据隔离、migration、Adapter、Prompt、计时与 UI 工具测试
scripts/build-extension.mjs         固定名称打包 Service Worker 与 Content Scripts
```

## 开发与测试

```powershell
npm run typecheck
npm test
npm run build
```

`npm run build` 会先做严格 TypeScript 检查，再构建 React Side Panel，最后把 Service Worker 和两个 Content Script 分别打成 MV3 可直接加载的独立文件。

开发 Side Panel 时可运行 `npm run dev`。浏览器扩展 API 只在已加载的扩展页面中存在，因此普通 Vite 页面适合调样式，不适合验证完整消息链路。

## 增加新的申论网站 Adapter

当前已内置粉笔申论页面专用 `FenbiShenlunAdapter`，并在注册表最后保留保守的通用 `ExamSiteAdapter`。适配其他网站时，建议继续新增站点专用 Adapter，而不是把 selector 写进 UI 或 Service Worker。

1. 在 `src/adapters/` 新建站点文件，例如 `ExampleExamAdapter.ts`。
2. 继承 `ExamSiteAdapter` 或 `BaseExamAdapter`。
3. 用 hostname/path 实现严格的 `canHandle(url)`。
4. 将该网站的 selector 集中成一个 `ExamSelectorSet`。
5. 在 `src/adapters/exam-registry.ts` 中把工厂注册在通用 fallback 前。
6. 用 jsdom fixture 测试多题遍历、字段为空和原题恢复。

继承通用遍历逻辑的示意：

```ts
const ExampleSelectors: ExamSelectorSet = {
  paperName: [".exam-header h1"],
  questionItems: [".question-nav button"],
  activeQuestionItems: [".question-nav button.active"],
  questionPanel: [".question-panel"],
  materials: [".material-item"],
  questionText: [".question-stem"],
  score: [".question-score"],
  wordLimit: [".question-requirement"],
  referenceAnswer: [".reference-answer"]
};

export class ExampleExamAdapter extends ExamSiteAdapter {
  constructor(page: Document) {
    super(page, ExampleSelectors);
  }

  override canHandle(url: string): boolean {
    return new URL(url).hostname === "exam.example.com";
  }
}
```

遍历管线会记录原题、逐题点击、通过 MutationObserver 等待 DOM 稳定、提取数据，并在成功或异常后恢复原题。

## 调试 selector

### 申论网站

1. 在试卷页按 F12。
2. 检查题目导航切换前后的 DOM，优先找稳定的 `data-*`、`aria-*` 或站点语义类名。
3. 在 Console 中用 `document.querySelectorAll("...")` 验证数量和顺序。
4. 确认 active selector 只命中当前题。
5. 确认 question panel 在切题后是否被整体替换。
6. 将 selector 放入站点 Adapter，不要修改 React 业务逻辑。

### ChatGPT

ChatGPT selector 全部集中在 `src/adapters/chatgpt-selectors.ts`。如果联动报“输入框/发送按钮/重命名控件未找到”：

1. 确认已登录且 Project URL 正确。
2. 在 ChatGPT DevTools 中检查稳定的 `data-testid` 和 `aria-label`。
3. 只更新集中 selector fallback。
4. 运行 `tests/bridge/chatgpt-adapter.test.ts` 并重新构建。

不要在日志或测试 fixture 中放入真实用户答案。

## 权限与隐私

Manifest 使用：

- `activeTab`：仅在用户点击扩展后读取当前试卷页
- `scripting`：按需注入考试 Content Script
- `sidePanel`：显示独立答题环境
- `storage`：保存活动 Attempt 和临时标签页绑定
- ChatGPT 两个域名的 host permission：执行网页交接
- DeepSeek API 域名的 host permission：由后台直接提交所选答案并读取批改结果

扩展未申请 `<all_urls>`、Cookie、密码或剪贴板读取权限。只有用户选择的批改引擎会收到本次 Prompt；扩展不会在日志中输出 API Key 或完整答案。

## 已知限制

- 已适配 `spa.fenbi.com/ti/view/paper/...?...routecs=shenlun` 的小题标签遍历、材料、题干和参考答案结构；扫描会自动读取同组全部小题并恢复网页原先选中的题目。其他申论网站仍使用通用启发式 Adapter，结构差异较大时需要按上面的方式增加专用 Adapter。
- ChatGPT 网页自动化依赖其页面 DOM。输入框、Project 导航或重命名菜单改版后，需要维护集中 selector。
- DeepSeek 模型名称和可用性可能随官方 API 更新；当前配置以 V4 Flash / V4 Pro 为准。
- 扩展无法绕过 ChatGPT 登录；未登录时会提示用户先登录。网页 DOM 改版时可使用“手动补录批改结果”兜底。
- 草稿镜像、IndexedDB 与计时 checkpoint 都是浏览器本地存储；浏览器配置目录本身损坏或被清理时无法恢复。

## 常见问题

### 提示“无法识别当前试卷结构”

确认当前标签页是完整试卷而非 PDF、浏览器内部页或登录中间页。刷新后重试；仍失败时需要添加该网站的专用 Adapter。

### Project 找不到

先在 ChatGPT 中创建/打开 Project，再把完整 Project URL 保存到答题页的“批改 Project”或扩展设置。首次提交会在该 Project 中建立对话；URL 优先于文字名称查找。

### 提示输入框已有内容

这是防止覆盖未发送 Prompt 的保护。请切到 ChatGPT 标签页发送或清空现有内容，再回到 Side Panel 重试。

### Conversation 打开失败

在历史练习中恢复对应 Attempt，使用“重新绑定对话”粘贴正确的 ChatGPT `/c/...` URL。系统会拒绝把同一个 URL 绑定给另一 Attempt。

如果界面显示“发送结果未确认”且首次发送后的 Conversation URL 未保存，可以先粘贴实际发送所在的 `/c/...` URL 重新绑定，再选择“我确认已发送”。只有该不确定恢复状态允许在提交锁存在时重新绑定。
