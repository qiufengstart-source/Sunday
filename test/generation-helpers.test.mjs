import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  archiveVersionTip,
  buildBranchPathNodes,
  buildGenerateRequest,
  buildTipLineageChain,
  createBranchRootStep,
  findVersionToContinue,
  formatVersionStepLabel,
  freezeMissingVersionSourceImages,
  repairVersionLineageFromMessages,
  resolveCanvasQuoteTarget,
  resolveNewVersionSourceImage,
  resolveQuoteTargetDraft,
  resolveVersionSourceImage,
  isVersionGeneratedOrBranchImage,
  adaptPromptForTextOnly,
  allocateVersionStepLabel,
  inferProductCategory,
  isBrandOrTrademarkRisk,
  nextVersionStepIndex,
  shouldOpenNewTaskForProductChange,
  shouldOpenNewVersionFromReupload,
  shortPathLabel,
  shortVersionName,
  chooseOutputSize,
  cloneGenerationInput,
  cloneGenerateRequest,
  inferImageCountFromText,
  isGeneratedImageRoute,
  isLocalImageRoute,
  isSameGenerateRequest,
  isSameGenerationPackage,
  multiImageOutputRule,
  normalizeCount,
  resolveOutputCount,
  resolveVersionTipDraft,
} from "../generation-helpers.mjs";

test("count defaults to one and preserves valid selections", () => {
  assert.equal(normalizeCount(undefined), 1);
  assert.equal(normalizeCount("1"), 1);
  assert.equal(normalizeCount("4"), 4);
  assert.equal(normalizeCount("5"), 1);
});

test("ratio maps for text and references use resolution tiers", () => {
  assert.equal(chooseOutputSize({ ratio: "16:9", resolution: "1K", hasReference: false }), "1344*768");
  assert.equal(chooseOutputSize({ ratio: "3:4", resolution: "1K", hasReference: false }), "896*1152");
  assert.equal(chooseOutputSize({ ratio: "9:16", resolution: "1K", hasReference: false }), "768*1344");
  assert.equal(chooseOutputSize({ ratio: "9:16", resolution: "2K", hasReference: false }), "1536*2688");
  assert.equal(chooseOutputSize({ ratio: "unknown", resolution: "1K", hasReference: false }), "1K");
  assert.equal(chooseOutputSize({ ratio: "16:9", resolution: "1K", hasReference: true }), "1K");
  assert.equal(chooseOutputSize({ ratio: "16:9", resolution: "2K", hasReference: true }), "2K");
});

test("request sends source and quote once with the selected count", () => {
  const request = buildGenerateRequest({
    prompt: "保持包的外观，将背景改为咖啡馆",
    sourceImage: "data:image/png;base64,source",
    referenceImage: "data:image/png;base64,draft",
    count: 2,
    ratio: "3:4",
    resolution: "1K",
  });
  assert.deepEqual(request, {
    prompt: "保持包的外观，将背景改为咖啡馆",
    images: ["data:image/png;base64,source", "data:image/png;base64,draft"],
    count: 2,
    size: "1K",
    sequential: true,
  });
});

test("reference-only adjust request sends quoted image alone", () => {
  const request = buildGenerateRequest({
    prompt: "换一个姿势，坐在凳子上",
    sourceImage: "data:image/png;base64,blue-source",
    referenceImage: "data:image/png;base64,purple-quote",
    count: 1,
    ratio: "9:16",
    resolution: "1K",
    referenceOnly: true,
  });
  assert.deepEqual(request.images, ["data:image/png;base64,purple-quote"]);
  assert.equal(request.size, "1K");
  assert.equal(request.sequential, false);
});

test("txt2img request maps default 9:16 at 1K", () => {
  const request = buildGenerateRequest({
    prompt: "电商模特图",
    count: 1,
    ratio: "9:16",
    resolution: "1K",
  });
  assert.equal(request.size, "768*1344");
  assert.equal(request.sequential, false);
});

test("reupload with existing versions opens a new version instead of tip continue", () => {
  assert.equal(
    shouldOpenNewVersionFromReupload({
      hasVersions: true,
      pendingDataUrl: "data:image/png;base64,new",
    }),
    true,
  );
  assert.equal(
    shouldOpenNewVersionFromReupload({
      hasVersions: false,
      pendingDataUrl: "data:image/png;base64,new",
    }),
    false,
  );
  assert.equal(
    shouldOpenNewVersionFromReupload({
      hasVersions: true,
      pendingDataUrl: null,
    }),
    false,
  );
});

test("freezeMissingVersionSourceImages only fills versions without sourceImage", () => {
  const oldSource = "data:image/png;base64,old-source";
  const versions = [
    { id: "ver-1", name: "V1", sourceImage: null, drafts: [] },
    { id: "ver-2", name: "V2", sourceImage: "data:image/png;base64,kept", drafts: [] },
  ];
  assert.equal(freezeMissingVersionSourceImages(versions, oldSource), 1);
  assert.equal(versions[0].sourceImage, oldSource);
  assert.equal(versions[1].sourceImage, "data:image/png;base64,kept");
  assert.equal(freezeMissingVersionSourceImages(versions, "data:image/png;base64,ignored"), 0);
});

