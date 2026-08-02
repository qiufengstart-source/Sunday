const RATIO_SIZES_1K = Object.freeze({
  "1:1": "1024*1024",
  "2:3": "832*1248",
  "3:4": "896*1152",
  "4:3": "1152*896",
  "16:9": "1344*768",
  "9:16": "768*1344",
});

const RATIO_SIZES_2K = Object.freeze({
  "1:1": "2048*2048",
  "2:3": "1664*2496",
  "3:4": "1792*2304",
  "4:3": "2304*1792",
  "16:9": "2688*1536",
  "9:16": "1536*2688",
});

const GENERATED_IMAGE_ROUTE_PATTERN =
  /^\/generated\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/;
const UPLOADED_IMAGE_ROUTE_PATTERN =
  /^\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|webp)$/;

export function normalizeCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 1 && count <= 4 ? count : 1;
}

export function normalizeResolution(value) {
  return value === "2K" ? "2K" : "1K";
}

export function normalizeRatio(value) {
  const ratio = String(value || "").trim();
  if (RATIO_SIZES_1K[ratio]) return ratio;
  return "9:16";
}

const CN_COUNT = Object.freeze({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4 });

/** 从对话文本推断期望张数（1–4）；无法识别时返回 null。 */
export function inferImageCountFromText(text) {
  const raw = String(text || "");
  const patterns = [
    /(?:生成|输出|给我|需要|要|来)\s*(\d)\s*张/,
    /(?:生成|输出|给我|需要|要|来)\s*(一|二|两|三|四)\s*张/,
    /(\d)\s*张(?:图|图片|效果图|候选)?/,
    /(一|二|两|三|四)\s*张(?:图|图片|效果图|候选)?/,
    /(\d)\s*个(?:不同)?(?:的)?(?:姿势|动作|角度|造型|版本|候选|构图)/,
    /(一|二|两|三|四)\s*个(?:不同)?(?:的)?(?:姿势|动作|角度|造型|版本|候选|构图)/,
    /(\d)\s*(?:different\s+)?(?:poses?|variants?|images?|shots?)/i,
  ];
  for (const re of patterns) {
    const match = raw.match(re);
    if (!match) continue;
    const token = match[1];
    const n = CN_COUNT[token] ?? Number(token);
    if (Number.isInteger(n) && n >= 1 && n <= 4) return n;
  }
  return null;
}

/** 快捷参数数量与对话意图取较大值，避免「说要 3 张却仍按 n=1 出拼图」。 */
export function resolveOutputCount({ selectedCount, text }) {
  const selected = normalizeCount(selectedCount);
  const inferred = inferImageCountFromText(text);
  return inferred ? Math.max(selected, inferred) : selected;
}

export function multiImageOutputRule(count) {
  const n = normalizeCount(count);
  if (n <= 1) return "";
  return `多图输出要求：请生成 ${n} 张彼此独立的图片（共 ${n} 个文件），每张只呈现一个姿势/构图；禁止把多个姿势拼进同一张图，禁止四宫格/九宫格/拼贴。`;
}

/**
 * 有参考图：用 1K/2K 档位（宽高比跟输入图）。
 * 纯文生图：按比例映射到对应分辨率像素；无比例时退回档位（正方形）。
 */
export function chooseOutputSize({ ratio, resolution, hasReference }) {
  const res = normalizeResolution(resolution);
  if (hasReference) return res;
  const table = res === "2K" ? RATIO_SIZES_2K : RATIO_SIZES_1K;
  const normalizedRatio = String(ratio || "").trim();
  return table[normalizedRatio] || res;
}

export function buildGenerateRequest({
  prompt,
  sourceImage,
  referenceImage,
  count,
  ratio,
  resolution,
  /** 引用修改时为 true：只传引用图，避免与原图双图输入导致外观被原图覆盖 */
  referenceOnly = false,
}) {
  const images = (
    referenceOnly && referenceImage
      ? [referenceImage]
      : [sourceImage, referenceImage]
  ).filter((image, index, values) => image && values.indexOf(image) === index);
  const normalizedCount = normalizeCount(count);
  return {
    prompt,
    images,
    count: normalizedCount,
    size: chooseOutputSize({
      ratio: normalizeRatio(ratio),
      resolution,
      hasReference: images.length > 0,
    }),
    // count>1 时走万相组图，返回多张独立图而非一张拼图
    sequential: normalizedCount > 1,
  };
}

export function isGeneratedImageRoute(value) {
  if (typeof value !== "string") return false;
  const match = GENERATED_IMAGE_ROUTE_PATTERN.exec(value);
  return match?.[0] === value;
}

