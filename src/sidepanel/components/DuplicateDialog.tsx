import type { PaperDefinition, PracticeHistoryItem } from "../../types";
import { formatDate, formatElapsed } from "../utils";

interface DuplicateDialogProps {
  paper: PaperDefinition | null;
  attempts: readonly PracticeHistoryItem[];
  busy: boolean;
  onContinue: (attemptId: string) => void;
  onCreate: () => void;
  onCancel: () => void;
}

export function DuplicateDialog({ paper, attempts, busy, onContinue, onCreate, onCancel }: DuplicateDialogProps): JSX.Element | null {
  if (!paper) return null;
  const latest = attempts[0];
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="duplicate-title" aria-describedby="duplicate-description">
        <span className="eyebrow">重复试卷</span>
        <h2 id="duplicate-title">检测到已有练习记录</h2>
        <p id="duplicate-description">“{paper.paperName}”曾经练习过。继续会恢复原答案、计时、对话与批改结果；新建练习将使用独立上下文。</p>
        <div className="duplicate-options">
          {latest ? (
            <button className="duplicate-option" type="button" disabled={busy} onClick={() => onContinue(latest.attempt.attemptId)}>
              <strong>继续上次练习</strong>
              <span>{formatDate(latest.attempt.createdAt)} · 完成 {latest.completedQuestionCount}/{latest.totalQuestionCount} · {formatElapsed(latest.attempt.totalElapsedSeconds)}</span>
              <em>›</em>
            </button>
          ) : null}
          <button className="duplicate-option" type="button" disabled={busy} onClick={onCreate}>
            <strong>创建新的练习</strong>
            <span>生成新的 attemptId 和独立批改记录</span>
            <em>＋</em>
          </button>
        </div>
        <button className="button button--quiet dialog__cancel" type="button" disabled={busy} onClick={onCancel}>暂不练习</button>
      </section>
    </div>
  );
}