test("version path prefers per-version sourceImage after reupload", () => {
  const oldSource = "data:image/png;base64,old-source";
  const newSource = "data:image/png;base64,new-source";
  const v1 = {
    id: "ver-1",
    name: "V1",
    sourceImage: oldSource,
    drafts: [{ id: "d1", label: "V1.0_1", image: "data:image/png;base64,v1" }],
    steps: [],
  };
  const v2 = {
    id: "ver-2",
    name: "V2",
    sourceImage: newSource,
    drafts: [{ id: "d2", label: "V2.0_1", image: "data:image/png;base64,v2" }],
    steps: [],
  };
  assert.equal(resolveVersionSourceImage(v1, newSource), oldSource);
  assert.equal(resolveVersionSourceImage(v2, newSource), newSource);

  const v1Path = buildBranchPathNodes({
    sourceImage: newSource,
    versions: [v1, v2],
    versionId: "ver-1",
    selectedDraftId: "d1",
  });
  assert.equal(v1Path[0]?.kind, "source");
  assert.equal(v1Path[0]?.image, oldSource);

  const v2Path = buildBranchPathNodes({
    sourceImage: newSource,
    versions: [v1, v2],
    versionId: "ver-2",
    selectedDraftId: "d2",
  });
  assert.equal(v2Path[0]?.image, newSource);
});

test("branch path shows all tip-round drafts after quoted parent", () => {
  const source = "/uploads/123e4567-e89b-12d3-a456-426614174000.png";
  const quoted = "/generated/123e4567-e89b-12d3-a456-426614174001.png";
  const a = "/generated/123e4567-e89b-12d3-a456-426614174011.png";
  const b = "/generated/123e4567-e89b-12d3-a456-426614174012.png";
  const c = "/generated/123e4567-e89b-12d3-a456-426614174013.png";
  const root = createBranchRootStep(
    "V2",
    { versionId: "ver-1", draftId: "q1", image: quoted },
    source,
  );
  const version = {
    id: "ver-2",
    name: "V2",
    branchRoot: root,
    steps: [root],
    drafts: [
      { id: "d2a", label: "V2.0_2", image: a },
      { id: "d2b", label: "V2.0_3", image: b },
      { id: "d2c", label: "V2.0_4", image: c },
    ],
  };
  const path = buildBranchPathNodes({
    sourceImage: source,
    versions: [version],
    versionId: "ver-2",
    selectedDraftId: "d2a",
  });
  assert.deepEqual(
    path.map((node) => node.label),
    ["原图", "V2.0_1", "V2.0_2", "V2.0_3", "V2.0_4"],
  );
  assert.deepEqual(
    path.map((node) => node.image),
    [source, quoted, a, b, c],
  );
  assert.equal(path.filter((node) => node.kind === "current" || node.kind === "candidate").length, 3);
});

test("polluted version.sourceImage equal to branchRoot falls back to task source", () => {
  const source = "/uploads/123e4567-e89b-12d3-a456-426614174000.png";
  const brown = "/generated/123e4567-e89b-12d3-a456-426614174002.png";
  const tip = "/generated/123e4567-e89b-12d3-a456-426614174005.png";
  const root = createBranchRootStep(
    "V2",
    { versionId: "ver-1", draftId: "brown", image: brown },
    source,
  );
  const version = {
    id: "ver-2",
    name: "V2",
    // 历史 bug：把引用棕裙误写成版本原图
    sourceImage: brown,
    branchRoot: root,
    steps: [root],
    drafts: [{ id: "tip", image: tip, label: "V2.0_2" }],
  };
  assert.equal(isVersionGeneratedOrBranchImage(version, brown), true);
  assert.equal(resolveVersionSourceImage(version, source), source);
  assert.equal(
    resolveNewVersionSourceImage({
      mode: "adjust",
      referenceOnly: true,
      taskSourceImage: source,
      localizedInputImage: brown,
      requestImages: [brown],
    }),
    source,
  );

  const path = buildBranchPathNodes({
    sourceImage: source,
    versions: [version],
    versionId: "ver-2",
    selectedDraftId: "tip",
  });
  assert.deepEqual(
    path.map((node) => node.label),
    ["原图", "V2.0_1", "V2.0_2"],
  );
  assert.deepEqual(
    path.map((node) => node.image),
    [source, brown, tip],
  );
});

test("findVersionToContinue only when quoting the version tip", () => {
  const v1 = {
    id: "ver-1",
    drafts: [
      { id: "d1a", label: "图 1", image: "/generated/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1.png" },
      { id: "d1b", label: "图 2", image: "/generated/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2.png" },
    ],
  };
  assert.equal(resolveVersionTipDraft(v1, "d1b")?.id, "d1b");
  assert.equal(
    findVersionToContinue({
      versions: [v1],
      ref: { versionId: "ver-1", draftId: "d1b", image: v1.drafts[1].image },
      currentVersionId: "ver-1",
      selectedDraftId: "d1b",
    })?.id,
    "ver-1",
  );
  assert.equal(
    findVersionToContinue({
      versions: [v1],
      ref: { versionId: "ver-1", draftId: "d1a", image: v1.drafts[0].image },
      currentVersionId: "ver-1",
      selectedDraftId: "d1b",
    }),
    null,
  );
  assert.equal(
    findVersionToContinue({
      versions: [v1],
      ref: { versionId: null, draftId: null, image: "/uploads/x.png" },
      currentVersionId: "ver-1",
      selectedDraftId: "d1b",
    }),
    null,
  );
  // 本地化后路径变化不影响续写（只认 draftId）
  assert.equal(
    findVersionToContinue({
      versions: [v1],
      ref: {
        versionId: "ver-1",
        draftId: "d1b",
        image: "/uploads/localized-copy.png",
      },
      currentVersionId: "ver-1",
      selectedDraftId: "d1b",
    })?.id,
    "ver-1",
  );
});

