import type { ExtractedPaperPayload } from "../types";
import type { PaperExtractingExamAdapter } from "./ExamAdapter";
import { ExamAdapterError } from "./ExamAdapter";
import { ExamSiteAdapter } from "./ExamSiteAdapter";
import { FenbiShenlunAdapter } from "./FenbiShenlunAdapter";

export type ExamAdapterFactory = (page: Document) => PaperExtractingExamAdapter;

const adapterFactories: ExamAdapterFactory[] = [
  (page) => new FenbiShenlunAdapter(page),
  (page) => new ExamSiteAdapter(page),
];

/** Site adapters are inserted before the generic fallback. */
export function registerExamAdapter(factory: ExamAdapterFactory): void {
  adapterFactories.unshift(factory);
}

export function resolveExamAdapter(page: Document = document): PaperExtractingExamAdapter {
  for (const factory of adapterFactories) {
    const adapter = factory(page);
    if (adapter.canHandle(page.location.href)) return adapter;
  }
  throw new ExamAdapterError(
    "EXAM_UNSUPPORTED_PAGE",
    "当前页面不是可识别的申论试卷页面。",
    false,
  );
}

export async function extractCurrentPaper(page: Document = document): Promise<ExtractedPaperPayload> {
  return resolveExamAdapter(page).extractPaper();
}
