import {
  PERSISTED_ENTITY_VERSION,
  type AttemptId,
  type ConversationBinding,
  type ConversationClaim,
} from "../types";
import {
  STORE_NAMES,
  getDefaultDatabase,
  requestToPromise,
  transactionToPromise,
  type DatabaseProvider,
} from "./indexedDB";

function validateHttpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Conversation URL must use HTTP or HTTPS");
  }
  return url.toString();
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

export class ConversationBindingRepository {
  public constructor(private readonly databaseProvider: DatabaseProvider = getDefaultDatabase) {}

  public async getByAttempt(attemptId: AttemptId): Promise<ConversationBinding | null> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(STORE_NAMES.conversationBindings, "readonly");
    const value = await requestToPromise(
      transaction.objectStore(STORE_NAMES.conversationBindings).get(attemptId),
    );
    const binding = (value as ConversationBinding | undefined) ?? null;
    if (binding && binding.attemptId !== attemptId) {
      throw new Error("IndexedDB returned a binding from another attempt");
    }
    return binding;
  }

  /** Saves a new binding or updates metadata without silently changing its conversation. */
  public async save(binding: ConversationBinding): Promise<void> {
    const normalizedBinding: ConversationBinding =
      binding.conversationUrl === undefined
        ? binding
        : { ...binding, conversationUrl: validateHttpUrl(binding.conversationUrl) };
    const database = await this.databaseProvider();
    const transaction = database.transaction(
      [
        STORE_NAMES.conversationBindings,
        STORE_NAMES.conversationClaims,
        STORE_NAMES.attempts,
      ],
      "readwrite",
    );
    const completed = transactionToPromise(transaction);
    const store = transaction.objectStore(STORE_NAMES.conversationBindings);
    const claimStore = transaction.objectStore(STORE_NAMES.conversationClaims);
    const ownerRequest = normalizedBinding.conversationUrl
      ? store.index("conversationUrl").get(normalizedBinding.conversationUrl)
      : null;
    const claimRequest = normalizedBinding.conversationUrl
      ? claimStore.get(normalizedBinding.conversationUrl)
      : null;
    const [currentValue, attemptValue, ownerValue, claimValue] = await Promise.all([
      requestToPromise(store.get(normalizedBinding.attemptId)),
      requestToPromise(
        transaction.objectStore(STORE_NAMES.attempts).get(normalizedBinding.attemptId),
      ),
      ownerRequest ? requestToPromise(ownerRequest) : Promise.resolve(undefined),
      claimRequest ? requestToPromise(claimRequest) : Promise.resolve(undefined),
    ]);
    const current = currentValue as ConversationBinding | undefined;
    const attempt = attemptValue as { readonly paperId?: string } | undefined;
    const owner = ownerValue as ConversationBinding | undefined;
    const claim = claimValue as ConversationClaim | undefined;
    if (!attempt || attempt.paperId !== normalizedBinding.paperId) {
      transaction.abort();
      await completed.catch(() => undefined);
      throw new Error("ConversationBinding does not belong to the supplied PaperAttempt");
    }
    if (owner && owner.attemptId !== normalizedBinding.attemptId) {
      transaction.abort();
      await completed.catch(() => undefined);
      throw new Error("Conversation URL is already bound to another attempt");
    }
    if (
      claim &&
      (claim.attemptId !== normalizedBinding.attemptId ||
        claim.paperId !== normalizedBinding.paperId)
    ) {
      transaction.abort();
      await completed.catch(() => undefined);
      throw new Error("Conversation URL was previously claimed by another attempt");
    }
    if (current?.paperId && current.paperId !== normalizedBinding.paperId) {
      transaction.abort();
      await completed.catch(() => undefined);
      throw new Error("An attempt cannot be rebound to a different paper");
    }
    if (
      current?.conversationUrl &&
      normalizedBinding.conversationUrl &&
      current.conversationUrl !== normalizedBinding.conversationUrl
    ) {
      transaction.abort();
      await completed.catch(() => undefined);
      throw new Error("Use rebindConversationUrl to explicitly replace a conversation URL");
    }
    if (normalizedBinding.conversationUrl && !claim) {
      claimStore.add({
        schemaVersion: PERSISTED_ENTITY_VERSION,
        conversationUrl: normalizedBinding.conversationUrl,
        attemptId: normalizedBinding.attemptId,
        paperId: normalizedBinding.paperId,
        claimedAt: normalizedBinding.createdAt,
      } satisfies ConversationClaim);
    }
    const bindingToStore: ConversationBinding =
      current?.conversationUrl && !normalizedBinding.conversationUrl
        ? { ...normalizedBinding, conversationUrl: current.conversationUrl }
        : normalizedBinding;
    store.put(bindingToStore);
    try {
      await completed;
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        (error as { readonly name?: unknown }).name === "ConstraintError"
      ) {
        throw new Error("Conversation URL is already bound to another attempt");
      }
      throw error;
    }
  }

  /** Explicit recovery path for the “重新绑定对话” action. */
  public async rebindConversationUrl(
    attemptId: AttemptId,
    conversationUrl: string,
    now: number = Date.now(),
  ): Promise<ConversationBinding> {
    const normalizedUrl = validateHttpUrl(conversationUrl);
    const database = await this.databaseProvider();
    const transaction = database.transaction(
      [STORE_NAMES.conversationBindings, STORE_NAMES.conversationClaims],
      "readwrite",
    );
    const completed = transactionToPromise(transaction);
    const store = transaction.objectStore(STORE_NAMES.conversationBindings);
    const claimStore = transaction.objectStore(STORE_NAMES.conversationClaims);
    const [currentValue, ownerValue, claimValue] = await Promise.all([
      requestToPromise(store.get(attemptId)),
      requestToPromise(store.index("conversationUrl").get(normalizedUrl)),
      requestToPromise(claimStore.get(normalizedUrl)),
    ]);
    const current = currentValue as ConversationBinding | undefined;
    const owner = ownerValue as ConversationBinding | undefined;
    const claim = claimValue as ConversationClaim | undefined;
    if (!current) {
      transaction.abort();
      await completed.catch(() => undefined);
      throw new Error("Conversation binding was not found for this attemptId");
    }
    if (owner && owner.attemptId !== attemptId) {
      transaction.abort();
      await completed.catch(() => undefined);
      throw new Error("Conversation URL is already bound to another attempt");
    }
    if (claim && (claim.attemptId !== attemptId || claim.paperId !== current.paperId)) {
      transaction.abort();
      await completed.catch(() => undefined);
      throw new Error("Conversation URL was previously claimed by another attempt");
    }
    const updated: ConversationBinding = {
      ...current,
      conversationUrl: normalizedUrl,
      lastUsedAt: now,
    };
    if (!claim) {
      claimStore.add({
        schemaVersion: PERSISTED_ENTITY_VERSION,
        conversationUrl: normalizedUrl,
        attemptId,
        paperId: current.paperId,
        claimedAt: now,
      } satisfies ConversationClaim);
    }
    store.put(updated);
    try {
      await completed;
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        (error as { readonly name?: unknown }).name === "ConstraintError"
      ) {
        throw new Error("Conversation URL is already bound to another attempt");
      }
      throw error;
    }
    return updated;
  }

  public async updateConversationUrl(
    attemptId: AttemptId,
    conversationUrl: string,
    now: number = Date.now(),
  ): Promise<ConversationBinding> {
    return this.rebindConversationUrl(attemptId, conversationUrl, now);
  }

  /**
   * Atomically refreshes Project metadata only while the binding is pending.
   * A concurrently observed conversation URL always wins and is never erased.
   * Returns null only when the attempt has no binding; an already-bound record
   * is returned unchanged.
   */
  public async updatePendingProject(
    attemptId: AttemptId,
    projectName: string,
    projectUrl?: string,
    now: number = Date.now(),
  ): Promise<ConversationBinding | null> {
    const normalizedProjectName = projectName.trim();
    if (normalizedProjectName.length === 0) {
      throw new Error("Project name must not be empty");
    }
    const trimmedProjectUrl = projectUrl?.trim() ?? "";
    const normalizedProjectUrl =
      trimmedProjectUrl.length === 0 ? null : validateHttpUrl(trimmedProjectUrl);

    const database = await this.databaseProvider();
    const transaction = database.transaction(STORE_NAMES.conversationBindings, "readwrite");
    const completed = transactionToPromise(transaction);
    const store = transaction.objectStore(STORE_NAMES.conversationBindings);
    const current = (await requestToPromise(store.get(attemptId))) as
      | ConversationBinding
      | undefined;

    if (!current) {
      await completed;
      return null;
    }
    if (current.conversationUrl?.trim()) {
      await completed;
      return current;
    }

    const updated: Mutable<ConversationBinding> = {
      ...current,
      projectName: normalizedProjectName,
      lastUsedAt: now,
    };
    delete updated.conversationUrl;
    if (normalizedProjectUrl === null) {
      delete updated.projectUrl;
    } else {
      updated.projectUrl = normalizedProjectUrl;
    }
    store.put(updated);
    await completed;
    return updated;
  }

  public async touch(attemptId: AttemptId, now: number = Date.now()): Promise<void> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(STORE_NAMES.conversationBindings, "readwrite");
    const completed = transactionToPromise(transaction);
    const store = transaction.objectStore(STORE_NAMES.conversationBindings);
    const current = (await requestToPromise(store.get(attemptId))) as
      | ConversationBinding
      | undefined;
    if (!current) {
      transaction.abort();
      await completed.catch(() => undefined);
      throw new Error("Conversation binding was not found for this attemptId");
    }
    store.put({ ...current, lastUsedAt: now } satisfies ConversationBinding);
    await completed;
  }
}

export const conversationBindingRepository = new ConversationBindingRepository();
