/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url":"https://chatgpt.com/c/conversation-123"}
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatGPTAdapter } from "../../src/adapters/ChatGPTAdapter";

describe("ChatGPTAdapter", () => {
  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    document.body.innerHTML = `
      <nav>
        <ul>
          <li id="current-row">
            <a href="/c/conversation-123">Generated title</a>
            <button aria-label="Open conversation options">...</button>
          </li>
        </ul>
      </nav>
      <main><div id="prompt-textarea" contenteditable="true" role="textbox"></div></main>
    `;

    const menuButton = document.querySelector<HTMLButtonElement>(
      "button[aria-label='Open conversation options']",
    );
    menuButton?.addEventListener("click", () => {
      const menu = document.createElement("div");
      menu.setAttribute("role", "menu");
      menu.innerHTML = '<button role="menuitem">Rename</button>';
      document.body.append(menu);
      menu.querySelector("[role='menuitem']")?.addEventListener("click", () => {
        const dialog = document.createElement("div");
        dialog.setAttribute("role", "dialog");
        dialog.innerHTML = '<input value="Generated title"><button type="submit">Save</button>';
        document.body.append(dialog);
        dialog.querySelector("button")?.addEventListener("click", () => {
          const input = dialog.querySelector<HTMLInputElement>("input");
          const link = document.querySelector<HTMLAnchorElement>("a[href*='/c/']");
          if (input && link) link.textContent = input.value;
          dialog.remove();
          menu.remove();
        });
      });
    });
  });

  it("recognizes only ChatGPT conversation URLs", () => {
    expect(ChatGPTAdapter.conversationUrl("https://chatgpt.com/c/abc?q=1")).toBe(
      "https://chatgpt.com/c/abc",
    );
    expect(ChatGPTAdapter.conversationUrl("https://chatgpt.com/g/g-p-project/c/abc")).toBe(
      "https://chatgpt.com/g/g-p-project/c/abc",
    );
    expect(ChatGPTAdapter.conversationUrl("https://example.com/c/abc")).toBeNull();
    expect(ChatGPTAdapter.conversationUrl("https://chatgpt.com/")).toBeNull();
  });

  it("recognizes and canonicalizes ChatGPT Project URLs", () => {
    expect(ChatGPTAdapter.projectUrl(
      "https://chatgpt.com/g/g-p-6a954264e9c48191954cd04c2f601e27/project?utm_source=test",
    )).toBe("https://chatgpt.com/g/g-p-6a954264e9c48191954cd04c2f601e27/project");
    expect(ChatGPTAdapter.projectUrl("https://chat.openai.com/g/g-p-example/project/"))
      .toBe("https://chatgpt.com/g/g-p-example/project");
    expect(ChatGPTAdapter.projectUrl("https://chatgpt.com/c/not-a-project")).toBeNull();
    expect(ChatGPTAdapter.projectUrl("https://example.com/g/g-p-example/project")).toBeNull();
  });

  it("renames the current conversation through centralized selector fallbacks", async () => {
    const adapter = new ChatGPTAdapter(document);
    await adapter.renameCurrentConversation("2024国考行政执法卷-申论批改");
    expect(document.querySelector("a[href*='/c/']")?.textContent).toBe(
      "2024国考行政执法卷-申论批改",
    );
  });

  it("renames a Project conversation when its menu is on an outer row and Enter confirms inline editing", async () => {
    document.body.innerHTML = `
      <aside>
        <section data-project-chat-row>
          <div><a href="/c/conversation-123">Generated project title</a></div>
          <div><button data-testid="history-item-conversation-123-options">...</button></div>
        </section>
      </aside>
      <main><div id="prompt-textarea" contenteditable="true" role="textbox"></div></main>
    `;
    const row = document.querySelector<HTMLElement>("[data-project-chat-row]");
    const menuButton = document.querySelector<HTMLButtonElement>("button[data-testid$='-options']");
    menuButton?.addEventListener("click", () => {
      const menu = document.createElement("div");
      menu.setAttribute("role", "menu");
      menu.innerHTML = '<button role="menuitem" aria-label="Rename conversation">Rename conversation</button>';
      document.body.append(menu);
      menu.querySelector("[role='menuitem']")?.addEventListener("click", () => {
        menu.remove();
        const input = document.createElement("input");
        input.type = "text";
        input.value = "Generated project title";
        row?.append(input);
        input.addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          const link = row?.querySelector<HTMLAnchorElement>("a[href*='/c/']");
          if (link) link.textContent = input.value;
          input.remove();
        });
      });
    });

    await expect(
      new ChatGPTAdapter(document).renameCurrentConversation("测试申论试卷-申论批改"),
    ).resolves.toBeUndefined();
    expect(row?.querySelector("a")?.textContent).toBe("测试申论试卷-申论批改");
  });

  it("reapplies the requested name if ChatGPT's generated title wins a late race", async () => {
    const link = document.querySelector<HTMLAnchorElement>("a[href*='/c/']");
    if (!link) throw new Error("conversation link fixture missing");
    let overwritten = false;
    const observer = new MutationObserver(() => {
      if (overwritten || link.textContent !== "测试卷-申论批改") return;
      overwritten = true;
      globalThis.setTimeout(() => {
        link.textContent = "Late generated title";
      }, 50);
    });
    observer.observe(link, { childList: true, characterData: true, subtree: true });

    await new ChatGPTAdapter(document).renameCurrentConversation("测试卷-申论批改");
    observer.disconnect();
    expect(overwritten).toBe(true);
    expect(link.textContent).toBe("测试卷-申论批改");
  });

  it("does not overwrite a different prompt that is waiting for manual submission", async () => {
    const composer = document.querySelector<HTMLElement>("#prompt-textarea");
    if (!composer) throw new Error("composer fixture missing");
    composer.textContent = "previous unsent prompt";

    const adapter = new ChatGPTAdapter(document);
    await expect(adapter.fillPrompt("new prompt")).rejects.toMatchObject({
      code: "CHATGPT_COMPOSER_NOT_EMPTY",
    });
    expect(composer.textContent).toBe("previous unsent prompt");
  });

  it("allows an idempotent retry when the composer already has the same prompt", async () => {
    const composer = document.querySelector<HTMLElement>("#prompt-textarea");
    if (!composer) throw new Error("composer fixture missing");
    composer.textContent = "same prompt";

    const adapter = new ChatGPTAdapter(document);
    await expect(adapter.fillPrompt("same prompt")).resolves.toBeUndefined();
    expect(composer.textContent).toBe("same prompt");
  });

  it.each([
    ["stop-generating button", () => {
      const button = document.createElement("button");
      button.setAttribute("aria-label", "Stop generating");
      document.body.append(button);
    }],
    ["localized stop-generating button", () => {
      const button = document.createElement("button");
      button.setAttribute("aria-label", "停止生成");
      document.body.append(button);
    }],
    ["aria-busy region", () => {
      document.querySelector("main")?.setAttribute("aria-busy", "true");
    }],
    ["disabled composer", () => {
      document.querySelector("#prompt-textarea")?.setAttribute("disabled", "");
    }],
    ["aria-disabled composer", () => {
      document.querySelector("#prompt-textarea")?.setAttribute("aria-disabled", "true");
    }],
  ])("reports busy for a %s before considering composer text", (_label, arrange) => {
    const composer = document.querySelector<HTMLElement>("#prompt-textarea");
    if (!composer) throw new Error("composer fixture missing");
    composer.textContent = "prompt that must not make the tab reusable";
    arrange();

    expect(new ChatGPTAdapter(document).getComposerState()).toBe("busy");
  });

  it("rejects a fill when the input event replaces the composer with an empty node", async () => {
    const originalComposer = document.querySelector<HTMLElement>("#prompt-textarea");
    if (!originalComposer) throw new Error("composer fixture missing");
    originalComposer.addEventListener("input", () => {
      const replacementComposer = originalComposer.cloneNode(false) as HTMLElement;
      originalComposer.replaceWith(replacementComposer);
    });

    await expect(new ChatGPTAdapter(document).fillPrompt("new prompt")).rejects.toMatchObject({
      code: "CHATGPT_PROMPT_FILL_FAILED",
    });
    expect(originalComposer.isConnected).toBe(false);
    expect(document.querySelector<HTMLElement>("#prompt-textarea")?.textContent).toBe("");
  });

  it("confirms automatic submission from observable composer state", async () => {
    const composer = document.querySelector<HTMLElement>("#prompt-textarea");
    if (!composer) throw new Error("composer fixture missing");
    composer.textContent = "prompt to send";
    const button = document.createElement("button");
    button.dataset.testid = "send-button";
    button.addEventListener("click", () => {
      composer.textContent = "";
    });
    document.body.append(button);

    await expect(new ChatGPTAdapter(document).submitPrompt()).resolves.toBeUndefined();
  });

  it("waits for a new completed assistant response and returns its text", async () => {
    const composer = document.querySelector<HTMLElement>("#prompt-textarea");
    if (!composer) throw new Error("composer fixture missing");
    composer.textContent = "prompt to grade";
    const button = document.createElement("button");
    button.dataset.testid = "send-button";
    button.addEventListener("click", () => {
      composer.textContent = "";
      const stop = document.createElement("button");
      stop.dataset.testid = "stop-button";
      document.body.append(stop);
      globalThis.setTimeout(() => {
        const response = document.createElement("article");
        response.dataset.turn = "assistant";
        response.innerHTML = '<div class="markdown">## 得分\n16 / 20\n\n## 修改建议\n补充依据。</div>';
        document.querySelector("main")?.append(response);
        stop.remove();
      }, 10);
    });
    document.body.append(button);

    await expect(
      new ChatGPTAdapter(document).submitPromptAndWaitForResponse(2_000),
    ).resolves.toContain("16 / 20");
  });

  it("does not treat an existing conversation URL as proof that send succeeded", async () => {
    vi.useFakeTimers();
    const composer = document.querySelector<HTMLElement>("#prompt-textarea");
    if (!composer) throw new Error("composer fixture missing");
    composer.textContent = "prompt still present";
    const button = document.createElement("button");
    button.dataset.testid = "send-button";
    document.body.append(button);

    const submission = new ChatGPTAdapter(document).submitPrompt();
    const rejection = expect(submission).rejects.toMatchObject({
      code: "CHATGPT_DELIVERY_UNCERTAIN",
      retryable: false,
    });
    await vi.advanceTimersByTimeAsync(12_100);
    await rejection;
    expect(composer.textContent).toBe("prompt still present");
  });

  it("confirms a manual send in an existing conversation only after the composer clears", async () => {
    const composer = document.querySelector<HTMLElement>("#prompt-textarea");
    if (!composer) throw new Error("composer fixture missing");
    composer.textContent = "manual prompt";
    const button = document.createElement("button");
    button.dataset.testid = "send-button";
    button.addEventListener("click", () => {
      composer.textContent = "";
    });
    document.body.append(button);

    let gestureObserved = false;
    let confirmed = false;
    const stop = new ChatGPTAdapter(document).watchForManualSubmit(
      () => { confirmed = true; },
      () => { gestureObserved = true; },
    );
    button.click();
    expect(gestureObserved).toBe(true);
    await vi.waitFor(() => expect(confirmed).toBe(true));
    stop();
  });

  it("tracks Enter submission after ChatGPT replaces the composer node", async () => {
    const originalComposer = document.querySelector<HTMLElement>("#prompt-textarea");
    if (!originalComposer) throw new Error("composer fixture missing");
    originalComposer.textContent = "manual prompt";

    let confirmed = false;
    const stop = new ChatGPTAdapter(document).watchForManualSubmit(() => {
      confirmed = true;
    });

    const replacementComposer = originalComposer.cloneNode(false) as HTMLElement;
    replacementComposer.textContent = "manual prompt";
    originalComposer.replaceWith(replacementComposer);
    replacementComposer.addEventListener("keydown", () => {
      replacementComposer.textContent = "";
    });
    replacementComposer.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );

    await vi.waitFor(() => expect(confirmed).toBe(true));
    stop();
  });
});
