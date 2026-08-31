import { useEffect, useState } from "react";
import { ChatGPTAdapter } from "../../adapters/ChatGPTAdapter";
import { normalizeDeepSeekBaseUrl } from "../../services/deepSeekProvider";
import type { AppSettings } from "../../types";

interface SettingsPageProps {
  settings: AppSettings;
  saving: boolean;
  onSave: (settings: AppSettings) => Promise<void>;
  onOpenChatGPT: () => void;
  onOpenUrl: (url: string) => void;
}

interface ToggleProps {
  checked: boolean;
  label: string;
  description?: string;
  onChange: (checked: boolean) => void;
}

function Toggle({ checked, label, description, onChange }: ToggleProps): JSX.Element {
  return (
    <label className="toggle-row">
      <span><strong>{label}</strong>{description ? <small>{description}</small> : null}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="toggle" aria-hidden="true" />
    </label>
  );
}

export function SettingsPage({ settings, saving, onSave, onOpenChatGPT, onOpenUrl }: SettingsPageProps): JSX.Element {
  const [draft, setDraft] = useState(settings);
  const [urlError, setUrlError] = useState("");
  const [deepseekUrlError, setDeepseekUrlError] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  useEffect(() => setDraft(settings), [settings]);

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = async (): Promise<void> => {
    const url = draft.projectUrl.trim();
    let normalizedUrl = "";
    if (url) {
      const candidate = ChatGPTAdapter.projectUrl(url);
      if (!candidate) {
        setUrlError("请输入有效的 ChatGPT Project 地址，例如 https://chatgpt.com/g/g-p-.../project。");
        return;
      }
      normalizedUrl = candidate;
    }
    if (!draft.projectName.trim()) return;
    const deepseekApiBaseUrl = normalizeDeepSeekBaseUrl(draft.deepseekApiBaseUrl);
    if (!deepseekApiBaseUrl) {
      setDeepseekUrlError("目前仅支持官方地址 https://api.deepseek.com。");
      return;
    }
    setUrlError("");
    setDeepseekUrlError("");
    try {
      await onSave({
        ...draft,
        projectName: draft.projectName.trim(),
        projectUrl: normalizedUrl,
        deepseekApiBaseUrl,
        deepseekApiKey: draft.deepseekApiKey.trim(),
        updatedAt: Date.now(),
      });
    } catch {
      // App-level status reports the error while the draft remains editable.
    }
  };

  return (
    <main className="page settings-page">
      <div className="page-heading"><div><span className="eyebrow">偏好保存在本机</span><h2>设置</h2><p>配置批改引擎、草稿保存与答题信息显示。</p></div></div>

      <section className="card settings-card" aria-labelledby="chatgpt-settings">
        <div className="section-heading"><div><span className="eyebrow">网页联动</span><h3 id="chatgpt-settings">ChatGPT Project</h3></div><button className="text-button" type="button" onClick={onOpenChatGPT}>打开 ChatGPT</button></div>
        <label className="field"><span>Project 名称</span><input type="text" value={draft.projectName} onChange={(event) => update("projectName", event.target.value)} placeholder="申论训练" /></label>
        <label className="field"><span>Project URL <small>推荐填写，避免按名称查找失败</small></span><input type="url" value={draft.projectUrl} onChange={(event) => { update("projectUrl", event.target.value); setUrlError(""); }} placeholder="https://chatgpt.com/g/.../project" aria-invalid={Boolean(urlError)} aria-describedby={urlError ? "project-url-error" : undefined} /></label>
        {urlError ? <p className="field-error" id="project-url-error">{urlError}</p> : null}
      </section>

      <section className="card settings-card" aria-labelledby="deepseek-settings">
        <div className="section-heading"><div><span className="eyebrow">API 批改</span><h3 id="deepseek-settings">DeepSeek API</h3></div><button className="text-button" type="button" onClick={() => onOpenUrl("https://platform.deepseek.com/api_keys")}>管理 Key</button></div>
        <label className="field"><span>API Base URL</span><input type="url" value={draft.deepseekApiBaseUrl} onChange={(event) => { update("deepseekApiBaseUrl", event.target.value); setDeepseekUrlError(""); }} placeholder="https://api.deepseek.com" aria-invalid={Boolean(deepseekUrlError)} /></label>
        {deepseekUrlError ? <p className="field-error">{deepseekUrlError}</p> : null}
        <label className="field"><span>API Key <small>仅保存在当前扩展的本机数据库</small></span><div className="secret-field"><input type={showApiKey ? "text" : "password"} value={draft.deepseekApiKey} onChange={(event) => update("deepseekApiKey", event.target.value)} placeholder="sk-..." autoComplete="off" spellCheck={false} /><button className="button button--quiet" type="button" onClick={() => setShowApiKey((visible) => !visible)}>{showApiKey ? "隐藏" : "显示"}</button></div></label>
      </section>

      <section className="card settings-card" aria-labelledby="submit-settings">
        <div className="section-heading"><div><span className="eyebrow">提交本题后</span><h3 id="submit-settings">自动操作</h3></div></div>
        <p className="muted">ChatGPT 会在后台标签页发送并等待结果；DeepSeek 会直接请求官方接口。需要核对来源时，可在批改结果中点击“打开页面查看”。</p>
      </section>

      <section className="card settings-card" aria-labelledby="answer-settings">
        <div className="section-heading"><div><span className="eyebrow">Side Panel</span><h3 id="answer-settings">答题显示与保存</h3></div></div>
        <Toggle checked={draft.autoSave} label="自动保存草稿" description="停止输入 700ms 后保存，计时每 10 秒 checkpoint。" onChange={(value) => update("autoSave", value)} />
        <Toggle checked={draft.showWordCount} label="显示字数" onChange={(value) => update("showWordCount", value)} />
        <Toggle checked={draft.showQuestionTimer} label="显示题目计时" onChange={(value) => update("showQuestionTimer", value)} />
        <Toggle checked={draft.showTotalTimer} label="显示总计时" onChange={(value) => update("showTotalTimer", value)} />
      </section>

      <div className="settings-savebar"><span>{JSON.stringify(draft) === JSON.stringify(settings) ? "设置已保存" : "有未保存的更改"}</span><button className="button button--primary" type="button" disabled={saving || !draft.projectName.trim()} onClick={() => void save()}>{saving ? "保存中…" : "保存设置"}</button></div>
    </main>
  );
}