test("resolveQuoteTargetDraft never falls back to tip after lineage id rewrite", () => {
  const tipImg = "/generated/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3.png";
  const histImg = "/generated/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1.png";
  const version = {
    id: "ver-1",
    name: "V1",
    // repair 后历史步 id 被改成 lineage-*，消息仍带着原始 draftId
    steps: [{ id: "lineage-1", image: histImg, label: "V1.0_1" }],
    drafts: [{ id: "d3", image: tipImg, label: "V1.0_2" }],
  };
  const quoted = resolveQuoteTargetDraft(version, {
    draftId: "d1",
    imageHint: histImg,
    label: "V1 · 图",
  });
  assert.equal(quoted?.id, "d1");
  assert.equal(quoted?.image, histImg);
  assert.notEqual(quoted?.id, version.drafts[0].id);
  assert.equal(
    findVersionToContinue({
      versions: [version],
      ref: { versionId: "ver-1", draftId: quoted.id, image: quoted.image },
      currentVersionId: "ver-1",
      selectedDraftId: "d3",
    }),
    null,
  );
  // 缺图且 id 对不上时也不能 silently 用 tip
  assert.equal(resolveQuoteTargetDraft(version, { draftId: "d1" }), null);
});

test("resolveCanvasQuoteTarget quotes lineageFocus ancestor not tip", () => {
  const tipImg = "/generated/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3.png";
  const histImg = "/generated/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1.png";
  const version = {
    id: "ver-1",
    name: "V1",
    steps: [{ id: "d1", image: histImg, label: "V1.0_1" }],
    drafts: [{ id: "d3", image: tipImg, label: "V1.0_2" }],
  };
  const quoted = resolveCanvasQuoteTarget({
    version,
    selectedDraftId: "d3",
    lineageFocus: {
      kind: "ancestor",
      versionId: "ver-1",
      draftId: "d1",
      image: histImg,
    },
  });
  assert.equal(quoted?.draftId, "d1");
  assert.equal(quoted?.image, histImg);
  assert.equal(
    findVersionToContinue({
      versions: [version],
      ref: quoted,
      currentVersionId: "ver-1",
      selectedDraftId: "d3",
    }),
    null,
  );
});

test("repairVersionLineageFromMessages restores message draft ids on steps", () => {
  const img1 = "/generated/123e4567-e89b-12d3-a456-426614174001.png";
  const img2 = "/generated/123e4567-e89b-12d3-a456-426614174002.png";
  const img3 = "/generated/123e4567-e89b-12d3-a456-426614174003.png";
  const version = {
    id: "ver-1",
    name: "V1",
    steps: [{ id: "lineage-1", image: img1, label: "V1.0_1" }],
    drafts: [{ id: "d3", image: img3, label: "V1.0_3" }],
    refImage: img2,
  };
  const messages = [
    {
      role: "ai",
      versionId: "ver-1",
      draftId: "d1",
      drafts: [{ id: "d1", image: img1, label: "图 1" }],
    },
    {
      role: "user",
      quote: { versionId: "ver-1", draftId: "d1", image: img1, label: "V1 · 图 1" },
    },
    {
      role: "ai",
      versionId: "ver-1",
      draftId: "d2",
      drafts: [{ id: "d2", image: img2, label: "图 1" }],
    },
    {
      role: "user",
      quote: { versionId: "ver-1", draftId: "d2", image: img2, label: "V1 · 图 1" },
    },
    {
      role: "ai",
      versionId: "ver-1",
      draftId: "d3",
      drafts: [{ id: "d3", image: img3, label: "图 1" }],
    },
  ];
  assert.equal(repairVersionLineageFromMessages(version, messages, "d3"), true);
  assert.equal(version.steps[0]?.id, "d1");
  assert.ok(version.steps.some((step) => step.id === "d2"));
  const quoted = resolveQuoteTargetDraft(version, { draftId: "d1", imageHint: img1 });
  assert.equal(quoted?.id, "d1");
  assert.equal(
    findVersionToContinue({
      versions: [version],
      ref: { versionId: "ver-1", draftId: "d1", image: img1 },
      currentVersionId: "ver-1",
      selectedDraftId: "d3",
    }),
    null,
  );
});

test("repairVersionLineageFromMessages follows quote parents only", () => {
  const img1 = "/generated/123e4567-e89b-12d3-a456-426614174001.png";
  const img2 = "/generated/123e4567-e89b-12d3-a456-426614174002.png";
  const img3 = "/generated/123e4567-e89b-12d3-a456-426614174003.png";
  const version = {
    id: "ver-1",
    name: "V1",
    steps: [{ id: "d2", image: img2, label: "V1.0_1" }],
    drafts: [{ id: "d3", image: img3, label: "V1.0_2" }],
    refImage: img2,
  };
  const messages = [
    {
      role: "ai",
      versionId: "ver-1",
      draftId: "d1",
      drafts: [{ id: "d1", image: img1, label: "图 1" }],
    },
    {
      role: "user",
      quote: { versionId: "ver-1", draftId: "d1", image: img1, label: "V1 · 图 1" },
    },
    {
      role: "ai",
      versionId: "ver-1",
      draftId: "d2",
      drafts: [{ id: "d2", image: img2, label: "图 1" }],
    },
    {
      role: "user",
      quote: { versionId: "ver-1", draftId: "d2", image: img2, label: "V1 · 图 1" },
    },
    {
      role: "ai",
      versionId: "ver-1",
      draftId: "d3",
      drafts: [{ id: "d3", image: img3, label: "图 1" }],
    },
  ];
  assert.equal(repairVersionLineageFromMessages(version, messages, "d3"), true);
  assert.deepEqual(
    version.steps.map((step) => step.image),
    [img1, img2],
  );
  assert.deepEqual(
    version.steps.map((step) => step.label),
    ["V1.0_1", "V1.0_2"],
  );
  assert.equal(version.drafts[0].label, "V1.0_3");
  const path = buildBranchPathNodes({
    sourceImage: "/uploads/123e4567-e89b-12d3-a456-426614174000.png",
    versions: [version],
    versionId: "ver-1",
    selectedDraftId: "d3",
    messages,
  });
  assert.deepEqual(
    path.map((node) => node.label),
    ["原图", "V1.0_1", "V1.0_2", "V1.0_3"],
  );
});