export function isLocalImageRoute(value) {
  if (isGeneratedImageRoute(value)) return true;
  if (typeof value !== "string") return false;
  const match = UPLOADED_IMAGE_ROUTE_PATTERN.exec(value);
  return match?.[0] === value;
}

export function cloneGenerateRequest(request) {
  return {
    prompt: request.prompt,
    images: [...request.images],
    count: request.count,
    size: request.size,
    sequential: !!request.sequential,
  };
}

export function isSameGenerateRequest(a, b) {
  if (!a || !b) return false;
  const imagesA = Array.isArray(a.images) ? a.images : [];
  const imagesB = Array.isArray(b.images) ? b.images : [];
  return (
    a.prompt === b.prompt &&
    a.count === b.count &&
    a.size === b.size &&
    !!a.sequential === !!b.sequential &&
    imagesA.length === imagesB.length &&
    imagesA.every((image, index) => image === imagesB[index])
  );
}

/** 比较两轮生成包：合成提示词 + 请求参数是否完全一致。 */
export function isSameGenerationPackage(prev, next) {
  if (!prev || !next) return false;
  return (
    prev.promptSnapshot === next.promptSnapshot &&
    isSameGenerateRequest(prev.request, next.request)
  );
}

export function cloneGenerationInput(input) {
  return {
    mode: input.mode,
    note: input.note,
    ref: input.ref ? { ...input.ref } : null,
    request: cloneGenerateRequest(input.request),
    promptSnapshot: input.promptSnapshot,
    sourceInputIndex: input.sourceInputIndex,
    userMessageId: input.userMessageId,
  };
}

/** 某版本当前「结果」草稿：优先选中项，否则首张。 */
export function resolveVersionTipDraft(version, selectedDraftId = null) {
  if (!version?.drafts?.length) return null;
  if (selectedDraftId) {
    const selected = version.drafts.find((draft) => draft.id === selectedDraftId);
    if (selected) return selected;
  }
  return version.drafts[0];
}

/**
 * 引用的是该版本最新一张（当前 tip）时，应继续挂在同一版本链路，不新建版本。
 * @returns {object|null} 可续写的版本；否则 null
 */
export function findVersionToContinue({
  versions = [],
  ref = null,
  currentVersionId = null,
  selectedDraftId = null,
} = {}) {
  if (!ref?.versionId || !ref?.draftId) return null;
  const version = versions.find((item) => item.id === ref.versionId);
  if (!version?.drafts?.length) return null;
  // 当前版本 tip = 选中草稿；其他版本 tip = 该版本结果首张（续写后唯一/最新结果）
  const tip =
    currentVersionId === version.id
      ? resolveVersionTipDraft(version, selectedDraftId)
      : resolveVersionTipDraft(version, null);
  // 只认 draftId：生成后会本地化图片路径，ref.image 与 tip.image 常不一致，不能据此拒绝续写
  if (!tip || tip.id !== ref.draftId) return null;
  return version;
}

/** 按图片从对话消息找回原始 draftId（repair 可能把 steps 改成 lineage-*） */
export function findMessageDraftIdByImage(messages = [], versionId = null, image = null) {
  if (!image || !versionId) return null;
  for (const msg of messages) {
    if (msg?.role !== "ai" || msg.versionId !== versionId) continue;
    const hit =
      (Array.isArray(msg.drafts) && msg.drafts.find((draft) => draft?.image === image)) || null;
    if (hit?.id) return hit.id;
    if (msg.draftId && (msg.image === image || msg.drafts?.[0]?.image === image)) {
      return msg.draftId;
    }
  }
  return null;
}

/**
 * 解析「引用修改」目标：只认点击的 draftId / 图，绝不回落到 tip。
 * 续写后 steps 可能被改成 lineage-*，消息仍带原始 draftId + 图。
 */
export function resolveQuoteTargetDraft(
  version,
  { draftId = null, imageHint = null, label = null } = {},
) {
  if (!version) return null;
  if (draftId) {
    const byId =
      version.drafts?.find((draft) => draft.id === draftId) ||
      version.steps?.find((step) => step.id === draftId) ||
      (version.branchRoot?.id === draftId ? version.branchRoot : null) ||
      null;
    if (byId?.image) {
      return {
        id: byId.id,
        image: byId.image,
        label: byId.label || label || null,
      };
    }
  }
  if (imageHint) {
    const byImage =
      version.drafts?.find((draft) => draft.image === imageHint) ||
      version.steps?.find((step) => step.image === imageHint) ||
      (version.branchRoot?.image === imageHint ? version.branchRoot : null) ||
      null;
    if (byImage?.image) {
      return {
        // 优先保留消息上的原始 draftId，避免被 lineage-* 污染后续续写判断
        id: draftId || byImage.id,
        image: byImage.image,
        label: byImage.label || label || null,
      };
    }
    if (draftId) {
      return { id: draftId, image: imageHint, label: label || null };
    }
  }
  return null;
}

