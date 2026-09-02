import { useEffect, useMemo, useRef, useState } from "react";
import {
  countShenlunCharacters,
  defaultModelForEngine,
  GRADING_ENGINES,
  gradingEngineLabel,
  gradingModelLabel,
  modelsForEngine,
  parseFeedbackModules,
} from "../../services";
import type {
  AppSettings,
  AttemptBundle,
  FeedbackRecord,
  GradingEngineId,
  GradingModelId,
  GradingTarget,
  QuestionAttempt,
  QuestionId,
} from "../../types";
import type { AttemptClock } from "../hooks/useAttemptTimer";
import { formatElapsed, formatShortElapsed } from "../utils";
import { Icon } from "../components/Icon";

export type SaveState = "idle" | "saving" | "saved" | "error";

interface PendingSubmissionView {
  readonly attemptId: string;
  readonly mode: "single-question" | "full-paper";
  readonly questionId?: QuestionId;
  readonly state: "preparing" | "manual" | "uncertain";
  readonly requestId: string;
  readonly ownerContextId: string;
  readonly createdAt: number;
}

interface PracticePageProps {
  bundle: AttemptBundle | null;
  activeQuestionId: QuestionId | null;
  settings: AppSettings;
  clock: AttemptClock;
  saveState: SaveState;
  busyAction: "scan" | "single" | "full" | "feedback" | "resolve" | null;
  pendingSubmission: PendingSubmissionView | null;
  pendingOwnedByThisPanel: boolean;
  preparingRecoveryAvailable: boolean;
  onScan: () => void;
  onSelectQuestion: (questionId: QuestionId) => void;
  onAnswerChange: (answer: string) => void;
  onPauseToggle: () => void;
  onSave: () => void;
  onClear: () => void;
  onSubmitQuestion: () => void;
  onSubmitFull: () => void;
  onResolvePendingSubmission: (sent: boolean) => void;
  onTakeOverPendingSubmission: () => void;
  onRecoverPreparingSubmission: () => void;
  onSaveFeedback: (rawText: string, scope: "question" | "paper") => Promise<void>;
  onSaveProjectUrl: (projectUrl: string) => Promise<void>;
  onRebindConversation: (conversationUrl: string) => Promise<void>;
  onOpenConversation: (conversationUrl: string) => void;
  onGradingTargetChange: (target: GradingTarget) => void;
}

function EmptyPractice({ scanning, onScan }: { scanning: boolean; onScan: () => void }): JSX.Element {
  return (
    <main className="empty-state page" aria-busy={scanning}>
      <div className="empty-state__art"><Icon name="scan" /></div>
      <h2>从当前网页开始练习</h2>
      <p>打开一套申论试卷后，一次扫描会提取全部小题及其批改上下文。</p>
      <button className="button button--primary button--large" type="button" disabled={scanning} onClick={onScan}>
        <Icon name="scan" />{scanning ? "正在扫描试卷…" : "扫描当前试卷"}
      </button>
      <p className="empty-state__hint">扫描期间请保持试卷页面打开，完成后会恢复原来的题目。</p>
    </main>
  );
}

function PaperSummary({ bundle, clock, settings }: { bundle: AttemptBundle; clock: AttemptClock; settings: AppSettings }): JSX.Element {
  const complete = bundle.questions.filter((question) => question.userAnswer.trim() || ["answered", "submitted", "graded"].includes(question.status)).length;
  return (
    <section className="paper-summary" aria-labelledby="paper-name">
      <div className="paper-summary__heading">
        <div><span className="eyebrow">当前试卷 · 第 {bundle.attempt.attemptNumber} 次练习</span><h2 id="paper-name">{bundle.paper.paperName}</h2></div>
        <span className={`pill pill--${bundle.attempt.status}`}>{bundle.attempt.status === "submitted" ? "已提交" : bundle.attempt.status === "completed" ? "已完成" : "答题中"}</span>
      </div>
      <div className="paper-summary__stats">
        <div><strong>{bundle.questions.length}</strong><span>题目</span></div>
        {settings.showTotalTimer ? <div><strong className="tabular">{formatElapsed(clock.totalElapsedSeconds)}</strong><span>总用时</span></div> : null}
        <div><strong>{complete} / {bundle.questions.length}</strong><span>已作答</span></div>
      </div>
    </section>
  );
}