test("V2 branch keeps quoted brown as V2.0_1 then shawl and bottle", () => {
  const source = "/uploads/123e4567-e89b-12d3-a456-426614174000.png";
  const brown = "/generated/123e4567-e89b-12d3-a456-426614174002.png";
  const green = "/generated/123e4567-e89b-12d3-a456-426614174003.png";
  const shawl = "/generated/123e4567-e89b-12d3-a456-426614174004.png";
  const bottle = "/generated/123e4567-e89b-12d3-a456-426614174005.png";
  const root = createBranchRootStep(
    "V2",
    { versionId: "ver-1", draftId: "brown", image: brown, label: "V1.0_2" },
    source,
  );
  assert.equal(root.label, "V2.0_1");
  assert.equal(root.image, brown);

  const version = {
    id: "ver-2",
    name: "V2",
    refImage: brown,
    parentDraftId: "brown",
    parentVersionId: "ver-1",
    branchRoot: root,
    steps: [root],
    drafts: [{ id: "bottle", image: bottle, label: "V2.0_3" }],
  };
  const messages = [
    // V1 旁支绿裙，不应进入 V2
    { role: "user", quote: { versionId: "ver-1", draftId: "brown", image: brown } },
    { role: "ai", versionId: "ver-1", draftId: "green", drafts: [{ id: "green", image: green }] },
    // V2：引用棕裙 → 披肩 → 粉瓶
    { role: "user", quote: { versionId: "ver-1", draftId: "brown", image: brown } },
    { role: "ai", versionId: "ver-2", draftId: "shawl", drafts: [{ id: "shawl", image: shawl }] },
    { role: "user", quote: { versionId: "ver-2", draftId: "shawl", image: shawl } },
    { role: "ai", versionId: "ver-2", draftId: "bottle", drafts: [{ id: "bottle", image: bottle }] },
  ];
  const chain = buildTipLineageChain({
    version: { ...version, drafts: [{ id: "bottle", image: bottle }], steps: [root] },
    messages,
    selectedDraftId: "bottle",
    sourceImage: source,
  });
  assert.deepEqual(
    chain.map((item) => item.image),
    [brown, shawl, bottle],
  );
  assert.equal(chain.some((item) => item.image === green), false);

  assert.equal(
    repairVersionLineageFromMessages(version, messages, "bottle", [], source),
    true,
  );
  assert.equal(version.branchRoot?.image, brown);
  assert.deepEqual(
    version.steps.map((step) => step.image),
    [brown, shawl],
  );
  assert.deepEqual(
    version.steps.map((step) => step.label),
    ["V2.0_1", "V2.0_2"],
  );
  assert.equal(version.drafts[0].label, "V2.0_3");

  const path = buildBranchPathNodes({
    sourceImage: source,
    versions: [version],
    versionId: "ver-2",
    selectedDraftId: "bottle",
    messages,
  });
  assert.deepEqual(
    path.map((node) => node.label),
    ["原图", "V2.0_1", "V2.0_2", "V2.0_3"],
  );
  assert.deepEqual(
    path.map((node) => node.image),
    [source, brown, shawl, bottle],
  );
});

test("V2 recovers brown branchRoot after continue wiped parentVersionId", () => {
  const source = "/uploads/123e4567-e89b-12d3-a456-426614174000.png";
  const brown = "/generated/123e4567-e89b-12d3-a456-426614174002.png";
  const shawl = "/generated/123e4567-e89b-12d3-a456-426614174004.png";
  const bottle = "/generated/123e4567-e89b-12d3-a456-426614174005.png";
  // 模拟旧数据：续写后 steps 只剩披肩，parent 指向自身，棕裙仅留在首条 quote
  const version = {
    id: "ver-2",
    name: "V2",
    refImage: shawl,
    parentDraftId: "shawl",
    parentVersionId: "ver-2",
    steps: [{ id: "shawl", image: shawl, label: "V2.0_1" }],
    drafts: [{ id: "bottle", image: bottle, label: "V2.0_2" }],
  };
  const messages = [
    { role: "user", quote: { versionId: "ver-1", draftId: "brown", image: brown } },
    { role: "ai", versionId: "ver-2", draftId: "shawl", drafts: [{ id: "shawl", image: shawl }] },
    { role: "user", quote: { versionId: "ver-2", draftId: "shawl", image: shawl } },
    { role: "ai", versionId: "ver-2", draftId: "bottle", drafts: [{ id: "bottle", image: bottle }] },
  ];
  assert.equal(
    repairVersionLineageFromMessages(version, messages, "bottle", [], source, []),
    true,
  );
  assert.equal(version.branchRoot?.image, brown);
  assert.deepEqual(
    version.steps.map((step) => step.image),
    [brown, shawl],
  );
  assert.deepEqual(
    version.steps.map((step) => step.label),
    ["V2.0_1", "V2.0_2"],
  );
  assert.equal(version.drafts[0].label, "V2.0_3");
  const path = buildBranchPathNodes({
    sourceImage: source,
    versions: [version],
    versionId: "ver-2",
    selectedDraftId: "bottle",
    messages,
  });
  assert.deepEqual(
    path.map((node) => node.label),
    ["原图", "V2.0_1", "V2.0_2", "V2.0_3"],
  );
  assert.deepEqual(
    path.map((node) => node.image),
    [source, brown, shawl, bottle],
  );
});

