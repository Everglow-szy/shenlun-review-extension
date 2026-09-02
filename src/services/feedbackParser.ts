export interface FeedbackModule {
  readonly title: string;
  readonly content: string;
}

const MODULE_TITLE_PATTERN = /^(?:#{1,6}\s+|\*\*|__)?\s*(?:\d+[.、：:]\s*)?([^\n*_]+?)(?:\*\*|__)?\s*$/u;
const KNOWN_MODULES = [
  "得分",
  "得分点分析",
  "修改建议",
  "推荐作答结构",
  "逐题批改",
  "整卷总评",
  "后续训练建议",
] as const;

function moduleTitle(line: string): string | null {
  const trimmed = line.trim();
  const match = MODULE_TITLE_PATTERN.exec(trimmed);
  if (!match?.[1]) return null;
  const candidate = match[1].replace(/[：:]$/u, "").trim();
  const known = KNOWN_MODULES.find(
    (title) => candidate === title || candidate.startsWith(`${title}（`) || candidate.startsWith(`${title} (`),
  );
  return known ?? null;
}

export function parseFeedbackScore(rawText: string): { score?: number; maxScore?: number } {
  const match = rawText.match(/(?:得分[^\d]*)?(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/u);
  if (!match?.[1] || !match[2]) return {};
  const score = Number(match[1]);
  const maxScore = Number(match[2]);
  return Number.isFinite(score) && Number.isFinite(maxScore) ? { score, maxScore } : {};
}

export function parseFeedbackModules(rawText: string): readonly FeedbackModule[] {
  const normalized = rawText.replace(/\r\n?/gu, "\n").trim();
  if (!normalized) return [];

  const modules: FeedbackModule[] = [];
  let title: string | null = null;
  let content: string[] = [];
  const flush = (): void => {
    if (!title) return;
    modules.push({ title, content: content.join("\n").trim() });
  };

  for (const line of normalized.split("\n")) {
    const nextTitle = moduleTitle(line);
    if (nextTitle) {
      if (title) {
        flush();
      } else {
        const preamble = content.join("\n").trim();
        if (preamble) modules.push({ title: "补充说明", content: preamble });
      }
      title = nextTitle;
      content = [];
    } else {
      content.push(line);
    }
  }
  if (title) flush();

  return modules.length > 0
    ? modules
    : [{ title: "批改详情", content: normalized }];
}
