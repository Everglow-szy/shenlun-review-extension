import type { AttemptBundle } from "../../types";
import { Icon } from "../components/Icon";
import { formatDate, formatElapsed } from "../utils";

interface HistoryPageProps {
  items: readonly AttemptBundle[];
  loading: boolean;
  onRefresh: () => void;
  onRestore: (attemptId: string) => void;
}

function completedCount(bundle: AttemptBundle): number {
  return bundle.questions.filter((question) => question.userAnswer.trim() || ["answered", "submitted", "graded"].includes(question.status)).length;
}

export function HistoryPage({ items, loading, onRefresh, onRestore }: HistoryPageProps): JSX.Element {
  const groups = items.reduce<Map<string, AttemptBundle[]>>((result, bundle) => {
    const date = formatDate(bundle.attempt.createdAt);
    result.set(date, [...(result.get(date) ?? []), bundle]);
    return result;
  }, new Map());

  return (
    <main className="page history-page">
      <div className="page-heading">
        <div><span className="eyebrow">保存在本机</span><h2>历史练习</h2><p>继续未完成的作答，或查看已保存的多引擎批改结果。</p></div>
        <button className="button button--quiet" type="button" disabled={loading} onClick={onRefresh}>{loading ? "刷新中…" : "刷新"}</button>
      </div>
      {items.length ? (
        <div className="history-groups">
          {[...groups.entries()].map(([date, bundles]) => (
            <section key={date} className="history-group" aria-labelledby={`history-${date}`}>
              <h3 id={`history-${date}`}>{date}</h3>
              <div className="history-list">
                {bundles.map((bundle) => {
                  const complete = completedCount(bundle);
                  return (
                    <button className="history-item" type="button" key={bundle.attempt.attemptId} disabled={loading} onClick={() => onRestore(bundle.attempt.attemptId)}>
                      <span className="history-item__icon"><Icon name="book" /></span>
                      <span className="history-item__body">
                        <strong>{bundle.paper.paperName}</strong>
                        <span>第 {bundle.attempt.attemptNumber} 次练习 · 完成 {complete}/{bundle.questions.length}</span>
                        <span className="history-item__tags">{bundle.conversation?.conversationUrl ? "已绑定对话" : "未绑定对话"}{bundle.feedback.length ? ` · ${bundle.feedback.length} 条批改` : ""}</span>
                      </span>
                      <span className="history-item__time"><Icon name="clock" />{formatElapsed(bundle.attempt.totalElapsedSeconds)}</span>
                      <span className="history-item__arrow">›</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="empty-state empty-state--compact">
          <div className="empty-state__art"><Icon name="history" /></div>
          <h3>{loading ? "正在读取历史记录…" : "还没有练习记录"}</h3>
          <p>扫描一套试卷并开始作答后，记录会自动出现在这里。</p>
        </div>
      )}
    </main>
  );
}