test("continued version keeps full step history with V1.0_n labels", () => {
  assert.equal(formatVersionStepLabel("V1", 1), "V1.0_1");
  assert.equal(formatVersionStepLabel("V1.0", 2), "V1.0_2");

  const source = "/uploads/123e4567-e89b-12d3-a456-426614174000.png";
  const img1 = "/generated/123e4567-e89b-12d3-a456-426614174001.png";
  const img2 = "/generated/123e4567-e89b-12d3-a456-426614174002.png";
  const img3 = "/generated/123e4567-e89b-12d3-a456-426614174003.png";
  const v1 = {
    id: "ver-1",
    name: "V1",
    steps: [],
    drafts: [{ id: "d1", label: "V1.0_1", image: img1 }],
  };
  archiveVersionTip(v1, v1.drafts[0]);
  v1.drafts = [{ id: "d2", label: "V1.0_2", image: img2 }];
  archiveVersionTip(v1, v1.drafts[0]);
  v1.drafts = [{ id: "d3", label: "V1.0_3", image: img3 }];

  const path = buildBranchPathNodes({
    sourceImage: source,
    versions: [v1],
    versionId: "ver-1",
    selectedDraftId: "d3",
  });
  assert.deepEqual(
    path.map((node) => node.label),
    ["原图", "V1.0_1", "V1.0_2", "V1.0_3"],
  );
  assert.deepEqual(
    path.map((node) => node.image),
    [source, img1, img2, img3],
  );
});

test("step labels stay unique when branch root already reserved V1.0_1", () => {
  const img1 = "/generated/123e4567-e89b-12d3-a456-426614174011.png";
  const img2 = "/generated/123e4567-e89b-12d3-a456-426614174012.png";
  const v1 = {
    id: "ver-1",
    name: "V1",
    branchRoot: { id: "root", image: img1, label: "V1.0_1" },
    steps: [{ id: "root", image: img1, label: "V1.0_1" }],
    drafts: [{ id: "d1", label: "V1.0_1", image: img1 }],
  };
  assert.equal(allocateVersionStepLabel(v1, "V1.0_1"), "V1.0_2");
  assert.equal(nextVersionStepIndex(v1), 2);
  // 同图 tip 归档应复用，不插入第二条 V1.0_1
  const archived = archiveVersionTip(v1, v1.drafts[0]);
  assert.equal(archived.label, "V1.0_1");
  assert.equal(v1.steps.filter((s) => s.label === "V1.0_1").length, 1);
  v1.drafts = [{ id: "d2", label: "V1.0_2", image: img2 }];
  archiveVersionTip(v1, v1.drafts[0]);
  assert.deepEqual(
    v1.steps.map((s) => s.label),
    ["V1.0_1", "V1.0_2"],
  );
});

test("legacy path without steps uses numbered labels instead of 上一步/结果", () => {
  const source = "/uploads/123e4567-e89b-12d3-a456-426614174000.png";
  const prev = "/generated/123e4567-e89b-12d3-a456-426614174001.png";
  const next = "/generated/123e4567-e89b-12d3-a456-426614174002.png";
  const v1 = {
    id: "ver-1",
    name: "V1",
    parentVersionId: "ver-1",
    parentDraftId: "old-tip",
    refImage: prev,
    refLabel: "图 1",
    drafts: [{ id: "new-tip", label: "图 1", image: next }],
  };
  const path = buildBranchPathNodes({
    sourceImage: source,
    versions: [v1],
    versionId: "ver-1",
    selectedDraftId: "new-tip",
  });
  assert.deepEqual(
    path.map((node) => node.label),
    ["原图", "V1.0_1", "V1.0_2"],
  );
  assert.equal(path[1].image, prev);
  assert.equal(path[2].image, next);
});