function QuestionNavigation({ questions, activeQuestionId, disabled, onSelect }: { questions: readonly QuestionAttempt[]; activeQuestionId: QuestionId; disabled: boolean; onSelect: (id: QuestionId) => void }): JSX.Element {
  return (
    <nav className="question-nav" aria-label="题目导航">
      {questions.map((question) => {
        const current = question.questionId === activeQuestionId;
        const complete = Boolean(question.userAnswer.trim()) || ["answered", "submitted", "graded"].includes(question.status);
        return (
          <button key={question.questionId} className={`question-nav__item${current ? " is-current" : ""}${complete ? " is-complete" : ""}`} type="button" aria-current={current ? "step" : undefined} disabled={disabled} onClick={() => onSelect(question.questionId)}>
            <span className="question-nav__mark">{complete ? "✓" : current ? "●" : "○"}</span>
            <span>第 {question.index + 1} 题</span>
          </button>
        );
      })}
    </nav>
  );
}

interface FeedbackPanelProps {
  readonly questionFeedback: readonly FeedbackRecord[];
  readonly paperFeedback: readonly FeedbackRecord[];
  readonly projectUrl: string | undefined;
  readonly conversationUrl: string | undefined;
  readonly recoverConversation: boolean;
  readonly feedbackBusy: boolean;
  readonly rebindBusy: boolean;
  readonly questionFeedbackAllowed: boolean;
  readonly onSave: (rawText: string, scope: "question" | "paper") => Promise<void>;
  readonly onSaveProjectUrl: (projectUrl: string) => Promise<void>;
  readonly onRebind: (conversationUrl: string) => Promise<void>;
  readonly onOpenConversation: (conversationUrl: string) => void;
}