/**
 * 画布「引用修改」：优先引用 lineageFocus（历史步/原图），否则当前 tip。
 */
export function resolveCanvasQuoteTarget({
  version = null,
  selectedDraftId = null,
  lineageFocus = null,
  sourceImage = null,
} = {}) {
  if (lineageFocus?.kind === "source") {
    const image = lineageFocus.image || sourceImage;
    if (!image) return null;
    return {
      kind: "source",
      label: "原图",
      image,
      versionId: null,
      draftId: null,
    };
  }
  if (lineageFocus?.kind === "ancestor" && lineageFocus.image && version) {
    const draft = resolveQuoteTargetDraft(version, {
      draftId: lineageFocus.draftId,
      imageHint: lineageFocus.image,
    });
    if (!draft?.image) return null;
    return {
      kind: "draft",
      label: `${version.name} · ${draft.label || "历史步骤"}`,
      image: draft.image,
      versionId: version.id,
      draftId: draft.id,
    };
  }
  if (!version?.drafts?.length) return null;
  const tip = resolveVersionTipDraft(version, selectedDraftId);
  if (!tip?.image) return null;
  return {
    kind: "draft",
    label: `${version.name} · ${tip.label || "图"}`,
    image: tip.image,
    versionId: version.id,
    draftId: tip.id,
  };
}

/** 同任务已有版本后重新上传图片：发送时应开新版本，而不是续写旧 tip */
export function shouldOpenNewVersionFromReupload({
  hasVersions = false,
  pendingDataUrl = null,
} = {}) {
  return !!(hasVersions && pendingDataUrl);
}

/** 粗粒度商品品类（用于同任务串品类时自动新建任务） */
export function inferProductCategory(text = "") {
  const t = String(text || "").toLowerCase();
  if (/鞋|sneaker|heel|高跟鞋|靴|拖鞋|sandal|跑鞋|运动鞋/.test(t)) return "shoes";
  if (/包|handbag|bag|托特|背包|wallet|钱包|手提包/.test(t)) return "bag";
  if (/衣|裙|裤|针织|开衫|服|dress|shirt|外套|毛衣|女装|男装|上衣/.test(t)) return "apparel";
  if (/项链|珍珠|耳环|手链|饰|jewelry|戒指|手镯/.test(t)) return "jewelry";
  if (/美妆|护肤|口红|化妆|cream|serum|香水/.test(t)) return "beauty";
  return null;
}

export function productCategoryLabel(category) {
  return (
    {
      shoes: "鞋履",
      bag: "箱包",
      apparel: "服饰",
      jewelry: "饰品",
      beauty: "美妆",
    }[category] || category || "未识别"
  );
}

/**
 * 已有生成结果后，用户描述切换到另一品类且未引用/重传时，应新开任务，避免被当成 adjust 串图。
 */
export function shouldOpenNewTaskForProductChange({
  hasVersions = false,
  previousCategory = null,
  nextCategory = null,
  hasQuote = false,
  hasPendingUpload = false,
} = {}) {
  if (!hasVersions || !previousCategory || !nextCategory) return false;
  if (previousCategory === nextCategory) return false;
  if (hasQuote || hasPendingUpload) return false;
  return true;
}

/** 品牌 / 商标 / 高风险营销表述（客户端拦截，需人工复核的强标识） */
export function isBrandOrTrademarkRisk(text = "") {
  return /违禁|色情|暴力|nike|耐克|swoosh|adidas|阿迪达斯|puma|彪马|gucci|chanel|herm[eè]s|爱马仕|louis\s*vuitton|\blv\b|supreme|医疗|处方药|医美|整形/.test(
    String(text || "").toLowerCase(),
  );
}

/** 文生/无原图时，去掉「以上传图片」类表述，避免模型误当成图生图 */
export function adaptPromptForTextOnly(content = "") {
  return String(content || "")
    .replace(/以上传图片商品为核心基底/g, "以用户描述的商品为核心主体")
    .replace(/以上传图片中的/g, "")
    .replace(/以上传图片/g, "用户描述");
}

/**
 * 重传覆盖 task.sourceImage 前，把旧原图冻进尚无 sourceImage 的历史版本。
 * @returns {number} 实际补写的版本数
 */