test("branch path is source → quoted parent as Vn.0_1 → result as Vn.0_2", () => {
  const source = "/uploads/123e4567-e89b-12d3-a456-426614174000.png";
  const v1img = "/generated/123e4567-e89b-12d3-a456-426614174001.png";
  const v1sib = "/generated/123e4567-e89b-12d3-a456-426614174002.png";
  const v2img = "/generated/123e4567-e89b-12d3-a456-426614174003.png";
  const v3img = "/generated/123e4567-e89b-12d3-a456-426614174004.png";
  const v1 = {
    id: "ver-1",
    name: "V1",
    parentVersionId: null,
    parentDraftId: null,
    refImage: source,
    refLabel: "原图",
    steps: [],
    drafts: [
      { id: "d1a", label: "V1.0_1", image: v1img },
      { id: "d1b", label: "V1.0_2", image: v1sib },
    ],
  };
  const v2Root = createBranchRootStep(
    "V2",
    { versionId: "ver-1", draftId: "d1a", image: v1img },
    source,
  );
  const v2 = {
    id: "ver-2",
    name: "V2",
    parentVersionId: "ver-1",
    parentDraftId: "d1a",
    refImage: v1img,
    refLabel: "V2.0_1",
    branchRoot: v2Root,
    steps: [v2Root],
    drafts: [{ id: "d2", label: "V2.0_2", image: v2img }],
  };
  const v3Root = createBranchRootStep(
    "V3",
    { versionId: "ver-2", draftId: "d2", image: v2img },
    source,
  );
  const v3 = {
    id: "ver-3",
    name: "V3",
    parentVersionId: "ver-2",
    parentDraftId: "d2",
    refImage: v2img,
    refLabel: "V3.0_1",
    branchRoot: v3Root,
    steps: [v3Root],
    drafts: [{ id: "d3", label: "V3.0_2", image: v3img }],
  };
  const versions = [v1, v2, v3];
  const pathV2 = buildBranchPathNodes({
    sourceImage: source,
    versions,
    versionId: "ver-2",
    selectedDraftId: "d2",
  });
  assert.deepEqual(
    pathV2.map((node) => node.label),
    ["原图", "V2.0_1", "V2.0_2"],
  );
  assert.equal(pathV2[1].image, v1img);
  assert.equal(pathV2[2].draftId, "d2");
  assert.equal(pathV2.some((node) => node.image === v1sib), false);

  const pathV3 = buildBranchPathNodes({
    sourceImage: source,
    versions,
    versionId: "ver-3",
    selectedDraftId: "d3",
  });
  assert.deepEqual(
    pathV3.map((node) => node.image),
    [source, v2img, v3img],
  );
  assert.deepEqual(
    pathV3.map((node) => node.label),
    ["原图", "V3.0_1", "V3.0_2"],
  );
  assert.equal(shortVersionName("V1.0"), "V1");
  assert.equal(shortPathLabel("V1.0_1"), "V1.0_1");
  assert.equal(shortPathLabel("V1.0·图 1"), "图 1");
});

test("same generation package detects unchanged prompt and request", () => {
  const request = {
    prompt: "白底主图",
    images: ["/uploads/123e4567-e89b-12d3-a456-426614174000.png"],
    count: 1,
    size: "1K",
    sequential: false,
  };
  const prev = { promptSnapshot: "白底主图", request };
  const same = {
    promptSnapshot: "白底主图",
    request: cloneGenerateRequest(request),
  };
  const changed = {
    promptSnapshot: "白底主图",
    request: { ...cloneGenerateRequest(request), count: 2, sequential: true },
  };
  assert.equal(isSameGenerateRequest(request, same.request), true);
  assert.equal(isSameGenerationPackage(prev, same), true);
  assert.equal(isSameGenerationPackage(prev, changed), false);
});

test("infer and resolve output count from pose language", () => {
  assert.equal(inferImageCountFromText("生成3个不同姿势的模特图"), 3);
  assert.equal(inferImageCountFromText("给我三张候选"), 3);
  assert.equal(inferImageCountFromText("改成白底"), null);
  assert.equal(resolveOutputCount({ selectedCount: 1, text: "生成3个姿势" }), 3);
  assert.equal(resolveOutputCount({ selectedCount: 4, text: "生成2张" }), 4);
  assert.match(multiImageOutputRule(3), /3 张/);
  assert.equal(multiImageOutputRule(1), "");
});

test("generated image routes accept only exact lowercase UUID PNG paths", () => {
  const route = "/generated/123e4567-e89b-12d3-a456-426614174000.png";
  assert.equal(isGeneratedImageRoute(route), true);
  assert.equal(isGeneratedImageRoute(`https://example.com${route}`), false);
  assert.equal(isGeneratedImageRoute("data:image/png;base64,YQ=="), false);
  assert.equal(isGeneratedImageRoute(route.toUpperCase()), false);
  assert.equal(isGeneratedImageRoute(route.replace("/generated/", "/GENERATED/")), false);
  assert.equal(isGeneratedImageRoute(`${route}\" onerror=\"alert(1)`), false);
  assert.equal(isGeneratedImageRoute("/generated/../secret.png"), false);
  assert.equal(isGeneratedImageRoute(`${route}\n`), false);
});

test("local image routes accept only exact generated and upload paths", () => {
  const uuid = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(isLocalImageRoute(`/generated/${uuid}.png`), true);
  assert.equal(isLocalImageRoute(`/uploads/${uuid}.png`), true);
  assert.equal(isLocalImageRoute(`/uploads/${uuid}.jpg`), true);
  assert.equal(isLocalImageRoute(`/uploads/${uuid}.webp`), true);
  assert.equal(isLocalImageRoute(`/uploads/${uuid}.jpeg`), false);
  assert.equal(isLocalImageRoute(`/uploads/${uuid.toUpperCase()}.png`), false);
  assert.equal(isLocalImageRoute(`/UPLOADS/${uuid}.png`), false);
  assert.equal(isLocalImageRoute(`/uploads/${uuid}.png?download=1`), false);
  assert.equal(isLocalImageRoute(`/uploads/../${uuid}.png`), false);
  assert.equal(isLocalImageRoute("data:image/png;base64,YQ=="), false);
});

test("retry request clone is independent from later stored payload mutations", () => {
  const stored = {
    prompt: "原始提示词",
    images: ["data:image/png;base64,source"],
    count: 2,
    size: "1K",
  };
  const retryRequest = cloneGenerateRequest(stored);

  stored.images.push("data:image/png;base64,later");
  stored.count = 4;

  assert.deepEqual(retryRequest, {
    prompt: "原始提示词",
    images: ["data:image/png;base64,source"],
    count: 2,
    size: "1K",
    sequential: false,
  });
});

