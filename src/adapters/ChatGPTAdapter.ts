import {
  isElementUsable,
  normalizedText,
  queryAllFirstGroup,
  queryFirst,
  waitForCondition,
  waitForDomStable,
  waitForElement,
} from "./dom";
import { ChatGPTSelectors } from "./chatgpt-selectors";

export type ChatGPTAdapterErrorCode =
  | "CHATGPT_UNSUPPORTED_URL"
  | "CHATGPT_LOGIN_REQUIRED"
  | "CHATGPT_PROJECT_NOT_FOUND"
  | "CHATGPT_CONVERSATION_NOT_FOUND"
  | "CHATGPT_NEW_CONVERSATION_FAILED"
  | "CHATGPT_COMPOSER_NOT_FOUND"
  | "CHATGPT_COMPOSER_NOT_EMPTY"
  | "CHATGPT_PROMPT_FILL_FAILED"
  | "CHATGPT_SEND_BUTTON_NOT_FOUND"
  | "CHATGPT_SUBMIT_FAILED"
  | "CHATGPT_DELIVERY_UNCERTAIN"
  | "CHATGPT_HANDOFF_ALREADY_PENDING"
  | "CONVERSATION_ISOLATION_VIOLATION"
  | "CHATGPT_RENAME_REQUIRED";

export class ChatGPTAdapterError extends Error {
  public constructor(
    public readonly code: ChatGPTAdapterErrorCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ChatGPTAdapterError";
  }
}

function normalizedComparableText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

function editorText(element: HTMLElement): string {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    return element.value;
  }
  return element.innerText || element.textContent || "";
}

function normalizedEditorText(value: string): string {
  return value.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
}

function readableElementText(element: HTMLElement): string {
  const rendered = element.innerText || element.textContent || "";
  return rendered
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function setNativeValue(element: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
}

function dispatchEditorEvents(element: HTMLElement, prompt: string): void {
  try {
    element.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: prompt,
      }),
    );
  } catch {
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  }
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function activateElement(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
  element.click();
}