export function freezeMissingVersionSourceImages(versions = [], previousSourceImage = null) {
  if (!previousSourceImage || !Array.isArray(versions) || !versions.length) return 0;
  let frozen = 0;
  for (const version of versions) {
    if (!version || version.sourceImage) continue;
    version.sourceImage = previousSourceImage;
    frozen += 1;
  }
  return frozen;
}

/** 判断某图是否已被写成该版本的生成/引用节点（不能当原图） */
export function isVersionGeneratedOrBranchImage(version, image) {
  if (!version || !image) return false;
  if (version.branchRoot?.image && version.branchRoot.image === image) return true;
  if ((version.drafts || []).some((draft) => draft?.image === image)) return true;
  if ((version.steps || []).some((step) => step?.image === image)) return true;
  return false;
}

/**
 * 版本链路原图：优先版本自带 sourceImage，避免重传后冲掉旧版本起点。
 * 若历史数据误把引用图/生成图写入 sourceImage，回退到任务原图。
 */
export function resolveVersionSourceImage(version, taskSourceImage = null) {
  const candidate = version?.sourceImage || null;
  if (candidate && !isVersionGeneratedOrBranchImage(version, candidate)) {
    return candidate;
  }
  return taskSourceImage || null;
}

/**
 * 新版本应写入的原图：重传/首轮 create 用本轮输入图；分支/续写沿用任务原图。
 * 严禁把引用图当成 version.sourceImage（否则「原图」缩略图错位且链路丢 Vn.0_1）。
 */
export function resolveNewVersionSourceImage({
  mode = "create",
  referenceOnly = false,
  taskSourceImage = null,
  requestImages = [],
  localizedInputImage = null,
} = {}) {
  if (mode === "create" && !referenceOnly) {
    return localizedInputImage || requestImages[0] || taskSourceImage || null;
  }
  // 分支/续写：只认任务原图，绝不回落到引用图
  return taskSourceImage || null;
}

/** 版本步骤基名：V1 → V1.0；V2.0 保持不变 */
export function versionLabelBase(name) {
  const raw = String(name || "V1").trim() || "V1";
  if (/\.\d+$/.test(raw)) return raw;
  return `${raw}.0`;
}

/** 链路步骤标签：V1.0_1、V1.0_2 … */
export function formatVersionStepLabel(versionName, stepIndex) {
  const index = Math.max(1, Number(stepIndex) || 1);
  return `${versionLabelBase(versionName)}_${index}`;
}

/** 已占用的步骤序号（仅看 steps + branchRoot，不含即将被替换的 drafts） */
export function collectUsedStepIndexes(version) {
  const used = new Set();
  const base = versionLabelBase(version?.name);
  const consider = (label) => {
    const raw = String(label || "");
    if (!raw.startsWith(`${base}_`)) return;
    const idx = Number(raw.slice(base.length + 1));
    if (Number.isInteger(idx) && idx >= 1) used.add(idx);
  };
  consider(version?.branchRoot?.label);
  for (const step of version?.steps || []) consider(step?.label);
  return used;
}

/** 下一个未占用的步骤序号 */
export function nextVersionStepIndex(version) {
  const used = collectUsedStepIndexes(version);
  let index = 1;
  while (used.has(index)) index += 1;
  return index;
}

/**
 * 分配不重复的步骤标签。preferred 未被占用时优先保留（续写归档 tip）。
 */
export function allocateVersionStepLabel(version, preferredLabel = null) {
  const used = collectUsedStepIndexes(version);
  const base = versionLabelBase(version?.name);
  const preferred = String(preferredLabel || "");
  if (preferred.startsWith(`${base}_`)) {
    const idx = Number(preferred.slice(base.length + 1));
    if (Number.isInteger(idx) && idx >= 1 && !used.has(idx)) {
      return formatVersionStepLabel(version?.name, idx);
    }
  }
  return formatVersionStepLabel(version?.name, nextVersionStepIndex(version));
}

export function ensureVersionSteps(version) {
  if (!version) return [];
  if (!Array.isArray(version.steps)) version.steps = [];
  return version.steps;
}

/** 续写前把当前 tip 归档进 steps，保证链路可回溯多步 */
export function archiveVersionTip(version, tip, parent = null) {
  if (!version || !tip?.id || !tip?.image) return null;
  const steps = ensureVersionSteps(version);
  if (steps.some((step) => step.id === tip.id)) {
    return steps.find((step) => step.id === tip.id) || null;
  }
  // 同图已在 steps / branchRoot：复用已有标签，避免再插入重复 V1.0_1
  const sameImage =
    steps.find((step) => step.image && step.image === tip.image) ||
    (version.branchRoot?.image === tip.image ? version.branchRoot : null);
  if (sameImage) {
    return sameImage;
  }
  const label = allocateVersionStepLabel(version, tip.label);
  const archived = {
    id: tip.id,
    image: tip.image,
    label,
    parentDraftId: parent?.id || version.parentDraftId || null,
    parentImage: parent?.image || version.refImage || null,
  };
  steps.push(archived);
  return archived;
}