test("transient generation input clone isolates request and reference metadata", () => {
  const stored = {
    mode: "adjust",
    note: "keep this request",
    ref: {
      kind: "draft",
      label: "V1 · 草稿 1",
      image: "/generated/123e4567-e89b-12d3-a456-426614174000.png",
      versionId: "version-1",
      draftId: "draft-1",
    },
    request: {
      prompt: "原始提示词",
      images: ["data:image/png;base64,source"],
      count: 2,
      size: "1K",
    },
    promptSnapshot: "原始提示词",
    sourceInputIndex: 0,
    userMessageId: "message-1",
  };
  const cloned = cloneGenerationInput(stored);

  stored.request.images.push("data:image/png;base64,later");
  stored.ref.label = "changed";

  assert.deepEqual(cloned, {
    mode: "adjust",
    note: "keep this request",
    ref: {
      kind: "draft",
      label: "V1 · 草稿 1",
      image: "/generated/123e4567-e89b-12d3-a456-426614174000.png",
      versionId: "version-1",
      draftId: "draft-1",
    },
    request: {
      prompt: "原始提示词",
      images: ["data:image/png;base64,source"],
      count: 2,
      size: "1K",
      sequential: false,
    },
    promptSnapshot: "原始提示词",
    sourceInputIndex: 0,
    userMessageId: "message-1",
  });
});