function assignContentEditable(element: HTMLElement, prompt: string): void {
  element.focus();
  const selection = element.ownerDocument.getSelection();
  if (selection) {
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  let inserted = false;
  try {
    inserted = element.ownerDocument.execCommand("insertText", false, prompt);
  } catch {
    inserted = false;
  }

  if (!inserted || editorText(element).trim() !== prompt.trim()) {
    const paragraph = element.ownerDocument.createElement("p");
    paragraph.textContent = prompt;
    element.replaceChildren(paragraph);
  }
  dispatchEditorEvents(element, prompt);
}

function findNamedLink(
  page: Document,
  selectors: readonly string[],
  name: string,
  preferredUrl?: string,
): HTMLAnchorElement | null {
  const expectedName = normalizedComparableText(name);
  for (const selector of selectors) {
    let candidates: HTMLAnchorElement[];
    try {
      candidates = Array.from(page.querySelectorAll<HTMLAnchorElement>(selector));
    } catch {
      continue;
    }
    const urlMatch = preferredUrl
      ? candidates.find((candidate) => {
          try {
            return new URL(candidate.href, page.baseURI).href === new URL(preferredUrl).href;
          } catch {
            return false;
          }
        })
      : undefined;
    if (urlMatch) return urlMatch;

    const nameMatch = candidates.find((candidate) => {
      const labels = [
        normalizedText(candidate),
        candidate.getAttribute("aria-label") ?? "",
        candidate.getAttribute("title") ?? "",
      ];
      return labels.some((label) => normalizedComparableText(label) === expectedName);
    });
    if (nameMatch) return nameMatch;
  }
  return null;
}

function findControlByText<T extends HTMLElement>(
  page: ParentNode,
  selectors: readonly string[],
  acceptedLabels: readonly string[],
): T | null {
  const labels = acceptedLabels.map(normalizedComparableText);
  for (const selector of selectors) {
    let candidates: T[];
    try {
      candidates = Array.from(page.querySelectorAll<T>(selector));
    } catch {
      continue;
    }
    const match = candidates.find((candidate) => {
      const candidateLabels = [
        normalizedText(candidate),
        candidate.getAttribute("aria-label") ?? "",
        candidate.getAttribute("title") ?? "",
      ].map(normalizedComparableText);
      return candidateLabels.some((candidateLabel) => labels.includes(candidateLabel));
    });
    if (match) return match;
  }
  return null;
}

export class ChatGPTAdapter {
  public constructor(private readonly page: Document = document) {}

  public static isChatGPTUrl(value: string): boolean {
    try {
      const url = new URL(value);
      const hostname = url.hostname.toLowerCase();
      return (
        url.protocol === "https:" &&
        (hostname === "chatgpt.com" || hostname === "chat.openai.com")
      );
    } catch {
      return false;
    }
  }

  public static conversationUrl(value: string): string | null {
    if (!ChatGPTAdapter.isChatGPTUrl(value)) return null;
    const url = new URL(value);
    if (!/(?:^|\/)c\/[\w-]+(?:\/|$)/u.test(url.pathname)) return null;
    const canonicalOrigin = url.hostname === "chat.openai.com" ? "https://chatgpt.com" : url.origin;
    return `${canonicalOrigin}${url.pathname.replace(/\/+$/u, "")}`;
  }

  public static projectUrl(value: string): string | null {
    if (!ChatGPTAdapter.isChatGPTUrl(value)) return null;
    const url = new URL(value);
    if (!/^\/g\/g-p-[\w-]+(?:\/project)?\/?$/u.test(url.pathname)) return null;
    const canonicalOrigin = url.hostname === "chat.openai.com" ? "https://chatgpt.com" : url.origin;
    return `${canonicalOrigin}${url.pathname.replace(/\/+$/u, "")}`;
  }

  public getConversationUrl(): string | null {
    return ChatGPTAdapter.conversationUrl(this.page.location.href);
  }

  private composer(): HTMLElement | null {
    return queryFirst<HTMLElement>(this.page, ChatGPTSelectors.composer);
  }

  public getComposerState(): "empty" | "non-empty" | "busy" | "unavailable" {
    if (
      queryFirst<HTMLElement>(this.page, ChatGPTSelectors.stopGeneratingButton) ||
      queryFirst<HTMLElement>(this.page, ChatGPTSelectors.ariaBusy)
    ) {
      return "busy";
    }

    const composer = this.composer();
    if (!composer) return "unavailable";
    if (ChatGPTSelectors.composerDisabled.some((selector) => composer.matches(selector))) {
      return "busy";
    }
    return normalizedEditorText(editorText(composer)).length === 0 ? "empty" : "non-empty";
  }

  /** Observe an explicit user gesture that can manually send the prepared prompt. */
  public watchForManualSubmit(
    onConfirmed: () => void,
    onGesture?: () => void,
  ): () => void {
    const userMessageCountBefore = queryAllFirstGroup<HTMLElement>(
      this.page,
      ChatGPTSelectors.userMessages,
    ).length;
    const controller = new AbortController();
    let confirmationInFlight = false;
    let confirmed = false;
    const observeConfirmation = (): void => {
      if (confirmed || confirmationInFlight) return;
      onGesture?.();
      confirmationInFlight = true;
      void waitForCondition(
        () => {
          const currentComposer = this.composer();
          const composerCleared = Boolean(
            currentComposer && normalizedEditorText(editorText(currentComposer)).length === 0,
          );
          const userMessageAdded =
            queryAllFirstGroup<HTMLElement>(this.page, ChatGPTSelectors.userMessages).length >
            userMessageCountBefore;
          return composerCleared || userMessageAdded;
        },
        {
          root: this.page.documentElement,
          timeoutMs: 12_000,
          signal: controller.signal,
        },
      )
        .then(() => {
          confirmed = true;
          onConfirmed();
        })
        .catch(() => undefined)
        .finally(() => {
          confirmationInFlight = false;
        });
    };
    const onClick = (event: MouseEvent): void => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const isSendControl = ChatGPTSelectors.sendButton.some((selector) => {
        try {
          return target.matches(selector) || target.closest(selector) !== null;
        } catch {
          return false;
        }
      });
      if (isSendControl) observeConfirmation();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target instanceof Node ? event.target : null;
      const currentComposer = this.composer();
      if (
        currentComposer &&
        target &&
        (target === currentComposer || currentComposer.contains(target)) &&
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.isComposing
      ) {
        observeConfirmation();
      }
    };
    this.page.addEventListener("click", onClick, true);
    this.page.addEventListener("keydown", onKeyDown, true);
    return () => {
      controller.abort();
      this.page.removeEventListener("click", onClick, true);
      this.page.removeEventListener("keydown", onKeyDown, true);
    };
  }

  public async ensureLoggedIn(): Promise<void> {
    if (!ChatGPTAdapter.isChatGPTUrl(this.page.location.href)) {
      throw new ChatGPTAdapterError(
        "CHATGPT_UNSUPPORTED_URL",
        "当前标签页不是 ChatGPT 网页。",
        false,
      );
    }

    const state = await waitForCondition(
      () => {
        const composer = this.composer();
        if (composer) return { composer } as const;
        const loginControl = queryFirst<HTMLElement>(this.page, ChatGPTSelectors.loginControls);
        return loginControl ? ({ loginControl } as const) : null;
      },
      { root: this.page.documentElement, timeoutMs: 12_000 },
    ).catch(() => null);

    if (!state || "loginControl" in state) {
      throw new ChatGPTAdapterError(
        "CHATGPT_LOGIN_REQUIRED",
        "请先登录 ChatGPT，然后重试。",
        true,
      );
    }
  }

  private async followLink(link: HTMLAnchorElement): Promise<void> {
    const before = this.page.location.href;
    link.click();
    await waitForCondition(
      () => this.page.location.href !== before,
      { root: this.page.documentElement, timeoutMs: 10_000 },
    );
    await waitForDomStable({ root: this.page.body, quietMs: 150, timeoutMs: 10_000 });
  }

  public async openProject(projectName: string, projectUrl?: string): Promise<void> {
    if (projectUrl) {
      try {
        const current = new URL(this.page.location.href);
        const expected = new URL(projectUrl);
        if (current.origin === expected.origin && current.pathname.startsWith(expected.pathname)) return;
      } catch {
        // The settings URL is validated by the worker; use name fallback here.
      }
    }

    const link = findNamedLink(
      this.page,
      ChatGPTSelectors.projectLinks,
      projectName,
      projectUrl,
    );
    if (!link) {
      throw new ChatGPTAdapterError(
        "CHATGPT_PROJECT_NOT_FOUND",
        `未找到“${projectName}”Project，请检查扩展中的 ChatGPT 设置。`,
        true,
      );
    }
    if (link.getAttribute("aria-current") || link.href === this.page.location.href) return;
    await this.followLink(link);
  }

  public async openConversation(conversationName: string, conversationUrl?: string): Promise<void> {
    const currentConversation = this.getConversationUrl();
    if (conversationUrl && currentConversation === ChatGPTAdapter.conversationUrl(conversationUrl)) return;

    const link = findNamedLink(
      this.page,
      ChatGPTSelectors.conversationLinks,
      conversationName,
      conversationUrl,
    );
    if (!link) {
      throw new ChatGPTAdapterError(
        "CHATGPT_CONVERSATION_NOT_FOUND",
        `未找到试卷对应的 ChatGPT 对话“${conversationName}”。`,
        true,
      );
    }
    if (link.getAttribute("aria-current") || link.href === this.page.location.href) return;
    await this.followLink(link);
  }

  public async createConversation(): Promise<void> {
    if (!this.getConversationUrl() && this.composer()) return;
    const button = queryFirst<HTMLElement>(this.page, ChatGPTSelectors.newConversation);
    if (!button) {
      throw new ChatGPTAdapterError(
        "CHATGPT_NEW_CONVERSATION_FAILED",
        "无法在当前 Project 中创建新对话。",
        true,
      );
    }
    button.click();
    try {
      await waitForElement<HTMLElement>(ChatGPTSelectors.composer, {
        root: this.page.documentElement,
        timeoutMs: 12_000,
      });
      await waitForDomStable({ root: this.page.body, quietMs: 150, timeoutMs: 10_000 });
    } catch {
      throw new ChatGPTAdapterError(
        "CHATGPT_NEW_CONVERSATION_FAILED",
        "创建 ChatGPT 对话后编辑框未出现，请刷新页面重试。",
        true,
      );
    }
  }

  public async fillPrompt(prompt: string): Promise<void> {
    if (!prompt.trim()) {
      throw new ChatGPTAdapterError(
        "CHATGPT_PROMPT_FILL_FAILED",
        "待填充的批改提示词为空。",
        false,
      );
    }

    let composer: HTMLElement;
    try {
      composer = await waitForElement<HTMLElement>(ChatGPTSelectors.composer, {
        root: this.page.documentElement,
        timeoutMs: 12_000,
      });
    } catch {
      throw new ChatGPTAdapterError(
        "CHATGPT_COMPOSER_NOT_FOUND",
        "未找到 ChatGPT 输入框，网页结构可能已经更新。",
        true,
      );
    }

    const existingPrompt = normalizedEditorText(editorText(composer));
    const nextPrompt = normalizedEditorText(prompt);
    if (existingPrompt) {
      if (existingPrompt === nextPrompt) return;
      throw new ChatGPTAdapterError(
        "CHATGPT_COMPOSER_NOT_EMPTY",
        "ChatGPT 输入框中已有尚未发送的其他 Prompt。为防止覆盖，请先发送或清空原内容后再重试。",
        true,
      );
    }

    composer.focus();
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      setNativeValue(composer, prompt);
      dispatchEditorEvents(composer, prompt);
    } else {
      assignContentEditable(composer, prompt);
    }

    await waitForDomStable({
      root: this.page.documentElement,
      quietMs: 80,
      timeoutMs: 3_000,
    }).catch(() => undefined);
    // React/ProseMirror may replace the composer node in response to the input
    // event. Validate the live selector result, never a detached stale node.
    const liveComposer = this.composer();
    if (
      !liveComposer?.isConnected ||
      normalizedEditorText(editorText(liveComposer)) !== nextPrompt
    ) {
      throw new ChatGPTAdapterError(
        "CHATGPT_PROMPT_FILL_FAILED",
        "ChatGPT 输入框未完整接受提示词，网页结构可能已经更新。",
        true,
      );
    }
  }

  public async submitPrompt(): Promise<void> {
    const composer = this.composer();
    if (!composer || normalizedEditorText(editorText(composer)).length === 0) {
      throw new ChatGPTAdapterError(
        "CHATGPT_SUBMIT_FAILED",
        "ChatGPT 输入框中没有可发送的 Prompt。",
        false,
      );
    }
    const userMessageCountBefore = queryAllFirstGroup<HTMLElement>(
      this.page,
      ChatGPTSelectors.userMessages,
    ).length;
    let sendButton: HTMLButtonElement;
    try {
      sendButton = await waitForCondition(
        () => {
          const button = queryFirst<HTMLButtonElement>(this.page, ChatGPTSelectors.sendButton);
          return button && isElementUsable(button) ? button : null;
        },
        { root: this.page.documentElement, timeoutMs: 8_000 },
      );
    } catch {
      throw new ChatGPTAdapterError(
        "CHATGPT_SEND_BUTTON_NOT_FOUND",
        "未找到可用的 ChatGPT 发送按钮；提示词已保留在输入框中。",
        true,
      );
    }

    sendButton.click();
    try {
      await waitForCondition(
        () => {
          const currentComposer = this.composer();
          const composerCleared = Boolean(
            currentComposer &&
            normalizedEditorText(editorText(currentComposer)).length === 0 &&
            (currentComposer === composer || !composer.isConnected),
          );
          const userMessageAdded =
            queryAllFirstGroup<HTMLElement>(this.page, ChatGPTSelectors.userMessages).length >
            userMessageCountBefore;
          return composerCleared || userMessageAdded;
        },
        { root: this.page.documentElement, timeoutMs: 12_000 },
      );
    } catch {
      throw new ChatGPTAdapterError(
        "CHATGPT_DELIVERY_UNCERTAIN",
        "已点击发送，但未观察到输入框清空或用户消息新增；为防止重复提交，请先在 ChatGPT 页面确认。",
        false,
      );
    }
    const readyRoot = queryFirst<HTMLElement>(this.page, ChatGPTSelectors.pageReadyRoot) ?? this.page.body;
    await waitForDomStable({ root: readyRoot, quietMs: 180, timeoutMs: 12_000 }).catch(() => undefined);
  }

  /** Submit the prepared prompt and resolve only after a new assistant turn is complete. */
  public async submitPromptAndWaitForResponse(timeoutMs = 180_000): Promise<string> {
    const assistantCountBefore = queryAllFirstGroup<HTMLElement>(
      this.page,
      ChatGPTSelectors.assistantMessages,
    ).length;
    await this.submitPrompt();

    let responseElement: HTMLElement;
    try {
      responseElement = await waitForCondition(
        () => {
          const messages = queryAllFirstGroup<HTMLElement>(
            this.page,
            ChatGPTSelectors.assistantMessages,
          );
          if (messages.length <= assistantCountBefore) return null;
          const latest = messages[messages.length - 1];
          if (!latest) return null;
          const body = queryFirst<HTMLElement>(latest, ChatGPTSelectors.assistantMessageBody) ?? latest;
          const generating =
            queryFirst(this.page, ChatGPTSelectors.stopGeneratingButton) !== null ||
            latest.matches("[aria-busy='true']") ||
            queryFirst(latest, ChatGPTSelectors.ariaBusy) !== null;
          return !generating && readableElementText(body) ? body : null;
        },
        { root: this.page.documentElement, timeoutMs },
      );
    } catch {
      throw new ChatGPTAdapterError(
        "CHATGPT_DELIVERY_UNCERTAIN",
        "消息已发送，但在等待时间内没有读取到完整的 ChatGPT 批改回复。请打开对应对话检查。",
        false,
      );
    }

    await waitForDomStable({ root: responseElement, quietMs: 700, timeoutMs: 5_000 })
      .catch(() => undefined);
    const responseText = readableElementText(responseElement);
    if (!responseText) {
      throw new ChatGPTAdapterError(
        "CHATGPT_DELIVERY_UNCERTAIN",
        "ChatGPT 已结束生成，但批改回复为空。请打开对应对话检查。",
        false,
      );
    }
    return responseText;
  }

  public async waitForConversationUrl(timeoutMs = 20_000): Promise<string> {
    try {
      return await waitForCondition(
        () => this.getConversationUrl(),
        { root: this.page.documentElement, timeoutMs },
      );
    } catch {
      throw new ChatGPTAdapterError(
        "CHATGPT_DELIVERY_UNCERTAIN",
        "已点击发送，但未能识别新对话 URL；请在 ChatGPT 页面确认发送结果。",
        false,
      );
    }
  }

  /** Best-effort DOM automation kept entirely inside the ChatGPT adapter. */
  public async renameCurrentConversation(
    conversationName: string,
    retryAfterGeneratedTitleRace = true,
  ): Promise<void> {
    const expectedName = conversationName.normalize("NFKC").trim();
    const conversationUrl = this.getConversationUrl();
    if (!expectedName || !conversationUrl) {
      throw new ChatGPTAdapterError(
        "CHATGPT_RENAME_REQUIRED",
        "消息已发送，但无法识别当前对话，未能按试卷名称重命名。请勿重复提交；请在 ChatGPT 中手动重命名。",
        false,
      );
    }

    const assertStillCurrent = (): void => {
      if (this.getConversationUrl() !== conversationUrl) {
        throw new ChatGPTAdapterError(
          "CHATGPT_RENAME_REQUIRED",
          "对话重命名期间页面已切换。原对话已保留，请回到该对话后手动核对名称。",
          false,
        );
      }
    };

    const locateCurrentLink = (): HTMLAnchorElement | null =>
      Array.from(
        this.page.querySelectorAll<HTMLAnchorElement>(ChatGPTSelectors.conversationLinks.join(",")),
      ).find((link) => ChatGPTAdapter.conversationUrl(link.href) === conversationUrl) ?? null;
    const titleMatches = (): boolean => {
      const link = locateCurrentLink();
      if (link && normalizedComparableText(normalizedText(link)) === normalizedComparableText(expectedName)) {
        return true;
      }
      const visibleTitle = ChatGPTSelectors.currentConversationTitle.some((selector) => {
        try {
          return Array.from(this.page.querySelectorAll<HTMLElement>(selector)).some(
            (element) => normalizedComparableText(normalizedText(element)) === normalizedComparableText(expectedName),
          );
        } catch {
          return false;
        }
      });
      if (visibleTitle) return true;
      const documentTitle = normalizedComparableText(this.page.title)
        .replace(/\s*[-–—|]\s*chatgpt.*$/u, "")
        .trim();
      return documentTitle === normalizedComparableText(expectedName);
    };
    const currentLink =
      locateCurrentLink() ??
      (await waitForCondition(locateCurrentLink, {
        root: this.page.documentElement,
        timeoutMs: 8_000,
      }).catch(() => null));
    if (titleMatches()) {
      return;
    }

    const rowCandidates: HTMLElement[] = [];
    let ancestor = currentLink?.parentElement ?? null;
    while (ancestor && ancestor !== this.page.body && rowCandidates.length < 8) {
      const conversationLinks = Array.from(ancestor.querySelectorAll<HTMLAnchorElement>("a[href*='/c/']"));
      const distinctConversationUrls = new Set(
        conversationLinks.map((link) => ChatGPTAdapter.conversationUrl(link.href)).filter(Boolean),
      );
      if (distinctConversationUrls.size > 1) break;
      rowCandidates.push(ancestor);
      ancestor = ancestor.parentElement;
    }
    if (currentLink && rowCandidates.length === 0 && currentLink.parentElement) {
      rowCandidates.push(currentLink.parentElement);
    }
    for (const candidate of rowCandidates) {
      candidate.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      candidate.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      candidate.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    }

    const locateMenuButton = (): HTMLElement | null => {
      for (const candidate of rowCandidates) {
        const button = queryFirst<HTMLElement>(candidate, ChatGPTSelectors.conversationMenuButton);
        if (button) return button;
      }
      return queryFirst<HTMLElement>(this.page, ChatGPTSelectors.currentConversationMenuButton);
    };
    let menuButton = locateMenuButton();
    if (!menuButton) {
      menuButton = await waitForCondition(locateMenuButton, {
        root: this.page.documentElement,
        timeoutMs: 4_000,
      }).catch(() => null);
    }
    assertStillCurrent();
    if (menuButton) {
      activateElement(menuButton);
    } else {
      // Some Project chat rows expose the same menu only through a context menu.
      const contextTarget = rowCandidates[0] ?? currentLink;
      contextTarget?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        buttons: 2,
      }));
    }

    const renameAction = await waitForCondition(
      () =>
        findControlByText<HTMLElement>(this.page, ChatGPTSelectors.menuItems, [
          "Rename",
          "Rename chat",
          "Rename conversation",
          "重命名",
          "重命名聊天",
          "重命名对话",
        ]),
      { root: this.page.documentElement, timeoutMs: 5_000 },
    ).catch(() => null);
    if (!renameAction) {
      throw new ChatGPTAdapterError(
        "CHATGPT_RENAME_REQUIRED",
        "消息已发送且对话已绑定，但未能打开当前 Project 对话的“重命名”菜单。请在 ChatGPT 中手动修改对话名称。",
        false,
      );
    }
    assertStillCurrent();
    activateElement(renameAction);

    const locateRenameInput = (): HTMLInputElement | null => {
      for (const candidate of rowCandidates) {
        const candidateInput =
          queryFirst<HTMLInputElement>(candidate, ChatGPTSelectors.renameInput) ??
          candidate.querySelector<HTMLInputElement>("input[type='text']");
        if (candidateInput) return candidateInput;
      }
      return queryFirst<HTMLInputElement>(this.page, ChatGPTSelectors.renameInput);
    };
    const input = await waitForCondition(locateRenameInput, {
      root: this.page.documentElement,
      timeoutMs: 5_000,
    }).catch(() => null);
    if (!input) {
      throw new ChatGPTAdapterError(
        "CHATGPT_RENAME_REQUIRED",
        "消息已发送且对话已绑定，但未找到重命名输入框。请勿重复提交；请手动修改对话名称。",
        false,
      );
    }
    input.focus();
    setNativeValue(input, expectedName);
    dispatchEditorEvents(input, expectedName);

    const confirmRoot = input.closest<HTMLElement>("[role='dialog'], form") ?? input.parentElement;
    const confirm =
      queryFirst<HTMLButtonElement>(this.page, ChatGPTSelectors.renameConfirmButton) ??
      (confirmRoot ? findControlByText<HTMLButtonElement>(confirmRoot, ["button"], [
        "Save",
        "Rename",
        "保存",
        "重命名",
        "确认",
      ]) : null);
    assertStillCurrent();
    if (confirm && isElementUsable(confirm)) {
      activateElement(confirm);
    } else {
      // Current Project UI may use an inline editor with Enter as the only
      // confirmation mechanism and no visible Save button.
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }));
      input.dispatchEvent(new KeyboardEvent("keyup", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }));
    }

    const renamed = await waitForCondition(
      () => titleMatches(),
      { root: this.page.documentElement, timeoutMs: 8_000 },
    ).catch(() => null);
    if (!renamed) {
      throw new ChatGPTAdapterError(
        "CHATGPT_RENAME_REQUIRED",
        "消息已发送且对话已绑定，但无法确认对话已成功重命名。请勿重复提交；请手动核对名称。",
        false,
      );
    }
    await waitForDomStable({
      root: this.page.documentElement,
      quietMs: 1_200,
      timeoutMs: 4_000,
    }).catch(() => undefined);
    if (!titleMatches()) {
      if (retryAfterGeneratedTitleRace) {
        await this.renameCurrentConversation(expectedName, false);
        return;
      }
      throw new ChatGPTAdapterError(
        "CHATGPT_RENAME_REQUIRED",
        "ChatGPT 自动标题覆盖了指定名称，第二次重命名后仍未保持。请手动核对对话名称。",
        false,
      );
    }
  }
}