/** 结果图 → 引用父图（来自紧邻的上一条 user.quote） */
export function buildResultParentMap(messages = [], versionId = null) {
  const parentOf = new Map();
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg?.role !== "ai") continue;
    if (versionId && msg.versionId !== versionId) continue;
    const draft =
      (msg.draftId && msg.drafts?.find((item) => item.id === msg.draftId)) || msg.drafts?.[0];
    if (!draft?.image) continue;
    let quote = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      const prev = messages[j];
      if (prev?.role === "user") {
        quote = prev.quote || null;
        break;
      }
      if (prev?.role === "ai") break;
    }
    if (quote?.image) {
      parentOf.set(draft.image, {
        id: quote.draftId || null,
        image: quote.image,
        label: quote.label || null,
        versionId: quote.versionId || null,
      });
    }
  }
  return parentOf;
}

/**
 * 新分支版本：把引用父图（如 V1 棕裙）收成固定 branchRoot = Vn.0_1。
 * 该节点不会因续写/修复被覆盖。
 */
export function createBranchRootStep(versionName, ref, sourceImage = null) {
  if (!ref?.image || ref.image === sourceImage) return null;
  if (ref.kind === "source") return null;
  return {
    id: ref.draftId || `branch-root-${versionName}`,
    image: ref.image,
    label: formatVersionStepLabel(versionName, 1),
    parentImage: sourceImage || null,
    fromVersionId: ref.versionId || null,
  };
}

function collectVersionGeneratedImages(version, messages = []) {
  const images = new Set();
  for (const msg of messages) {
    if (msg?.role !== "ai" || msg.versionId !== version.id) continue;
    (msg.drafts || []).forEach((draft) => draft?.image && images.add(draft.image));
    if (msg.image) images.add(msg.image);
  }
  (version.drafts || []).forEach((draft) => draft?.image && images.add(draft.image));
  // steps 里可能混有 branchRoot（他版本父图），不算「本版本生成」
  (version.steps || []).forEach((step) => {
    if (step?.image && !step.fromVersionId) images.add(step.image);
  });
  return images;
}

/** 解析版本的分支起点（跨版本引用父图），优先用永久字段 branchRoot */
export function resolveBranchRoot(version, messages = [], sourceImage = null, versions = []) {
  if (!version) return null;
  if (version.branchRoot?.image && version.branchRoot.image !== sourceImage) {
    return {
      ...version.branchRoot,
      label: formatVersionStepLabel(version.name, 1),
    };
  }
  const rooted = (version.steps || []).find((step) => step?.fromVersionId && step.image);
  if (rooted?.image && rooted.image !== sourceImage) {
    return {
      id: rooted.id,
      image: rooted.image,
      label: formatVersionStepLabel(version.name, 1),
      fromVersionId: rooted.fromVersionId,
      parentImage: rooted.parentImage || sourceImage || null,
    };
  }
  // 兼容：续写后仍留下的跨版本溯源字段
  if (version.branchFromDraftId || version.branchFromVersionId) {
    const fromVer = versions.find((item) => item.id === version.branchFromVersionId);
    const fromDraft = fromVer
      ? fromVer.drafts?.find((d) => d.id === version.branchFromDraftId) ||
        fromVer.steps?.find((d) => d.id === version.branchFromDraftId) ||
        fromVer.branchRoot
      : null;
    const image = fromDraft?.image || null;
    if (image && image !== sourceImage) {
      return {
        id: version.branchFromDraftId || fromDraft.id,
        image,
        label: formatVersionStepLabel(version.name, 1),
        fromVersionId: version.branchFromVersionId || null,
        parentImage: sourceImage || null,
      };
    }
  }
  // 从该版本首条 AI 消息前的 user.quote 恢复（跨版本引用，或 quote 图不属于本版本生成）
  const ownGenerated = collectVersionGeneratedImages(version, messages);
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg?.role !== "ai" || msg.versionId !== version.id) continue;
    let quote = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (messages[j]?.role === "user") {
        quote = messages[j].quote || null;
        break;
      }
      if (messages[j]?.role === "ai") break;
    }
    const crossVersion = quote?.versionId && quote.versionId !== version.id;
    const foreignImage =
      quote?.image &&
      quote.image !== sourceImage &&
      !ownGenerated.has(quote.image);
    if (quote?.image && quote.image !== sourceImage && (crossVersion || foreignImage)) {
      return createBranchRootStep(version.name, quote, sourceImage);
    }
    break;
  }
  // 兼容旧字段：parentVersionId 指向其他版本
  if (
    version.parentVersionId &&
    version.parentVersionId !== version.id &&
    version.parentDraftId
  ) {
    const parentVer = versions.find((item) => item.id === version.parentVersionId);
    const parentDraft = parentVer
      ? parentVer.drafts?.find((d) => d.id === version.parentDraftId) ||
        parentVer.steps?.find((d) => d.id === version.parentDraftId) ||
        parentVer.branchRoot
      : null;
    const image = parentDraft?.image || version.refImage;
    if (image && image !== sourceImage) {
      return {
        id: version.parentDraftId,
        image,
        label: formatVersionStepLabel(version.name, 1),
        fromVersionId: version.parentVersionId,
        parentImage: sourceImage || null,
      };
    }
  }
  return null;
}