test("app uses transient task maps, validates inputImages, and owns generation controls by token", async () => {
  const appSource = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(appSource, /const pendingAttachments = new Map\(\)/);
  assert.match(appSource, /const retrySnapshots = new Map\(\)/);
  assert.match(appSource, /let activeGenerationToken = null/);
  assert.match(appSource, /result\.inputImages/);
  assert.match(appSource, /activeGenerationToken === operationToken/);
  assert.match(appSource, /\$\("#composer-input"\)\.disabled = busy/);
  assert.match(appSource, /const requestSourceImage = sourceImage \|\| task\.sourceImage/);
  assert.match(appSource, /function abortActiveGeneration\(/);
  assert.match(appSource, /signal: activeAbortController\?\.signal/);
  assert.doesNotMatch(appSource, /state\.ui\.attachDataUrl/);
  assert.doesNotMatch(appSource, /当前任务已有版本，更换原图请新建任务/);

  const fileHandler = appSource.slice(
    appSource.indexOf("async function onFileSelected"),
    appSource.indexOf("function clearAttach"),
  );
  assert.match(fileHandler, /task\.sourceImage\s*=/);
});

test("task and project navigation clear the transient quote before changing context", async () => {
  const appSource = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(appSource, /function clearTransientQuote\(\) \{[\s\S]*state\.ui\.quoteRef = null;[\s\S]*renderQuote\(\);[\s\S]*\}/);

  const switchProject = appSource.slice(
    appSource.indexOf("function switchProject"),
    appSource.indexOf("function startNewTask"),
  );
  assert.ok(switchProject.indexOf("clearTransientQuote();") < switchProject.indexOf("state.currentProjectId = id"));

  const openTask = appSource.slice(
    appSource.indexOf("function openTask"),
    appSource.indexOf("/* ---------- Params ---------- */"),
  );
  assert.ok(openTask.indexOf("clearTransientQuote();") < openTask.indexOf("state.currentProjectId = task.projectId"));
});

test("unquoted adjust defaults to latest tip without category confirm popup", async () => {
  const appSource = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(appSource, /function resolveLatestTipDraft\(/);
  assert.match(appSource, /已默认基于最近一张/);
  assert.match(appSource, /isAmbiguousImageTargetText/);
  assert.doesNotMatch(appSource, /未识别到明确商品品类/);
  assert.doesNotMatch(
    appSource,
    /是否仍在当前「\$\{productCategoryLabel\(task\.productCategory\)\}」任务继续/,
  );
});

test("send path enforces quote ownership and adjust local-edit prefix", async () => {
  const appSource = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(appSource, /function isQuoteOwnedByTask\(task, quote\)/);
  assert.match(appSource, /引用已失效或不属于当前任务/);
  assert.match(
    appSource,
    /调整要求：在参考图基础上做局部修改；未点名的主体、商品外观、构图与关键文字默认保持不变。/,
  );
  assert.match(appSource, /generationMode === "adjust" \? adjustRule : ""/);
  // 已有版本后默认 adjust；重新上传原图则强制 create 开新版本
  assert.match(appSource, /shouldOpenNewVersionFromReupload\(/);
  assert.match(
    appSource,
    /const generationMode = hasVersions && !openNewFromReupload \? "adjust" : "create"/,
  );
  assert.match(appSource, /findVersionToContinue\(\{/);
  assert.match(appSource, /shouldOpenNewTaskForProductChange\(/);
  assert.match(appSource, /isBrandOrTrademarkRisk\(/);
  assert.match(appSource, /当前任务已有生成结果，请新建任务后再切换文生图\/图生图/);
  assert.match(appSource, /不是当前版本最新图，将开新版本继续修改/);
  assert.match(appSource, /refreshTaskTitle\(/);
  assert.match(appSource, /生成描述为空/);
  assert.doesNotMatch(appSource, /willCreateFirst/);
});

test("product category helpers isolate windows and brand risk", () => {
  assert.equal(inferProductCategory("女士米色高跟鞋商品图"), "shoes");
  assert.equal(inferProductCategory("燕麦色针织开衫女装"), "apparel");
  assert.equal(inferProductCategory("白色女士手提包"), "bag");
  assert.equal(
    shouldOpenNewTaskForProductChange({
      hasVersions: true,
      previousCategory: "shoes",
      nextCategory: "bag",
      hasQuote: false,
      hasPendingUpload: false,
    }),
    true,
  );
  assert.equal(
    shouldOpenNewTaskForProductChange({
      hasVersions: true,
      previousCategory: "shoes",
      nextCategory: "bag",
      hasQuote: true,
      hasPendingUpload: false,
    }),
    false,
  );
  assert.equal(isBrandOrTrademarkRisk("生成带 Nike 勾形标识的跑鞋"), true);
  assert.equal(isBrandOrTrademarkRisk("白色跑鞋商品主图"), false);
  assert.match(adaptPromptForTextOnly("以上传图片商品为核心基底，保留造型"), /用户描述的商品/);
});

test("reupload with versions does not overwrite sourceImage until send opens new version", async () => {
  const appSource = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const fileHandler = appSource.slice(
    appSource.indexOf("async function onFileSelected"),
    appSource.indexOf("function clearAttach"),
  );
  assert.match(fileHandler, /pendingAttachments\.set\(task\.id/);
  assert.match(fileHandler, /!task\.versions\.length/);
  assert.match(fileHandler, /发送后将基于新图生成新版本/);
  assert.match(appSource, /freezeMissingVersionSourceImages\(task\.versions, task\.sourceImage\)/);
  assert.match(appSource, /sourceImage:\s*versionSourceImage/);
  assert.match(appSource, /resolveNewVersionSourceImage\(/);
  assert.match(appSource, /resolveVersionSourceImage\(/);
  assert.match(appSource, /isVersionGeneratedOrBranchImage\(/);
  assert.match(appSource, /openNewFromReupload \? null : quote/);
});

test("flow light-align keeps prompt preview, change check, and honest queue", async () => {
  const appSource = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(appSource, /promptPreview/);
  assert.match(appSource, /isSameGenerationPackage/);
  assert.match(appSource, /参数与指令未变化，仍要重新生成？/);
  assert.match(appSource, /上一笔生成仍在服务端收尾/);
  assert.match(appSource, /abortForceReleaseTimer/);
  assert.match(appSource, /可继续：引用修改、批量下载、保存素材库，或新建任务/);
  assert.doesNotMatch(
    appSource,
    /setTaskStatus\(task, "queued"\);\s*renderWorkbench\(\);\s*setTaskStatus\(task, "running"\)/,
  );
});

test("chat splits multi-image results and quotes specific draft", async () => {
  const appSource = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(appSource, /buildBranchPathNodes/);
  assert.match(appSource, /data-quote-draft/);
  assert.match(appSource, /data-quote-image/);
  assert.match(appSource, /resolveQuoteTargetDraft\(/);
  assert.match(appSource, /resolveCanvasQuoteTarget\(/);
  assert.match(appSource, /draftId: draft\.id/);
  assert.match(appSource, /已拆开，可分别引用/);
  assert.match(appSource, /V\$\{versionIndex\}/);
  assert.doesNotMatch(appSource, /←引/);
  // 聊天引用禁止回落到 tip，否则往回引用会误续写 V1
  assert.doesNotMatch(
    appSource,
    /data-quote-version[\s\S]{0,400}version\?\.drafts\[0\]/,
  );
});

test("chat UI keeps quote on results and moves confirm actions to canvas", async () => {
  const appSource = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(appSource, /function formatGenerationError\(/);
  assert.match(appSource, /function updateComposerGuide\(/);
  assert.match(appSource, /function renderAssistantResultHtml\(/);
  assert.match(appSource, /function resolveAssistantResultDrafts\(/);
  assert.match(appSource, /isGeneratedImageRoute\(draft\.image\)/);
  assert.match(appSource, /msg-result-hero/);
  assert.match(appSource, /data-quote-version/);
  assert.doesNotMatch(appSource, /m\.role === "user" \|\| \(m\.role === "ai"/);
  assert.doesNotMatch(html, /id="btn-confirm-hd"/);
  assert.doesNotMatch(html, /id="btn-save-prompt"/);
  assert.match(html, /id="canvas-preview"/);
  assert.match(html, /id="btn-batch-download"/);
  assert.match(html, /预览图片/);
  assert.doesNotMatch(html, /id="composer-hint"/);
  assert.doesNotMatch(html, /id="params-tab"/);
  // 看图必须用点击的那张（DOM src / lineageFocus），禁止回落到 getSelectedDraft tip
  assert.match(appSource, /function focusTaskDraft\(/);
  assert.match(appSource, /const preview = imageFromDom \|\| focused\?\.image/);
  assert.doesNotMatch(
    appSource,
    /msg-result-hero[\s\S]{0,200}getSelectedDraft\(task\)\?\.image/,
  );
  // 多图灯箱：覆盖对话/画布/链路/素材库/引用选择/批量下载
  assert.match(appSource, /function stepLightbox\(/);
  assert.match(appSource, /collectTaskLightboxItems/);
  assert.match(appSource, /collectPathLightboxItems/);
  assert.match(appSource, /collectVersionLightboxItems/);
  assert.match(appSource, /collectRefPickerLightboxItems/);
  assert.match(appSource, /collectAssetStripLightboxItems/);
  assert.match(appSource, /lightbox-filmstrip/);
  assert.match(appSource, /ArrowLeft/);
  assert.match(appSource, /#quote-thumb/);
  assert.match(appSource, /#attach-thumb/);
  assert.match(html, /id="btn-lightbox-prev"/);
  assert.match(html, /id="btn-lightbox-next"/);
  assert.match(html, /id="lightbox-filmstrip"/);
});