function FeedbackPanel({ questionFeedback, paperFeedback, projectUrl, conversationUrl, recoverConversation, feedbackBusy, rebindBusy, questionFeedbackAllowed, onSave, onSaveProjectUrl, onRebind, onOpenConversation }: FeedbackPanelProps): JSX.Element {
  const [rawText, setRawText] = useState("");
  const [scope, setScope] = useState<"question" | "paper">("question");
  const [revisionIndex, setRevisionIndex] = useState(0);
  const pasteFieldRef = useRef<HTMLTextAreaElement>(null);
  const records = scope === "question" ? questionFeedback : paperFeedback;
  const latest = records[revisionIndex] ?? records[0];
  const modules = useMemo(
    () => latest ? parseFeedbackModules(latest.feedback.rawText) : [],
    [latest],
  );
  const resultSourceUrl = latest?.feedback.sourceUrl ?? conversationUrl;
  useEffect(() => setRevisionIndex(0), [scope, records.length]);
  const conversationMode = Boolean(conversationUrl) || recoverConversation;
  const targetUrl = conversationMode ? conversationUrl ?? "" : projectUrl ?? "";
  const [bindingUrl, setBindingUrl] = useState(targetUrl);
  useEffect(() => setBindingUrl(targetUrl), [targetUrl]);
  const save = async (): Promise<void> => {
    if (!rawText.trim()) return;
    try {
      await onSave(rawText.trim(), scope);
      setRawText("");
    } catch {
      // App-level status keeps the pasted text available for retry.
    }
  };
  const focusPasteField = (): void => {
    pasteFieldRef.current?.focus();
  };

  return (
    <section className="card feedback-card" aria-labelledby="feedback-heading">
      <div className="section-heading">
        <div><span className="eyebrow">多引擎批改</span><h3 id="feedback-heading">AI 批改结果</h3></div>
        <div className="feedback-card__heading-actions">
          {resultSourceUrl ? <button className="button button--quiet" type="button" onClick={() => onOpenConversation(resultSourceUrl)}>打开页面查看</button> : null}
          {latest ? <span className="pill pill--graded">已保存</span> : null}
        </div>
      </div>
      <div className="feedback-toolbar">
        <div className="segmented" aria-label="批改结果范围">
          <button type="button" className={scope === "question" ? "is-active" : ""} onClick={() => setScope("question")}>本题</button>
          <button type="button" className={scope === "paper" ? "is-active" : ""} onClick={() => setScope("paper")}>整卷</button>
        </div>
        {records.length > 1 ? (
          <select value={revisionIndex} onChange={(event) => setRevisionIndex(Number(event.target.value))} aria-label="选择批改记录">
            {records.map((record, index) => <option key={record.feedbackId} value={index}>第 {records.length - index} 次批改</option>)}
          </select>
        ) : null}
      </div>
      {latest ? (
        <div className="feedback-result">
          <span className="eyebrow">{scope === "question" ? "本题批改" : "整卷批改"}</span>
          {latest.feedback.engine && latest.feedback.model ? <p className="feedback-result__provider">{gradingEngineLabel(latest.feedback.engine)} · {gradingModelLabel(latest.feedback.model)}</p> : null}
          {latest.feedback.score !== undefined ? <p className="feedback-result__score"><span>得分</span><strong>{latest.feedback.score}{latest.feedback.maxScore !== undefined ? ` / ${latest.feedback.maxScore}` : ""}</strong></p> : null}
          <div className="feedback-modules">
            {modules.map((module, index) => (
              <section className="feedback-module" key={`${module.title}-${index}`}>
                <h4>{module.title}</h4>
                <div className="reading-text">{module.content}</div>
              </section>
            ))}
          </div>
          <details className="feedback-raw">
            <summary><span>原始完整内容</span><strong>{latest.feedback.rawText.length} 字符</strong></summary>
            <div className="reading-text">{latest.feedback.rawText}</div>
          </details>
        </div>
      ) : <p className="muted">提交答案后，扩展会等待所选引擎完成批改，并自动把结果保存到这里。</p>}
      {projectUrl !== undefined ? <details className="conversation-binding">
        <summary><span>{conversationMode ? "本次练习对话" : "批改 Project"}</span><strong>{conversationUrl ? "已绑定" : recoverConversation ? "待恢复" : projectUrl ? "已配置" : "待配置"}</strong></summary>
        <div className="conversation-binding__body">
          <input type="url" value={bindingUrl} onChange={(event) => setBindingUrl(event.target.value)} placeholder={conversationMode ? "https://chatgpt.com/c/..." : "https://chatgpt.com/g/g-p-.../project"} aria-label={conversationMode ? "ChatGPT 对话 URL" : "ChatGPT Project URL"} />
          <button className="button button--quiet" type="button" disabled={rebindBusy || !bindingUrl.trim()} onClick={() => void (conversationMode ? onRebind(bindingUrl.trim()) : onSaveProjectUrl(bindingUrl.trim())).catch(() => undefined)}>{rebindBusy ? "处理中…" : conversationMode ? "重新绑定对话" : "保存 Project"}</button>
          {targetUrl ? <button className="text-button" type="button" onClick={() => onOpenConversation(targetUrl)}>{conversationMode ? "打开当前对话" : "打开批改 Project"}</button> : null}
        </div>
      </details> : null}
      <details className="feedback-manual">
        <summary>手动补录批改结果</summary>
        <div className="feedback-paste">
          {scope === "question" && !questionFeedbackAllowed ? <p className="muted">请先提交本题或整卷，再保存本题批改结果。</p> : null}
          <textarea ref={pasteFieldRef} id="feedback-input" rows={5} value={rawText} onChange={(event) => setRawText(event.target.value)} placeholder="自动读取失败时，可在此粘贴批改结果…" />
          <div className="feedback-paste__actions">
            <button className="button button--quiet" type="button" onClick={focusPasteField}>定位输入框</button>
            <button className="button button--secondary" type="button" disabled={feedbackBusy || !rawText.trim() || (scope === "question" && !questionFeedbackAllowed)} onClick={() => void save()}>{feedbackBusy ? "保存中…" : "保存批改结果"}</button>
          </div>
        </div>
      </details>
    </section>
  );
}