/**
 * 从 tip 沿引用回溯本版本链路；分支起点（棕裙）始终在链首。
 * 标签由调用方按当前版本重编号，不沿用 V1.0_x。
 */
export function buildTipLineageChain({
  version,
  messages = [],
  selectedDraftId = null,
  sourceImage = null,
  targetDraftId = null,
  targetImage = null,
  versions = [],
} = {}) {
  if (!version) return [];
  const tip = resolveVersionTipDraft(version, selectedDraftId);
  const branchRoot = resolveBranchRoot(version, messages, sourceImage, versions);
  const target =
    (targetDraftId &&
      (version.drafts?.find((d) => d.id === targetDraftId) ||
        version.steps?.find((d) => d.id === targetDraftId) ||
        (branchRoot?.id === targetDraftId ? branchRoot : null))) ||
    (targetImage &&
      (version.drafts?.find((d) => d.image === targetImage) ||
        version.steps?.find((d) => d.image === targetImage) ||
        (branchRoot?.image === targetImage ? branchRoot : null) || {
          id: targetDraftId || null,
          image: targetImage,
          label: null,
        })) ||
    tip;
  if (!target?.image) return [];

  const parentOf = buildResultParentMap(messages, version.id);
  const localImages = new Set();
  (version.steps || []).forEach((step) => step?.image && localImages.add(step.image));
  (version.drafts || []).forEach((draft) => draft?.image && localImages.add(draft.image));
  for (const msg of messages) {
    if (msg?.role === "ai" && msg.versionId === version.id) {
      (msg.drafts || []).forEach((draft) => draft?.image && localImages.add(draft.image));
    }
  }
  localImages.add(target.image);
  if (branchRoot?.image) localImages.add(branchRoot.image);

  const chainRev = [];
  let current = { id: target.id || null, image: target.image, label: null };
  const seen = new Set();
  while (current?.image && !seen.has(current.image)) {
    seen.add(current.image);
    chainRev.push(current);
    if (branchRoot?.image && current.image === branchRoot.image) break;
    const parent = parentOf.get(current.image);
    if (!parent?.image || parent.image === sourceImage) break;
    // 只在本版本产物 + 分支根内继续；跨到更早版本则停在分支根
    if (!localImages.has(parent.image)) {
      if (branchRoot?.image && parent.image === branchRoot.image) {
        chainRev.push({ id: branchRoot.id, image: branchRoot.image, label: null });
      }
      break;
    }
    current = { id: parent.id, image: parent.image, label: null };
  }

  let chain = chainRev.reverse();
  if (branchRoot?.image && !chain.some((item) => item.image === branchRoot.image)) {
    chain = [{ id: branchRoot.id, image: branchRoot.image, label: null }, ...chain];
  }
  // 去重保序
  const deduped = [];
  const seenImg = new Set();
  for (const item of chain) {
    if (!item?.image || seenImg.has(item.image) || item.image === sourceImage) continue;
    seenImg.add(item.image);
    deduped.push(item);
  }
  return deduped;
}

/**
 * 重建 version.branchRoot + steps + tip 标签。
 * branchRoot 永久保留；steps 仅为 tip 之前的本版本祖先（含 branchRoot）。
 */
export function repairVersionLineageFromMessages(
  version,
  messages = [],
  selectedDraftId = null,
  _extraDrafts = [],
  sourceImage = null,
  versions = [],
) {
  if (!version) return false;
  const tip = resolveVersionTipDraft(version, selectedDraftId);
  if (!tip?.image) return false;

  const branchRoot = resolveBranchRoot(version, messages, sourceImage, versions);
  if (branchRoot) {
    version.branchRoot = {
      id: branchRoot.id,
      image: branchRoot.image,
      label: formatVersionStepLabel(version.name, 1),
      fromVersionId: branchRoot.fromVersionId || null,
      parentImage: branchRoot.parentImage || sourceImage || null,
    };
  }

  const chain = buildTipLineageChain({
    version,
    messages,
    selectedDraftId,
    sourceImage,
    versions,
  });
  if (!chain.length) return false;

  const tipImages = new Set((version.drafts || []).map((draft) => draft?.image).filter(Boolean));
  const historical = chain.filter((item) => item.image && !tipImages.has(item.image));
  const nextSteps = historical.map((item, index) => {
    // 优先用对话消息上的原始 draftId，纠正历史 lineage-* 错映射
    const messageDraftId = findMessageDraftIdByImage(messages, version.id, item.image);
    const stableId =
      messageDraftId ||
      (item.id && !String(item.id).startsWith("lineage-") ? item.id : null) ||
      item.id ||
      `lineage-${index + 1}`;
    return {
      id: stableId,
      image: item.image,
      label: formatVersionStepLabel(version.name, index + 1),
      fromVersionId:
        branchRoot && item.image === branchRoot.image ? branchRoot.fromVersionId || null : null,
      parentImage: index > 0 ? historical[index - 1].image : sourceImage || null,
    };
  });
  const start = nextSteps.length + 1;
  // 同轮多张按 drafts 顺序连续编号，避免只保留 tip 一张
  const nextDrafts = (version.drafts || []).map((draft, index) => ({
    ...draft,
    label: formatVersionStepLabel(version.name, start + index),
  }));

  const prevSteps = JSON.stringify(
    (version.steps || []).map((step) => ({ id: step.id, image: step.image, label: step.label })),
  );
  const nextStepsJson = JSON.stringify(
    nextSteps.map((step) => ({ id: step.id, image: step.image, label: step.label })),
  );
  const prevRoot = JSON.stringify(version.branchRoot || null);
  const labelsChanged = (version.drafts || []).some(
    (draft, index) => draft.label !== nextDrafts[index]?.label,
  );
  if (prevSteps === nextStepsJson && !labelsChanged && prevRoot === JSON.stringify(version.branchRoot || null)) {
    return false;
  }

  version.steps = nextSteps;
  version.drafts = nextDrafts;
  // 立即父图用于续写；分支根单独保存在 branchRoot，永不因续写丢失
  if (nextSteps.length) {
    const last = nextSteps[nextSteps.length - 1];
    version.refImage = last.image;
    version.refLabel = last.label;
    version.parentDraftId = last.id;
    version.parentVersionId = version.id;
  }
  if (version.branchRoot) {
    // 保留跨版本溯源
    version.branchFromVersionId = version.branchRoot.fromVersionId;
    version.branchFromDraftId = version.branchRoot.id;
  }
  return true;
}

/** @deprecated 不再用种子图平铺旁支；保留空实现以免旧调用报错 */
export const KNOWN_LINEAGE_SEEDS = Object.freeze([]);

export function knownLineageExtraDrafts() {
  return [];
}

function findDraftInVersion(version, draftId) {
  if (!version || !draftId) return null;
  return (
    version.drafts?.find((draft) => draft.id === draftId) ||
    version.steps?.find((step) => step.id === draftId) ||
    null
  );
}

/**
 * 版本链路：原图 → 真实引用祖先 → 当前目标。
 * 优先按对话 quote 回溯，避免把旁支按时间误拼进一条线。
 */