export function PracticePage(props: PracticePageProps): JSX.Element {
  const { bundle, activeQuestionId, settings, clock, saveState, busyAction } = props;
  const question = bundle?.questions.find((item) => item.questionId === activeQuestionId) ?? null;
  const feedback = useMemo(() => {
    if (!bundle || !question) return { question: [], paper: [] };
    const newestFirst = [...bundle.feedback].sort((left, right) => right.createdAt - left.createdAt);
    return {
      question: newestFirst.filter((record) => record.questionId === question.questionId),
      paper: newestFirst.filter((record) => record.questionId === null),
    };
  }, [bundle, question]);

  if (!bundle || !question || !activeQuestionId) return <EmptyPractice scanning={busyAction === "scan"} onScan={props.onScan} />;

  const count = countShenlunCharacters(question.userAnswer);
  const elapsed = clock.questionElapsedSeconds[question.questionId] ?? question.elapsedSeconds;
  const attemptSubmitted = bundle.attempt.status === "submitted";
  const questionSubmitted = question.status === "submitted" || question.status === "graded";
  const pendingForAttempt = props.pendingSubmission?.attemptId === bundle.attempt.attemptId
    ? props.pendingSubmission
    : null;
  const questionLockedByPending = Boolean(
    pendingForAttempt &&
    (pendingForAttempt.mode === "full-paper" || pendingForAttempt.questionId === question.questionId),
  );
  const submissionBlocked = props.pendingSubmission !== null;
  const questionFrozen = !attemptSubmitted && !questionSubmitted && !clock.paused && !clock.currentQuestionRunning;
  const showResume = clock.paused || questionFrozen;
  return (
    <main className="practice-page page">
      <PaperSummary bundle={bundle} clock={clock} settings={settings} />
      <QuestionNavigation questions={bundle.questions} activeQuestionId={activeQuestionId} disabled={busyAction !== null || pendingForAttempt !== null} onSelect={props.onSelectQuestion} />

      {props.pendingSubmission ? (
        <section className={`pending-submission pending-submission--${props.pendingSubmission.state}`} role="status" aria-live="polite">
          <div>
            <span className="eyebrow">发送状态保护</span>
            <h3>{props.pendingSubmission.state === "preparing" ? "正在交接 Prompt" : props.pendingSubmission.state === "uncertain" ? "请先核对批改页面" : "Prompt 等待手动发送"}</h3>
            <p>
              {!pendingForAttempt
                ? "另一份练习仍有待确认的 Prompt。请从历史记录恢复该练习后处理，当前提交已暂时锁定。"
                : props.pendingSubmission.state === "preparing"
                  ? "另一个 Side Panel 可能正在保存并调用批改引擎。完成前不会开放确认或取消操作。"
                  : props.pendingSubmission.state === "uncertain"
                  ? "扩展没有收到可靠的发送回执。为避免重复发送，相关答案和计时保持锁定。"
                  : `${props.pendingSubmission.mode === "single-question" ? "本题" : "整卷"}答案已锁定，避免批改引擎中的 Prompt 与本地记录不一致。`}
            </p>
          </div>
          {pendingForAttempt && props.pendingSubmission.state === "preparing" && props.preparingRecoveryAvailable ? (
            <div className="pending-submission__actions">
              <button className="button button--secondary" type="button" disabled={busyAction !== null} onClick={props.onRecoverPreparingSubmission}>
                检查并恢复交接
              </button>
            </div>
          ) : pendingForAttempt && props.pendingSubmission.state !== "preparing" && props.pendingOwnedByThisPanel ? (
            <div className="pending-submission__actions">
              <button className="button button--secondary" type="button" disabled={busyAction !== null} onClick={() => props.onResolvePendingSubmission(true)}>
                {busyAction === "resolve" ? "处理中…" : "我确认已发送"}
              </button>
              <button className="button button--quiet" type="button" disabled={busyAction !== null} onClick={() => props.onResolvePendingSubmission(false)}>
                {props.pendingSubmission.state === "manual" ? "取消待发送" : "确认未发送"}
              </button>
            </div>
          ) : pendingForAttempt && props.pendingSubmission.state !== "preparing" ? (
            <div className="pending-submission__actions">
              <button className="button button--secondary" type="button" disabled={busyAction !== null} onClick={props.onTakeOverPendingSubmission}>
                在此面板接管处理
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="card answer-card" aria-labelledby="answer-heading">
        <div className="section-heading"><div><span className="eyebrow">独立草稿</span><h3 id="answer-heading">我的作答</h3></div><span className={`save-indicator save-indicator--${saveState}`}>{saveState === "saving" ? "正在保存…" : saveState === "saved" ? "已自动保存" : saveState === "error" ? "保存失败" : settings.autoSave ? "自动保存已开启" : "自动保存已关闭"}</span></div>
        <textarea className="answer-input" value={question.userAnswer} disabled={busyAction !== null || attemptSubmitted || questionSubmitted || questionLockedByPending} onChange={(event) => props.onAnswerChange(event.target.value)} placeholder="在这里开始作答…" aria-label={`第 ${question.index + 1} 题作答`} spellCheck />
        <div className="answer-metrics">
          {settings.showWordCount ? <strong className="tabular">{question.wordLimit === null ? `${count} 字` : `${count} / ${question.wordLimit} 字`}</strong> : <span />}
          {settings.showQuestionTimer ? <span className="timer"><Icon name="clock" /><span className="tabular">{formatShortElapsed(elapsed)}</span></span> : null}
        </div>
        <div className="grading-target" aria-label="批改引擎设置">
          <label><span>批改引擎</span><select value={settings.gradingEngine} disabled={busyAction !== null || submissionBlocked} onChange={(event) => {
            const engine = event.target.value as GradingEngineId;
            props.onGradingTargetChange({ engine, model: defaultModelForEngine(engine) });
          }}>{GRADING_ENGINES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
          <label><span>具体模型</span><select value={settings.gradingModel} disabled={busyAction !== null || submissionBlocked} onChange={(event) => props.onGradingTargetChange({ engine: settings.gradingEngine, model: event.target.value as GradingModelId })}>{modelsForEngine(settings.gradingEngine).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
        </div>
        <div className="answer-actions">
          <button className="button button--quiet" type="button" disabled={busyAction !== null || attemptSubmitted || questionLockedByPending} onClick={props.onPauseToggle}><Icon name={showResume ? "play" : "pause"} />{showResume ? "继续" : "暂停"}</button>
          <button className="button button--quiet" type="button" disabled={busyAction !== null || attemptSubmitted || questionSubmitted || questionLockedByPending} onClick={props.onSave}>保存草稿</button>
          <button className="button button--quiet button--danger-text" type="button" disabled={busyAction !== null || attemptSubmitted || questionSubmitted || questionLockedByPending || !question.userAnswer} onClick={props.onClear}>清空</button>
          <button className="button button--primary answer-actions__submit" type="button" disabled={busyAction !== null || submissionBlocked || !question.userAnswer.trim()} onClick={props.onSubmitQuestion}><Icon name="sparkles" />{busyAction === "single" ? "正在批改…" : questionSubmitted ? "再次提交批改" : submissionBlocked ? "等待批改完成" : "提交本题"}</button>
        </div>
      </section>

      <FeedbackPanel key={`${bundle.attempt.attemptId}:${question.questionId}`} questionFeedback={feedback.question} paperFeedback={feedback.paper} projectUrl={settings.gradingEngine === "chatgpt-web" ? settings.projectUrl : undefined} conversationUrl={settings.gradingEngine === "chatgpt-web" ? bundle.conversation?.conversationUrl : undefined} recoverConversation={pendingForAttempt?.state === "uncertain"} feedbackBusy={busyAction === "feedback" || pendingForAttempt !== null} rebindBusy={busyAction !== null || (pendingForAttempt !== null && pendingForAttempt.state !== "uncertain")} questionFeedbackAllowed={attemptSubmitted || question.submittedAt !== null} onSave={props.onSaveFeedback} onSaveProjectUrl={props.onSaveProjectUrl} onRebind={props.onRebindConversation} onOpenConversation={props.onOpenConversation} />

      <section className="full-submit">
        <div><h3>完成整套试卷</h3><p>使用当前选择的批改引擎处理全部题目，获得逐题分析和整卷总结。</p></div>
        <button className="button button--accent button--large" type="button" disabled={busyAction !== null || submissionBlocked || attemptSubmitted || bundle.questions.length === 0 || !bundle.questions.every((item) => item.userAnswer.trim())} onClick={props.onSubmitFull}><Icon name="sparkles" />{busyAction === "full" ? "正在提交整卷…" : attemptSubmitted ? "整卷已提交" : submissionBlocked ? "等待发送确认" : "全部提交批改"}</button>
      </section>
    </main>
  );
}