export function buildBranchPathNodes({
  sourceImage,
  versions = [],
  versionId,
  selectedDraftId,
  messages = null,
  focusDraftId = null,
  focusImage = null,
}) {
  const version = versions.find((item) => item.id === versionId);
  if (!version) return [];

  const pathSourceImage = resolveVersionSourceImage(version, sourceImage);
  const nodes = [];
  if (pathSourceImage) {
    nodes.push({
      key: "source",
      kind: "source",
      label: "原图",
      image: pathSourceImage,
      versionId: null,
      draftId: null,
    });
  }

  const tip = resolveVersionTipDraft(version, selectedDraftId);
  const branchRoot = resolveBranchRoot(version, messages || [], pathSourceImage, versions);
  const target =
    (focusDraftId &&
      (findDraftInVersion(version, focusDraftId) ||
        (branchRoot?.id === focusDraftId ? branchRoot : null))) ||
    (focusImage &&
      (version.steps?.find((step) => step.image === focusImage) ||
        version.drafts?.find((draft) => draft.image === focusImage) ||
        (branchRoot?.image === focusImage ? branchRoot : null) || {
          id: focusDraftId,
          image: focusImage,
          label: null,
        })) ||
    tip;

  let chain = buildTipLineageChain({
    version,
    messages: messages || [],
    selectedDraftId,
    sourceImage: pathSourceImage,
    targetDraftId: target?.id || focusDraftId,
    targetImage: target?.image || focusImage,
    versions,
  });

  const steps = Array.isArray(version.steps) ? version.steps : [];
  let stepsChain = [
    ...(branchRoot?.image && branchRoot.image !== target?.image ? [branchRoot] : []),
    ...steps.filter(
      (step) =>
        step?.image &&
        step.image !== target?.image &&
        step.image !== branchRoot?.image,
    ),
    ...(target?.image ? [target] : []),
  ];
  if (target?.image) {
    const idx = stepsChain.findIndex((item) => item.image === target.image || item.id === target.id);
    if (idx >= 0) stepsChain = stepsChain.slice(0, idx + 1);
  }

  // 对话链过短（无 messages / 只走到 tip）时用 steps；并确保 branchRoot 不丢
  const quoteHasRoot =
    !branchRoot?.image || chain.some((item) => item.image === branchRoot.image);
  if (
    stepsChain.length > chain.length ||
    (!quoteHasRoot && stepsChain.some((item) => item.image === branchRoot?.image))
  ) {
    chain = stepsChain;
  }

  if (
    chain.length <= 1 &&
    target?.image &&
    version.refImage &&
    version.refImage !== pathSourceImage &&
    version.refImage !== target.image
  ) {
    // 旧数据：无 steps，仅靠 refImage 挂上一张
    let parentDraft = null;
    if (version.parentDraftId && version.parentVersionId && version.parentVersionId !== version.id) {
      const parentVer = versions.find((item) => item.id === version.parentVersionId) || null;
      parentDraft = findDraftInVersion(parentVer, version.parentDraftId);
    }
    if (!parentDraft) {
      parentDraft = {
        id: version.parentDraftId || "ref",
        image: version.refImage,
        label: null,
      };
    }
    chain = [
      ...(parentDraft?.image ? [parentDraft] : []),
      ...(target?.image ? [target] : []),
    ];
  }

  // 祖先链（不含 tip 轮）+ 本轮全部 drafts（引用后一次出多张都要进链路）
  const tipDrafts = Array.isArray(version.drafts) ? version.drafts.filter((d) => d?.image) : [];
  const tipImages = new Set(tipDrafts.map((d) => d.image));
  const ancestors = chain.filter(
    (item) => item?.image && item.image !== pathSourceImage && !tipImages.has(item.image),
  );

  let stepIndex = 0;
  for (const item of ancestors) {
    stepIndex += 1;
    nodes.push({
      key: `draft:${version.id}:${item.id || stepIndex}`,
      kind: "ancestor",
      label: formatVersionStepLabel(version.name, stepIndex),
      image: item.image,
      versionId: version.id,
      draftId: item.id || null,
    });
  }

  const tipRound = tipDrafts.length
    ? tipDrafts
    : target?.image && target.image !== pathSourceImage
      ? [target]
      : [];
  tipRound.forEach((draft, index) => {
    stepIndex += 1;
    const selected =
      (selectedDraftId && draft.id === selectedDraftId) ||
      (!selectedDraftId && index === 0) ||
      (focusDraftId && draft.id === focusDraftId) ||
      (focusImage && draft.image === focusImage);
    const existingLabel = String(draft.label || "");
    const keepLabel = /^V\d+(?:\.\d+)?_\d+$/i.test(existingLabel);
    nodes.push({
      key: `draft:${version.id}:${draft.id || `tip-${index}`}`,
      kind: selected ? "current" : "candidate",
      label: keepLabel ? existingLabel : formatVersionStepLabel(version.name, stepIndex),
      image: draft.image,
      versionId: version.id,
      draftId: draft.id || null,
    });
  });
  return nodes;
}

/** @deprecated 保留给旧测试/调用；新链路直接展示 V1.0_n */
export function shortPathLabel(label) {
  const raw = String(label || "").trim();
  if (!raw) return "";
  if (/^V\d+(?:\.\d+)?_\d+$/i.test(raw)) return raw;
  const withoutVersion = raw.replace(/^V\d+(?:\.\d+)?\s*[·•-]?\s*/i, "").trim();
  return withoutVersion || raw;
}

/** 版本条短文案：V1.0 → V1 */
export function shortVersionName(name) {
  return String(name || "").replace(/\.0$/, "");
}
