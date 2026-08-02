import {
  adaptPromptForTextOnly,
  allocateVersionStepLabel,
  archiveVersionTip,
  buildBranchPathNodes,
  buildGenerateRequest,
  createBranchRootStep,
  findVersionToContinue,
  formatVersionStepLabel,
  freezeMissingVersionSourceImages,
  inferProductCategory,
  isBrandOrTrademarkRisk,
  isVersionGeneratedOrBranchImage,
  nextVersionStepIndex,
  productCategoryLabel,
  repairVersionLineageFromMessages,
  resolveBranchRoot,
  resolveCanvasQuoteTarget,
  resolveNewVersionSourceImage,
  resolveQuoteTargetDraft,
  resolveVersionSourceImage,
  shouldOpenNewTaskForProductChange,
  shouldOpenNewVersionFromReupload,
  shortVersionName,
  cloneGenerationInput,
  cloneGenerateRequest,
  isGeneratedImageRoute,
  isLocalImageRoute,
  isSameGenerationPackage,
  multiImageOutputRule,
  normalizeCount,
  normalizeResolution,
  resolveOutputCount,
} from "./generation-helpers.mjs";
import { zipBlobFromFiles } from "./zip-store.mjs";

/* AI 商品视觉生成工作台 · Cursor 式对话原型 */
(() => {
  const STORAGE_KEY = "ai-visual-workbench-proto-v5";
  const USER_NAME = "张敏";

  /** 品类字段：key, 标签, 枚举提示（可下拉选择，也可自定义输入） */
  const CATEGORY_FIELDS = {
    apparel: [
      ["color", "颜色", ["米白色", "黑色", "白色", "藏青", "卡其色", "浅灰", "红色", "牛仔蓝"]],
      ["material", "材质", ["棉质针织", "真丝", "牛仔", "羊毛混纺", "亚麻", "雪纺", "皮革"]],
      ["person", "人物形象", ["无人物", "亚洲女性模特", "欧美女性模特", "亚洲男性模特", "欧美男性模特", "儿童模特"]],
      ["pose", "动作", ["自然站姿", "行走动态", "坐姿", "半身特写", "回头看", "倚靠姿势"]],
      ["bg", "背景", ["明亮室内", "北欧客厅", "户外街景", "纯色影棚", "海边", "咖啡馆"]],
      ["placement", "商品位置", ["画面居中", "画面居中偏下", "左侧构图", "右侧构图", "平铺展示"]],
    ],
    bag: [
      ["color", "颜色", ["米白", "黑色", "棕色", "酒红", "浅驼", "墨绿", "牛仔蓝"]],
      ["material", "材质", ["荔枝纹皮革", "光滑皮革", "帆布", "尼龙", "绒面", "编织材质"]],
      ["person", "人物形象", ["无人物", "手臂持包", "肩背模特", "斜挎模特"]],
      ["pose", "动作", ["静物摆放", "手提展示", "斜挎动态", "打开展示内里"]],
      ["bg", "背景", ["户外咖啡馆浅景", "大理石台面", "极简白底", "城市街景", "草地野餐"]],
      ["placement", "商品位置", ["桌面中央", "画面居中", "人物侧前", "地面静物"]],
    ],
    digital: [
      ["scene", "使用场景", ["桌面办公", "居家娱乐", "出行便携", "影棚产品图", "游戏场景"]],
      ["sell", "卖点展示方式", ["特写+环境", "爆炸结构示意", "使用中场景", "对比前后", "多角度组合"]],
      ["effect", "效果元素", ["柔光、轻微反射", "霓虹氛围", "干净棚拍光", "蓝光科技感"]],
      ["bg", "背景", ["极简浅灰", "深色科技感", "木纹桌面", "纯白", "渐变背景"]],
    ],
    beauty: [
      ["scene", "使用场景", ["浴室台面", "梳妆台", "手部涂抹", "旅行场景", "护肤步骤展示"]],
      ["sell", "卖点展示方式", ["质感微距", "成分意象", "使用前后", "包装全貌", "材质拉丝特写"]],
      ["effect", "效果元素", ["水珠、晨光", "雾面柔光", "金色高光", "气泡光感"]],
      ["bg", "背景", ["干净大理石", "浅粉柔光", "纯色背景", "绿植浅景", "浴室瓷砖"]],
    ],
    other: [
      ["type", "产品类型", ["家居香氛", "餐厨用品", "宠物用品", "创意礼品", "收纳整理"]],
      ["look", "整体外观", ["磨砂玻璃瓶", "木质纹理", "金属质感", "织物软装", "陶瓷哑光"]],
      ["pack", "包装信息", ["简约标签", "礼盒包装", "无包装主体", "环保纸盒"]],
      ["style", "目标风格", ["北欧自然", "日式极简", "美式复古", "现代轻奢", "工业风"]],
    ],
  };

  const STATUS_TEXT = {
    idle: "待开始",
    queued: "排队中",
    running: "生成中",
    success: "成功",
    failed: "失败",
    blocked: "已拦截",
  };

  const TYPE_LABEL = { img2img: "商品图加工", txt2img: "创意生图" };
  const CAT_LABEL = {
    apparel: "服饰鞋靴",
    bag: "箱包配饰",
    digital: "3C 数码",
    beauty: "美妆日化",
    other: "其他",
  };
  const TPL_STATUS = { draft: "草稿", published: "已发布", disabled: "已停用" };
  const DEFAULT_PERSONAL_PROMPT_ID = "pp_default_product_commerce";

  /** @type {any} */
  let state = loadState();
  /** @type {Record<string, any>} */
  let refPickMap = {};
  let refPickClickTimer = null;
  let editingPersonalId = null;
  let editingTemplateId = null;
  let renameProjectId = null;
  let pickTab = "public";
  const pendingAttachments = new Map();
  const retrySnapshots = new Map();
  let activeGenerationToken = null;
  let activeAbortController = null;
  let abortForceReleaseTimer = null;
  let sendButtonMode = "send"; // send | running | stopping

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function uid(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }
  function nowLabel() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function shortId(id) {
    return id.slice(-8).toUpperCase();
  }
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function escapeAttr(str) {
    return escapeHtml(str).replace(/'/g, "&#39;");
  }

  function seedTemplates() {
    return [
      {
        id: "tpl_apparel_nature",
        name: "欧美服饰 · 自然生活",
        desc: "保留商品主体，自然室内/户外生活场景",
        type: "img2img",
        category: "apparel",
        content: "keep product identity, {color} {material} apparel, {person}, {pose}, {bg}, soft natural light, {placement}, ecommerce hero photo",
        negative: "watermark, messy text, distorted logo",
        status: "published",
        version: 2,
        updatedAt: Date.now() - 86400000,
        updatedBy: "系统预置",
      },
      {
        id: "tpl_bag_cafe",
        name: "箱包配饰 · 咖啡馆浅景",
        desc: "箱包静物 + 浅景咖啡馆氛围",
        type: "img2img",
        category: "bag",
        content: "product-focused bag photo, {color} {material}, {pose}, {bg}, shallow depth of field, {placement}",
        negative: "extra handles, warped shape",
        status: "published",
        version: 1,
        updatedAt: Date.now() - 172800000,
        updatedBy: "系统预置",
      },
      {
        id: "tpl_beauty_bath",
        name: "美妆日化 · 浴室晨光",
        desc: "质感微距与晨光浴室台面",
        type: "txt2img",
        category: "beauty",
        content: "beauty product still life, {scene}, {sell}, {effect}, {bg}, clean premium aesthetic",
        negative: "dirty surface, crowded shelf",
        status: "published",
        version: 1,
        updatedAt: Date.now() - 259200000,
        updatedBy: "系统预置",
      },
    ];
  }

  function seedPersonalPrompts() {
    return [
      {
        id: DEFAULT_PERSONAL_PROMPT_ID,
        name: "商品主体保真 · 跨境电商标准",
        type: "img2img",
        category: "other",
        tags: "默认,跨境电商,主体保真,商业实拍",
        content: [
          "主体约束：以上传图片商品为核心基底，最大限度保留商品造型、配色、材质纹理、配件、图案等主体特征，不得篡改、变形、更换商品样式。",
          "画质标准：8K 高清商业实拍质感，画面锐利、层次分明，光影真实；无瑕疵畸变、噪点、虚影；成品满足跨境电商上架标准，无文字、水印、涂鸦。",
          "背景要求：背景低干扰、简约克制，纯色极简背景优先；场景图仅搭配少量适配道具，杜绝繁杂元素，保证商品为视觉中心。",
          "构图与画面元素：画面构图协调，商品完整入镜；适配独立站主图、详情图比例；支持产出模特展示图、场景效果图、风格统一系列图、局部修复图。",
          "人物规范：画面存在人物时，人体比例正常，五官肢体无畸形；人物作用为衬托商品，视觉重心落在商品本身，贴合海外独立站写实审美。",
        ].join("\n"),
        negative: "文字,水印,涂鸦,商品变形,更换商品样式,畸形五官,畸形肢体,噪点,虚影,繁杂背景",
        source: "系统预置",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];
  }

  function ensureDefaultPersonalPrompts() {
    if (!Array.isArray(state.personalPrompts)) state.personalPrompts = [];
    seedPersonalPrompts().forEach((item) => {
      if (!state.personalPrompts.some((prompt) => prompt.id === item.id)) {
        state.personalPrompts.unshift(item);
      }
    });
  }

  function getDefaultPersonalPrompt() {
    ensureDefaultPersonalPrompts();
    return (
      state.personalPrompts.find((item) => item.id === DEFAULT_PERSONAL_PROMPT_ID) ||
      state.personalPrompts[0] ||
      null
    );
  }

  /** 默认选用个人提示词（静默，角标可见；用户清除后不再强行加回） */
  function ensureDefaultPersonalPrompt(task) {
    if (!task || task.promptSource || task.promptSourceCleared) return;
    const pp = getDefaultPersonalPrompt();
    if (!pp) return;
    task.promptSource = {
      kind: "personal",
      id: pp.id,
      name: pp.name,
      content: pp.content,
      negative: pp.negative || "",
      version: null,
      type: pp.type,
      category: pp.category,
    };
    state.ui.appliedPrompt = task.promptSource;
  }

  /** 未选用提示词且输入不超过该字数时，跳过 Qwen，直接万相 */
  const DIRECT_WAN_MAX_CHARS = 50;

  function hasManagedPromptSource(task) {
    const src = task?.promptSource;
    return !!(src && String(src.content || "").trim());
  }

  /** 选用了提示词管理下的提示词 → 必优化；未选用且 ≤50 字 → 直出；未选用且 >50 字 → 仍优化润色 */
  function shouldOptimizeUserText(task, userText) {
    if (hasManagedPromptSource(task)) return true;
    return String(userText || "").trim().length > DIRECT_WAN_MAX_CHARS;
  }

  function formatQuickParamsForGuide(task) {
    const params = task?.params || {};
    const fieldBits = Object.entries(params.fields || {})
      .filter(([, value]) => String(value || "").trim())
      .map(([key, value]) => `${key}:${String(value).trim()}`);
    return [
      params.market ? `风格市场：${params.market}` : "",
      fieldBits.length ? `品类参数：${fieldBits.join("；")}` : "",
      params.extra ? `补充描述：${params.extra}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  async function optimizeUserTextWithPrompt(task, userText, signal) {
    const src = task?.promptSource;
    const templateGuide = src?.content ? fillTemplate(src.content, task.params?.fields) : "";
    const quickGuide = formatQuickParamsForGuide(task);
    const guidePrompt = [templateGuide, quickGuide].filter(Boolean).join("\n\n");
    const response = await fetch("/api/optimize-prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userText,
        guidePrompt,
        negative: task.params?.negative || src?.negative || "",
      }),
      signal,
    });
    if (!response.ok) {
      const errorBody = await response.json().catch(() => null);
      throw new Error(errorBody?.error || "文本优化失败，请稍后重试。");
    }
    const data = await response.json().catch(() => null);
    const optimized = String(data?.optimized || "").trim();
    if (!optimized) throw new Error("文本优化未返回有效内容。");
    return { text: optimized, optimized: true };
  }

  function buildSendPrompt({ task, generationMode, userIntentText, useOptimizedBody }) {
    const adjustRule =
      "调整要求：在参考图基础上做局部修改；未点名的主体、商品外观、构图与关键文字默认保持不变。";
    if (useOptimizedBody) {
      const params = task.params || defaultParams();
      const extras = [
        params.market,
        params.extra,
        ...Object.values(params.fields || {}).filter(Boolean),
      ]
        .filter(Boolean)
        .join(". ");
      const neg = params.negative || task.promptSource?.negative || "";
      return [
        generationMode === "adjust" ? adjustRule : "",
        multiImageOutputRule(task.params.count),
        userIntentText,
        extras,
        neg ? `Avoid: ${neg}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    return [
      generationMode === "adjust" ? adjustRule : "",
      multiImageOutputRule(task.params.count),
      buildEffectivePrompt(task),
      userIntentText,
    ]
      .filter(Boolean)
      .join("\n");
  }

  function defaultState() {
    return {
      projects: [],
      currentProjectId: null,
      tasks: [],
      assets: [],
      personalPrompts: seedPersonalPrompts(),
      publicTemplates: seedTemplates(),
      favorites: [],
      ui: {
        view: "onboarding",
        taskType: "img2img",
        compareMode: false,
        paramsOpen: false,
        quoteRef: null,
        promptTab: "mine",
        appliedPrompt: null,
        taskFilter: "all",
      },
    };
  }

  function isDataImage(value) {
    return typeof value === "string" && value.startsWith("data:image/");
  }

  function normalizeLoadedState(loaded) {
    delete loaded.ui.attachDataUrl;
    delete loaded.ui.attachName;
    if (isDataImage(loaded.ui.quoteRef?.image)) loaded.ui.quoteRef = null;
    if (loaded.ui.view === "templates") {
      loaded.ui.view = "prompts";
      loaded.ui.promptTab = "templates";
    }
    if (!["mine", "templates", "fav"].includes(loaded.ui.promptTab)) {
      loaded.ui.promptTab = "mine";
    }

    let lineageRepaired = false;
    if (Array.isArray(loaded.tasks)) {
      loaded.tasks.forEach((task) => {
        if (isDataImage(task.sourceImage)) task.sourceImage = null;
        if (Array.isArray(task.messages)) {
          task.messages.forEach((message) => {
            if (isDataImage(message.image)) message.image = null;
            if (isDataImage(message.quote?.image)) message.quote = null;
          });
        }
        if (Array.isArray(task.versions)) {
          task.versions.forEach((version) => {
            if (isDataImage(version.refImage)) version.refImage = null;
            if (
              version.sourceImage &&
              isVersionGeneratedOrBranchImage(version, version.sourceImage)
            ) {
              delete version.sourceImage;
              lineageRepaired = true;
            }
            if (
              repairVersionLineageFromMessages(
                version,
                task.messages || [],
                task.selectedDraftId,
                [],
                task.sourceImage,
                task.versions,
              )
            ) {
              lineageRepaired = true;
            }
          });
        }
        const stored = task.lastGenerationInput;
        const images = stored?.request?.images;
        if (
          !Array.isArray(images) ||
          !images.every(isLocalImageRoute) ||
          (stored.ref?.image && !isLocalImageRoute(stored.ref.image))
        ) {
          delete task.lastGenerationInput;
        }
      });
    }
    if (Array.isArray(loaded.assets)) {
      loaded.assets.forEach((asset) => {
        if (isDataImage(asset.sourceImage)) asset.sourceImage = null;
      });
      const before = loaded.assets.length;
      loaded.assets = dedupeAssetsList(loaded.assets);
      if (loaded.assets.length !== before) lineageRepaired = true;
    }
    loaded.__lineageRepaired = lineageRepaired;
    return loaded;
  }

  /** 同项目同任务下相同图片只保留一条（优先保留带步骤标签的） */
  function dedupeAssetsList(assets = []) {
    const best = new Map();
    assets.forEach((asset) => {
      if (!asset?.image) return;
      const key = `${asset.projectId || ""}::${asset.taskId || "unknown"}::${asset.image}`;
      const prev = best.get(key);
      if (!prev) {
        best.set(key, asset);
        return;
      }
      const score = (item) =>
        (item.stepLabel ? 4 : 0) +
        (item.stepOrder != null ? 2 : 0) +
        (item.versionName ? 1 : 0) +
        (item.createdAt || 0) / 1e15;
      if (score(asset) >= score(prev)) best.set(key, asset);
    });
    return [...best.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  function unsaveAsset(assetId) {
    if (!assetId) return;
    const before = state.assets.length;
    state.assets = state.assets.filter((asset) => asset.id !== assetId);
    if (state.assets.length === before) return;
    saveState();
    if (state.ui.view === "assets") renderAssetsPage();
    else renderWorkbench();
    toast("已取消保存");
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const base = defaultState();
        const loaded = normalizeLoadedState({
          ...base,
          ...parsed,
          ui: { ...base.ui, ...(parsed.ui || {}) },
        });
        const repaired = !!loaded.__lineageRepaired;
        delete loaded.__lineageRepaired;
        if (repaired) {
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(loaded));
          } catch (_) {}
        }
        return loaded;
      }
    } catch (_) {}
    return defaultState();
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (_) {
      return false;
    }
  }

  function toast(text) {
    const wrap = $("#toast-wrap");
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = text;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  function currentProject() {
    return state.projects.find((p) => p.id === state.currentProjectId) || null;
  }
  function currentTask() {
    const p = currentProject();
    if (!p || !p.currentTaskId) return null;
    return state.tasks.find((t) => t.id === p.currentTaskId) || null;
  }
  function projectTasks(projectId) {
    return state.tasks.filter((t) => t.projectId === projectId).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  function projectAssets(projectId) {
    return state.assets.filter((a) => a.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt);
  }
  function isFavorited(kind, targetId) {
    return state.favorites.some((f) => f.kind === kind && f.targetId === targetId);
  }

  // Compatibility-only fallback for older local records; new generations never use it.
  function placeholderSvg(label, hue = 210) {
    return `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="800" viewBox="0 0 640 800">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop stop-color="hsl(${hue},28%,86%)"/><stop offset="1" stop-color="hsl(${hue},22%,74%)"/>
        </linearGradient></defs>
        <rect width="640" height="800" fill="url(#g)"/>
        <rect x="80" y="180" width="480" height="420" rx="28" fill="white" fill-opacity=".55"/>
        <text x="320" y="400" text-anchor="middle" font-family="PingFang SC,sans-serif" font-size="28" fill="#333">${label}</text>
        <text x="320" y="440" text-anchor="middle" font-family="PingFang SC,sans-serif" font-size="16" fill="#666">原型占位图</text>
      </svg>`
    )}`;
  }

  function categoryLabel(key) {
    if (!key) return "";
    return CAT_LABEL[key] || key;
  }

  const RATIO_OPTIONS = ["1:1", "2:3", "3:4", "4:3", "16:9", "9:16"];

  function defaultParams() {
    return {
      category: "",
      ratio: "9:16",
      resolution: "1K",
      count: 1,
      market: "",
      fields: {},
      extra: "",
      negative: "",
    };
  }

  function normalizeRatioOption(value) {
    const ratio = String(value || "").trim();
    return RATIO_OPTIONS.includes(ratio) ? ratio : "9:16";
  }

  function createBlankTask(projectId, type) {
    return {
      id: uid("task"),
      projectId,
      type,
      status: "idle",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      title: type === "img2img" ? "商品图加工任务" : "创意生图任务",
      sourceImage: null,
      params: defaultParams(),
      messages: [],
      versions: [],
      currentVersionId: null,
      selectedDraftId: null,
      hdReady: false,
      hdImage: null,
      failReason: "",
      promptSource: null,
      effectivePrompt: "",
    };
  }

  function seedWelcomeTask(projectId) {
    const task = createBlankTask(projectId, state.ui.taskType || "img2img");
    ensureDefaultPersonalPrompt(task);
    task.messages = [
      {
        id: uid("m"),
        role: "system",
        text: "上传商品原图，或直接描述画面后发送。已默认选用个人提示词：发送时先经 Qwen 优化再生成；若清除提示词且描述不超过 50 字，将直接生成。",
        time: nowLabel(),
      },
    ];
    state.tasks.unshift(task);
    const p = state.projects.find((x) => x.id === projectId);
    if (p) p.currentTaskId = task.id;
    saveState();
  }

  /* ---------- Views ---------- */
  function showView(name) {
    if (name === "templates") {
      name = "prompts";
      state.ui.promptTab = "templates";
    }
    if (!state.projects.length && name !== "onboarding") name = "onboarding";
    if (state.projects.length && name === "onboarding") name = "workbench";
    state.ui.view = name;
    $$(".view-panel").forEach((el) => el.classList.toggle("active", el.id === `view-${name}`));
    closeDropdown();
    saveState();
    renderAll();
  }

  function openOverlay(id) {
    $(`#${id}`)?.classList.add("open");
  }
  function closeOverlay(id) {
    $(`#${id}`)?.classList.remove("open");
  }
  function closeDropdown() {
    $("#project-dropdown")?.classList.remove("open");
  }

  /* ---------- Projects ---------- */
  function openCreateProject() {
    renameProjectId = null;
    $("#project-modal-title").textContent = "创建店铺项目";
    $("#btn-confirm-create-project").textContent = "创建并进入";
    $("#project-name-input").value = "";
    $("#project-note-input").value = "";
    openOverlay("project-overlay");
    setTimeout(() => $("#project-name-input").focus(), 50);
  }

  function openRenameProject(id) {
    const p = state.projects.find((x) => x.id === id);
    if (!p) return;
    renameProjectId = id;
    $("#project-modal-title").textContent = "重命名店铺项目";
    $("#btn-confirm-create-project").textContent = "保存";
    $("#project-name-input").value = p.name;
    $("#project-note-input").value = p.note || "";
    openOverlay("project-overlay");
  }

  function confirmProjectModal() {
    const name = $("#project-name-input").value.trim();
    const note = $("#project-note-input").value.trim();
    if (!name) {
      toast("请填写项目名称");
      return;
    }
    if (renameProjectId) {
      const p = state.projects.find((x) => x.id === renameProjectId);
      if (p) {
        p.name = name;
        p.note = note || p.note;
      }
      closeOverlay("project-overlay");
      saveState();
      renderAll();
      toast("项目已重命名");
      return;
    }
    const project = {
      id: uid("proj"),
      name,
      note: note || "Shopify",
      createdAt: Date.now(),
      currentTaskId: null,
    };
    state.projects.unshift(project);
    state.currentProjectId = project.id;
    closeOverlay("project-overlay");
    seedWelcomeTask(project.id);
    showView("workbench");
    toast(`已创建项目「${name}」`);
  }

  function clearTransientQuote() {
    state.ui.quoteRef = null;
    renderQuote();
  }

  function switchProject(id) {
    clearTransientQuote();
    state.currentProjectId = id;
    const p = currentProject();
    if (p && !p.currentTaskId) seedWelcomeTask(p.id);
    closeDropdown();
    showView("workbench");
    toast(`已切换到「${p.name}」`);
  }

  function startNewTask(options = {}) {
    const p = currentProject();
    if (!p) return openCreateProject();
    const type = options.type || state.ui.taskType || "img2img";
    state.ui.taskType = type;
    state.ui.compareMode = false;
    clearTransientQuote();
    const task = createBlankTask(p.id, type);
    ensureDefaultPersonalPrompt(task);
    const welcome =
      options.welcomeText ||
      "新对话已开始。已默认选用个人提示词：发送时先经 Qwen 优化再生成；若清除提示词且描述不超过 50 字，将直接生成。";
    task.messages = [
      {
        id: uid("m"),
        role: "system",
        text: welcome,
        time: nowLabel(),
      },
    ];
    if (options.productCategory) task.productCategory = options.productCategory;
    if (options.title) task.title = options.title;
    state.tasks.unshift(task);
    p.currentTaskId = task.id;
    showView("workbench");
    if (!options.silent) toast("已开始新对话任务");
    return task;
  }

  /** 按品类/类型/用例标签自动命名，便于验收与回溯 */
  function refreshTaskTitle(task, userText = "") {
    if (!task || task.titleLocked) return;
    const cat = productCategoryLabel(task.productCategory || inferProductCategory(userText));
    const typeLabel = task.type === "img2img" ? "图生" : "文生";
    const tagMatch = String(userText || "").match(/\[([^\]]{1,32})\]/);
    const tag = tagMatch?.[1]?.trim();
    task.title = tag ? `${cat}·${typeLabel}·${tag}` : `${cat}·${typeLabel}`;
  }

  function openTask(taskId) {
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return;
    clearTransientQuote();
    state.currentProjectId = task.projectId;
    const p = currentProject();
    if (p) p.currentTaskId = task.id;
    state.ui.taskType = task.type;
    ensureDefaultPersonalPrompt(task);
    state.ui.appliedPrompt = task.promptSource || null;
    showView("workbench");
  }

  /* ---------- Params ---------- */
  function suggestValue(root) {
    return (root?.querySelector("input")?.value || "").trim();
  }

  function setSuggestValue(root, value) {
    const input = root?.querySelector("input");
    if (input) input.value = value || "";
  }

  function closeAllSuggestMenus(except) {
    $$(".suggest-menu").forEach((menu) => {
      if (except && menu === except) return;
      menu.hidden = true;
    });
  }

  function fillSuggestMenu(root) {
    const menu = root.querySelector(".suggest-menu");
    if (!menu) return;
    let options = [];
    try {
      options = JSON.parse(root.dataset.options || "[]");
    } catch (_) {
      options = [];
    }
    menu.innerHTML = options
      .map((opt) => `<li data-value="${escapeAttr(opt)}">${escapeHtml(opt)}</li>`)
      .join("");
  }

  function bindSuggestField(root) {
    if (!root || root.dataset.bound) return;
    const input = root.querySelector("input");
    const btn = root.querySelector(".suggest-btn");
    const menu = root.querySelector(".suggest-menu");
    if (!input || !btn || !menu) return;
    root.dataset.bound = "1";
    fillSuggestMenu(root);

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const open = menu.hidden;
      closeAllSuggestMenus();
      menu.hidden = !open;
      if (!menu.hidden) fillSuggestMenu(root);
    });

    menu.addEventListener("click", (e) => {
      const li = e.target.closest("li[data-value]");
      if (!li) return;
      input.value = li.dataset.value;
      menu.hidden = true;
      input.focus();
      persistQuickParamsQuietly();
      if (root.dataset.combo === "ratio") {
        const resolution = normalizeResolution($("#param-resolution")?.value || $("#gen-resolution")?.value);
        const ratio = normalizeRatioOption(li.dataset.value);
        const count = normalizeCount($("#param-count")?.value || $("#gen-count")?.value);
        syncComposerGenControls({ resolution, ratio, count });
      }
    });

    input.addEventListener("focus", () => closeAllSuggestMenus());
    input.addEventListener("change", () => persistQuickParamsQuietly());
    if (root.dataset.combo === "ratio") {
      input.addEventListener("change", () => {
        const resolution = normalizeResolution($("#param-resolution")?.value || $("#gen-resolution")?.value);
        const ratio = normalizeRatioOption(input.value);
        const count = normalizeCount($("#param-count")?.value || $("#gen-count")?.value);
        syncComposerGenControls({ resolution, ratio, count });
      });
    }
  }

  /** 选中/改完即写入任务，避免重绘抽屉时被空值冲掉 */
  function persistQuickParamsQuietly(source = "drawer") {
    const task = currentTask();
    if (!task) return;
    task.params = collectParamsFromDrawer(source);
    task.updatedAt = Date.now();
    saveState();
  }

  function renderParamFields() {
    const cat = $("#param-category").value;
    const task = currentTask();
    const values = task?.params?.fields || {};
    const wrap = $("#param-fields");
    wrap.innerHTML = "";
    const defs = CATEGORY_FIELDS[cat];
    if (!defs) {
      wrap.innerHTML = `<p class="help">选择品类后，可展开对应快捷参数。</p>`;
      return;
    }
    defs.forEach(([key, label, options]) => {
      const div = document.createElement("div");
      div.className = "field";
      div.innerHTML = `
        <label>${label}</label>
        <div class="suggest-field" data-field-combo="${key}" data-options='${escapeAttr(JSON.stringify(options || []))}'>
          <input type="text" placeholder="输入或点 ▾ 选用常用项" autocomplete="off" />
          <button class="suggest-btn" type="button" aria-label="常用${escapeAttr(label)}" title="常用选项">▾</button>
          <ul class="suggest-menu" hidden></ul>
        </div>`;
      wrap.appendChild(div);
      const box = div.querySelector(".suggest-field");
      bindSuggestField(box);
      setSuggestValue(box, values[key] || "");
    });
  }

  function syncComposerGenControls(params) {
    const resolution = normalizeResolution(params?.resolution);
    const ratio = normalizeRatioOption(params?.ratio);
    const count = normalizeCount(params?.count);
    const genRes = $("#gen-resolution");
    const genRatio = $("#gen-ratio");
    const genCount = $("#gen-count");
    if (genRes) genRes.value = resolution;
    if (genRatio) genRatio.value = ratio;
    if (genCount) genCount.value = String(count);
  }

  function syncDrawerGenControls({ resolution, ratio, count }) {
    const paramRes = $("#param-resolution");
    if (paramRes) paramRes.value = normalizeResolution(resolution);
    $("#param-count").value = String(normalizeCount(count));
    const ratioBox = $('[data-combo="ratio"]');
    if (ratioBox) setSuggestValue(ratioBox, normalizeRatioOption(ratio));
  }

  function readComposerGenControls() {
    return {
      resolution: normalizeResolution($("#gen-resolution")?.value),
      ratio: normalizeRatioOption($("#gen-ratio")?.value),
      count: normalizeCount($("#gen-count")?.value),
    };
  }

  function collectParamsFromDrawer(source = "composer") {
    const category = $("#param-category").value;
    const fields = {};
    $$("#param-fields [data-field-combo]").forEach((box) => {
      fields[box.dataset.fieldCombo] = suggestValue(box);
    });
    let gen;
    if (source === "drawer") {
      gen = {
        resolution: normalizeResolution($("#param-resolution")?.value),
        ratio: normalizeRatioOption(suggestValue($('[data-combo="ratio"]'))),
        count: normalizeCount($("#param-count").value),
      };
      syncComposerGenControls(gen);
    } else {
      // 对话框底栏为生成控件主入口；发送时回写抽屉
      gen = readComposerGenControls();
      syncDrawerGenControls(gen);
    }
    return {
      category,
      ratio: gen.ratio,
      resolution: gen.resolution,
      count: gen.count,
      market: suggestValue($('[data-combo="market"]')),
      fields,
      extra: $("#param-extra").value.trim(),
      negative: suggestValue($('[data-combo="negative"]')),
    };
  }

  function hasQuickParamsContent(task) {
    const params = task?.params || {};
    return !!(
      String(params.market || "").trim() ||
      String(params.extra || "").trim() ||
      String(params.negative || "").trim() ||
      Object.values(params.fields || {}).some((value) => String(value || "").trim())
    );
  }

  /** 一次性快捷参数：本次生图用过后清空，避免后续每次都带上 */
  function consumeOneShotQuickParams(task) {
    if (!task || !hasQuickParamsContent(task)) return false;
    task.params = {
      ...task.params,
      market: "",
      fields: {},
      extra: "",
      negative: "",
    };
    const market = $('[data-combo="market"]');
    if (market) setSuggestValue(market, "");
    const negative = $('[data-combo="negative"]');
    if (negative) setSuggestValue(negative, "");
    const extra = $("#param-extra");
    if (extra) extra.value = "";
    $$("#param-fields [data-field-combo]").forEach((box) => setSuggestValue(box, ""));
    task.updatedAt = Date.now();
    return true;
  }

  function buildQuickParamsUserText(task) {
    const params = task?.params || {};
    const cat = params.category;
    const fieldDefs = CATEGORY_FIELDS[cat] || [];
    const labelMap = Object.fromEntries(fieldDefs.map(([key, label]) => [key, label]));
    const fieldBits = Object.entries(params.fields || {})
      .filter(([, value]) => String(value || "").trim())
      .map(([key, value]) => `${labelMap[key] || key}：${String(value).trim()}`);
    return [
      params.market ? `风格市场：${params.market}` : "",
      cat ? `品类：${categoryLabel(cat)}` : "",
      ...fieldBits,
      params.extra ? `补充：${params.extra}` : "",
      params.negative ? `避免：${params.negative}` : "",
    ]
      .filter(Boolean)
      .join("；");
  }

  /** 快捷参数「立即生图」：参数 + 选用提示词（若有）→ 有提示词时先 Qwen 再万相 */
  async function generateFromQuickParams() {
    if (activeGenerationToken) {
      toast("已有生成任务进行中");
      return;
    }
    const project = currentProject();
    if (!project) return openCreateProject();
    let task = currentTask();
    if (!task) {
      seedWelcomeTask(project.id);
      task = currentTask();
    }
    if (!task) return;

    task.params = collectParamsFromDrawer("drawer");
    task.updatedAt = Date.now();
    const hasParams = hasQuickParamsContent(task);
    const hasPrompt = hasManagedPromptSource(task);
    if (!hasParams && !hasPrompt) {
      toast("请先填写快捷参数，或选用提示词后再生图");
      return;
    }

    const intent =
      buildQuickParamsUserText(task) ||
      (hasPrompt
        ? "请按选用提示词生成商品图。"
        : task.type === "img2img"
          ? "请基于上传原图生成商品图。"
          : "请根据参数生成创意商品图。");

    setParamsOpen(false);
    await sendMessage({
      textOverride: intent,
      displayText: "按快捷参数立即生图",
      preserveComposer: true,
      fromQuickParams: true,
    });
  }

  function setParamsOpen(open) {
    if (!open && state.ui.paramsOpen) {
      // 收起前落盘，避免只选了选项却没点「应用」导致丢失
      persistQuickParamsQuietly("drawer");
    }
    state.ui.paramsOpen = open;
    $("#params-drawer").classList.toggle("open", open);
    $("#params-drawer").setAttribute("aria-hidden", open ? "false" : "true");
    saveState();
  }

  function syncParamsDrawerFromTask() {
    const task = currentTask();
    const params = {
      ...defaultParams(),
      ...(task?.params || {}),
      ratio: normalizeRatioOption(task?.params?.ratio),
      resolution: normalizeResolution(task?.params?.resolution),
      count: normalizeCount(task?.params?.count),
    };
    if (task) task.params = { ...task.params, ...params };
    $("#param-category").value = params.category || "";
    $("#param-count").value = String(params.count);
    const paramRes = $("#param-resolution");
    if (paramRes) paramRes.value = params.resolution;
    $("#param-extra").value = params.extra || "";
    $$(".suggest-field[data-combo]").forEach((el) => {
      bindSuggestField(el);
      const value =
        el.dataset.combo === "ratio"
          ? params.ratio
          : params[el.dataset.combo] || "";
      setSuggestValue(el, value);
    });
    syncComposerGenControls(params);
    renderParamFields();
  }

  /* ---------- Prompt / Template apply ---------- */
  function fillTemplate(content, fields) {
    return String(content || "").replace(/\{(\w+)\}/g, (_, key) => fields?.[key] || `{${key}}`);
  }

  function taskHasImageInput(task) {
    if (!task) return false;
    const pending = pendingAttachments.get(task.id);
    return !!(task.sourceImage || pending?.dataUrl || state.ui.quoteRef?.image);
  }

  function buildEffectivePrompt(task) {
    const params = task.params || defaultParams();
    const src = task.promptSource;
    let base = src?.content ? fillTemplate(src.content, params.fields) : "";
    if (base && !taskHasImageInput(task)) {
      base = adaptPromptForTextOnly(base);
    }
    const bits = [
      base,
      params.market,
      params.ratio,
      params.extra,
      Object.values(params.fields || {}).filter(Boolean).join(", "),
    ].filter(Boolean);
    const neg = params.negative || src?.negative || "";
    const text = bits.join(". ");
    return neg ? `${text}. Avoid: ${neg}` : text;
  }

  function applyPromptSource(source) {
    const p = currentProject();
    if (!p) {
      openCreateProject();
      return;
    }
    if (!currentTask()) seedWelcomeTask(p.id);
    const task = currentTask();
    if (!task) {
      toast("请先创建任务");
      return;
    }
    if (source.kind === "blank") {
      task.promptSource = null;
      task.promptSourceCleared = true;
      state.ui.appliedPrompt = null;
      pushMessage(
        task,
        "system",
        "已切换为空白创建。描述不超过 50 字时将直接生成；超过 50 字会先优化再生成。",
      );
    } else {
      task.promptSourceCleared = false;
      task.promptSource = {
        kind: source.kind,
        id: source.id,
        name: source.name,
        content: source.content,
        negative: source.negative || "",
        version: source.version || null,
        type: source.type,
        category: source.category,
      };
      state.ui.appliedPrompt = task.promptSource;
      task.type = source.type || task.type;
      state.ui.taskType = task.type;
      if (source.category) task.params.category = source.category;
      // 仅切换品类字段集，不强制预填，保持快捷参数选填
      if (source.negative && !task.params.negative) task.params.negative = source.negative;
      const ver = source.version ? ` v${source.version}` : "";
      pushMessage(
        task,
        "system",
        `已选用${source.kind === "public" ? "模板提示词" : "个人提示词"}「${source.name}」${ver}${source.category ? `，已切换品类为「${categoryLabel(source.category)}」` : ""}。可按需填写快捷参数，本次修改不影响原模板。`
      );
    }
    task.updatedAt = Date.now();
    closeOverlay("pick-overlay");
    saveState();
    showView("workbench");
    toast("已应用到当前任务");
  }

  function openPickOverlay() {
    pickTab = "public";
    $$("#pick-tabs .tab").forEach((t) => t.classList.toggle("on", t.dataset.pickTab === pickTab));
    renderPickBody();
    openOverlay("pick-overlay");
  }

  function renderPickBody() {
    const body = $("#pick-body");
    if (pickTab === "blank") {
      body.innerHTML = `<div class="notice">不选择提示词，使用品类引导与对话描述创建任务。</div>
        <button class="btn primary" data-apply-blank type="button">使用空白创建</button>`;
      return;
    }
    if (pickTab === "personal") {
      const list = state.personalPrompts;
      if (!list.length) {
        body.innerHTML = `<div class="empty-state"><div class="box"><h2>还没有个人提示词</h2><p>可手动新建，或从已完成任务中保存。</p><button class="btn primary" data-nav="prompts" type="button">前往我的提示词</button></div></div>`;
        return;
      }
      body.innerHTML = list
        .map(
          (p) => `<div class="list-card">
          <h3>${escapeHtml(p.name)}</h3>
          <div class="meta-row">
            <span class="chip soft">${TYPE_LABEL[p.type]}</span>
            <span class="chip soft">${categoryLabel(p.category)}</span>
          </div>
          <p>${escapeHtml(p.content.slice(0, 120))}${p.content.length > 120 ? "…" : ""}</p>
          <div class="actions"><button class="btn sm primary" data-apply-personal="${p.id}" type="button">使用</button></div>
        </div>`
        )
        .join("");
      return;
    }
    const list = state.publicTemplates.filter((t) => t.status === "published");
    if (!list.length) {
      body.innerHTML = `<div class="empty-state"><div class="box"><h2>暂无已发布模板提示词</h2><p>请先在提示词管理中创建并发布。</p><button class="btn primary" data-nav="templates" type="button">前往模板提示词</button></div></div>`;
      return;
    }
    body.innerHTML = list
      .map(
        (t) => `<div class="list-card">
        <h3>${escapeHtml(t.name)} <span class="chip soft">v${t.version}</span></h3>
        <div class="meta-row">
          <span class="chip soft">${TYPE_LABEL[t.type]}</span>
          <span class="chip soft">${categoryLabel(t.category)}</span>
          ${isFavorited("public", t.id) ? `<span class="chip">已收藏</span>` : ""}
        </div>
        <p>${escapeHtml(t.desc || t.content.slice(0, 100))}</p>
        <div class="actions">
          <button class="btn sm primary" data-apply-public="${t.id}" type="button">使用</button>
          <button class="btn sm" data-fav-public="${t.id}" type="button">${isFavorited("public", t.id) ? "取消收藏" : "收藏"}</button>
        </div>
      </div>`
      )
      .join("");
  }

  /* ---------- Chat / Generate ---------- */
  function pushMessage(task, role, text, extra = {}) {
    const message = { id: uid("m"), role, text, time: nowLabel(), ...extra };
    task.messages.push(message);
    return message;
  }

  function isDeprecatedOptimizeNotice(message) {
    if (!message || message.role !== "system") return false;
    const text = String(message.text || "");
    return (
      text.includes("优化描述（Qwen") ||
      text.includes("已用选用提示词优化") ||
      text.includes("已优化描述（Qwen")
    );
  }

  function setTaskStatus(task, status) {
    task.status = status;
    task.updatedAt = Date.now();
  }

  function syncSendButton() {
    const btn = $("#btn-send");
    if (!btn) return;
    btn.classList.remove("is-running", "is-stopping");
    if (sendButtonMode === "stopping") {
      btn.textContent = "终止中…";
      btn.disabled = true;
      btn.classList.add("is-running", "is-stopping");
      btn.title = "正在终止";
      return;
    }
    if (activeGenerationToken) {
      btn.textContent = "运行中";
      btn.disabled = false;
      btn.classList.add("is-running");
      btn.title = "点击终止当前生成";
      return;
    }
    btn.textContent = "发送";
    btn.disabled = false;
    btn.title = "";
  }

  function setGenerationControlsBusy(busy) {
    // 生成中锁定输入；发送钮改为「运行中」，可点终止
    $("#composer-input").disabled = busy;
    const chatStream = $("#chat-stream");
    if (busy) chatStream.setAttribute("aria-busy", "true");
    else chatStream.removeAttribute("aria-busy");
    syncSendButton();
  }

  function acquireGenerationToken(task) {
    if (activeGenerationToken) {
      toast("已有生成任务进行中，可点击「运行中」终止");
      return null;
    }
    const operationToken = Symbol(task.id);
    activeGenerationToken = operationToken;
    activeAbortController = new AbortController();
    sendButtonMode = "running";
    setGenerationControlsBusy(true);
    return operationToken;
  }

  function releaseGenerationToken(operationToken) {
    if (activeGenerationToken === operationToken) {
      if (abortForceReleaseTimer) {
        clearTimeout(abortForceReleaseTimer);
        abortForceReleaseTimer = null;
      }
      activeGenerationToken = null;
      activeAbortController = null;
      sendButtonMode = "send";
      setGenerationControlsBusy(false);
    }
  }

  function abortActiveGeneration() {
    if (!activeGenerationToken || !activeAbortController) return;
    if (sendButtonMode === "stopping") return;
    const token = activeGenerationToken;
    sendButtonMode = "stopping";
    syncSendButton();
    activeAbortController.abort();
    toast("正在终止生成…");
    // 保险：若 fetch/上游未及时结束，强制释放前端锁，避免永久「运行中/处理中」
    if (abortForceReleaseTimer) clearTimeout(abortForceReleaseTimer);
    abortForceReleaseTimer = setTimeout(() => {
      abortForceReleaseTimer = null;
      if (activeGenerationToken !== token) return;
      releaseGenerationToken(token);
      const task = currentTask();
      if (task && (task.status === "running" || task.status === "queued")) {
        setTaskStatus(task, "idle");
        task.failReason = "";
        pushMessage(task, "system", "已终止当前生成，可修改描述或更换图片后重新发送。");
        saveState();
        renderWorkbench();
      } else {
        syncSendButton();
      }
      toast("已结束生成，可重新发送");
    }, 2500);
  }

  function isAbortError(error) {
    return (
      error?.name === "AbortError" ||
      /aborted|AbortError|The user aborted/i.test(String(error?.message || error || ""))
    );
  }

  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function onFileSelected(file) {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      toast("上传区域：仅支持 JPG / PNG / WebP");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast("文件需小于 20MB");
      return;
    }
    const task = currentTask();
    if (!task) {
      toast("请先创建任务");
      return;
    }
    const dataUrl = await readFileAsDataURL(file);
    pendingAttachments.set(task.id, { dataUrl, name: file.name });
    // 尚无版本时同步原图；已有版本时仅挂 pending，发送后开新版本，避免冲掉旧版原图
    if (!task.versions.length) {
      task.sourceImage = dataUrl;
    }
    task.updatedAt = Date.now();
    state.ui.compareMode = false;
    saveState();
    renderAttach();
    updateComposerGuide(task);
    renderWorkbench();
    toast(task.versions.length ? "已更换图片，发送后将基于新图生成新版本" : "已添加图片附件");
  }

  function clearAttach() {
    const task = currentTask();
    if (task) pendingAttachments.delete(task.id);
    renderAttach();
    updateComposerGuide(task);
  }

  function clearQuote() {
    clearTransientQuote();
    saveState();
    updateComposerGuide(currentTask());
  }

  function isQuoteOwnedByTask(task, quote) {
    if (!task || !quote?.image) return false;
    if (quote.kind === "source" || (!quote.versionId && !quote.draftId)) {
      return !!task.sourceImage && quote.image === task.sourceImage;
    }
    const version = task.versions.find((item) => item.id === quote.versionId);
    if (!version) return false;
    const match = (item) => item.id === quote.draftId && item.image === quote.image;
    return (
      version.drafts.some(match) ||
      (Array.isArray(version.steps) && version.steps.some(match))
    );
  }

  function validateBeforeSend(task, text, options = {}) {
    const pending = pendingAttachments.get(task.id);
    if (isBrandOrTrademarkRisk(text)) {
      return { ok: false, kind: "blocked", message: "内容安全拦截：检测到品牌标识/高风险描述。请修改文案或替换素材后新建任务。" };
    }
    if (state.ui.quoteRef && !isQuoteOwnedByTask(task, state.ui.quoteRef)) {
      clearTransientQuote();
      saveState();
      return { ok: false, kind: "invalid", message: "引用已失效或不属于当前任务，请重新选择引用图。" };
    }
    if (
      task.type === "img2img" &&
      !task.sourceImage &&
      !pending?.dataUrl &&
      !state.ui.quoteRef &&
      !task.versions.length
    ) {
      return { ok: false, kind: "invalid", message: "商品图加工需上传商品原图，请先点击「上传图片」。" };
    }
    if (options.fromQuickParams) {
      if (!hasQuickParamsContent(task) && !hasManagedPromptSource(task) && !pending?.dataUrl && !task.sourceImage) {
        return { ok: false, kind: "invalid", message: "请先填写快捷参数，或选用提示词后再生图。" };
      }
      return { ok: true };
    }
    if (!text && !pending?.dataUrl && !state.ui.quoteRef) {
      return { ok: false, kind: "invalid", message: "请输入描述，或上传/引用图片后发送。" };
    }
    if (state.ui.quoteRef && !text) {
      return { ok: false, kind: "invalid", message: "已引用图片，请补充本次要如何修改。" };
    }
    return { ok: true };
  }

  function openRefPicker() {
    const task = currentTask();
    if (!task) return toast("请先创建任务");
    const body = $("#ref-picker-body");
    const groups = [];
    refPickMap = {};
    if (task.sourceImage) {
      const item = { kind: "source", label: "原图", image: task.sourceImage, versionId: null, draftId: null };
      const key = uid("ref");
      refPickMap[key] = item;
      groups.push({ title: "原图（追溯起点）", items: [{ key, ...item }] });
    }
    task.versions.forEach((v) => {
      const seen = new Set();
      const items = [];
      const pushDraft = (d) => {
        if (!d?.id || !d?.image || seen.has(d.id)) return;
        seen.add(d.id);
        const item = {
          kind: "draft",
          label: d.label || `${v.name} · 图`,
          image: d.image,
          versionId: v.id,
          draftId: d.id,
        };
        const key = uid("ref");
        refPickMap[key] = item;
        items.push({ key, ...item });
      };
      (v.steps || []).forEach(pushDraft);
      v.drafts.forEach(pushDraft);
      groups.push({ title: `${v.name}${v.refLabel ? ` · 引自 ${v.refLabel}` : ""}`, items });
    });
    if (!groups.length) {
      body.innerHTML = `<div class="notice">暂无可引用图片。请先上传原图或完成一次生成。</div>`;
    } else {
      body.innerHTML = `<div class="ref-group">${groups
        .map(
          (g) => `<div><h4>${escapeHtml(g.title)}</h4><div class="ref-grid">${g.items
            .map(
              (it) => `<button class="ref-item" type="button" data-pick-ref="${it.key}" title="单击选用 · 双击预览并左右切换"><img src="${it.image}" alt="" /><span>${escapeHtml(it.label)}</span></button>`
            )
            .join("")}</div></div>`
        )
        .join("")}</div>`;
    }
    openOverlay("ref-overlay");
  }

  function pickQuoteRef(ref) {
    state.ui.quoteRef = ref;
    closeOverlay("ref-overlay");
    saveState();
    renderQuote();
    updateComposerGuide(currentTask());
    $("#composer-input").focus();
    toast(`已引用：${ref.label}。请说明保留什么、改什么`);
  }

  function renderQuote() {
    const box = $("#quote-preview");
    const ref = state.ui.quoteRef;
    if (ref?.image) {
      box.classList.remove("hidden");
      $("#quote-thumb").src = ref.image;
      $("#quote-label").textContent = ref.label;
    } else box.classList.add("hidden");
  }

  function renderAttach() {
    const box = $("#attach-preview");
    const uploadBtn = $("#btn-upload");
    const pending = pendingAttachments.get(currentTask()?.id);
    if (pending?.dataUrl) {
      box.classList.remove("hidden");
      $("#attach-thumb").src = pending.dataUrl;
      uploadBtn?.classList.add("is-filled");
    } else {
      box.classList.add("hidden");
      uploadBtn?.classList.remove("is-filled");
    }
  }

  /** 当前版本最近一张结果（同轮多张取末张） */
  function resolveLatestTipDraft(task) {
    const ver = getCurrentVersion(task);
    if (!ver?.drafts?.length) return null;
    return ver.drafts[ver.drafts.length - 1];
  }

  /** 用户提到「第N张」等但未点引用 → 目标不明确，需追问 */
  function isAmbiguousImageTargetText(text) {
    return /第\s*[一二三四五六七八九十\d]+\s*张|(?:左|右|上|下)(?:边|面)?(?:的)?那张|其中一[张幅]|随便[一张]/.test(
      String(text || ""),
    );
  }

  function resolveQuoteForGenerate(task) {
    if (state.ui.quoteRef) return state.ui.quoteRef;
    const ver = getCurrentVersion(task);
    // 未显式引用时默认最近一张，而不是「选中但可能是更早候选」
    const draft = resolveLatestTipDraft(task) || getSelectedDraft(task);
    if (draft && ver) {
      return {
        kind: "draft",
        label: `${ver.name} · ${draft.label}`,
        image: draft.image,
        versionId: ver.id,
        draftId: draft.id,
      };
    }
    if (task.sourceImage) {
      return { kind: "source", label: "原图", image: task.sourceImage, versionId: null, draftId: null };
    }
    return null;
  }

  function buildLineageNodes(task) {
    // 版本条只展示 V1/V2…，原图改由上方链路缩略图查看
    return (task.versions || []).map((v) => ({
      id: v.id,
      kind: "version",
      name: v.name,
      note: v.note || "",
      trace: v.refLabel ? `引用 ${v.refLabel} 后修改` : v.mode === "create" ? "初次生成" : "调整生成",
      image: v.drafts.find((d) => d.id === task.selectedDraftId)?.image || v.drafts[0]?.image,
      versionId: v.id,
      active: v.id === task.currentVersionId && !state.ui.compareMode && task.lineageFocus?.kind !== "source",
    }));
  }

  /** 指定版本可下载/可入库的全部图片（含历史步，不含原图） */
  function collectVersionExportItems(task, versionId = null) {
    if (!task) return [];
    const ver =
      task.versions.find((item) => item.id === (versionId || task.currentVersionId)) ||
      getCurrentVersion(task);
    if (!ver) return [];
    const nodes = buildBranchPathNodes({
      sourceImage: task.sourceImage,
      versions: task.versions,
      versionId: ver.id,
      selectedDraftId:
        ver.id === task.currentVersionId ? task.selectedDraftId : ver.drafts[0]?.id || null,
      messages: task.messages || [],
    }).filter((node) => node.kind !== "source" && node.image);
    const seen = new Set();
    return nodes
      .map((node, index) => ({
        id: `${ver.id}:${node.draftId || node.key || index}`,
        label: node.label || ver.name,
        image: node.image,
        versionId: ver.id,
        versionName: ver.name,
        draftId: node.draftId || null,
        stepOrder: index + 1,
      }))
      .filter((item) => {
        if (seen.has(item.image)) return false;
        seen.add(item.image);
        return true;
      });
  }

  /** 整个任务全部版本的可入库图片（按版本顺序，图片 URL 去重） */
  function collectTaskExportItems(task) {
    if (!task?.versions?.length) return [];
    const seen = new Set();
    const items = [];
    let order = 0;
    task.versions.forEach((ver) => {
      collectVersionExportItems(task, ver.id).forEach((item) => {
        if (seen.has(item.image)) return;
        seen.add(item.image);
        order += 1;
        items.push({ ...item, stepOrder: order });
      });
    });
    return items;
  }

  function focusPathNode(task, node) {
    if (!task || !node) return;
    state.ui.compareMode = false;
    if (node.kind === "source") {
      const ver = getCurrentVersion(task);
      const sourceImage =
        node.image || resolveVersionSourceImage(ver, task.sourceImage) || task.sourceImage;
      task.lineageFocus = { kind: "source", image: sourceImage };
      state.ui.compareMode = true;
    } else if (node.kind === "ancestor" || node.kind === "current" || node.kind === "candidate") {
      const ver =
        task.versions.find((item) => item.id === node.versionId) || getCurrentVersion(task);
      const image =
        node.image ||
        resolveVersionDraftImage(task, node.versionId || ver?.id, node.draftId) ||
        null;
      const inDrafts =
        !!node.draftId && !!ver?.drafts?.some((draft) => draft.id === node.draftId);
      // tip 轮候选（含同轮多张）可写 selectedDraftId；历史步/分支根走 lineageFocus
      if ((node.kind === "current" || node.kind === "candidate") && inDrafts) {
        task.lineageFocus = null;
        task.selectedDraftId = node.draftId;
        task.hdReady = false;
      } else if (image) {
        task.lineageFocus = {
          kind: "ancestor",
          versionId: node.versionId || ver?.id || null,
          draftId: node.draftId || null,
          image,
        };
      }
    }
    saveState();
    renderWorkbench();
  }

  function resolveCanvasImage(task) {
    if (!task) return null;
    if (state.ui.compareMode || task.lineageFocus?.kind === "source") {
      return (
        task.lineageFocus?.image ||
        resolveVersionSourceImage(getCurrentVersion(task), task.sourceImage) ||
        task.sourceImage ||
        null
      );
    }
    if (task.lineageFocus?.kind === "ancestor" && task.lineageFocus.image) {
      return task.lineageFocus.image;
    }
    if (task.hdReady && task.hdImage) return task.hdImage;
    return getSelectedDraft(task)?.image || null;
  }

  function confirmUnchangedRegenerate() {
    return window.confirm("参数与指令未变化，仍要重新生成？");
  }

  async function sendMessage(options = {}) {
    if (activeGenerationToken) {
      toast("已有生成任务进行中");
      return;
    }
    const p = currentProject();
    if (!p) return openCreateProject();
    let task = currentTask();
    if (!task) {
      seedWelcomeTask(p.id);
      task = currentTask();
    }
    task.params = collectParamsFromDrawer(options.fromQuickParams ? "drawer" : "composer");
    const text =
      options.textOverride != null
        ? String(options.textOverride).trim()
        : $("#composer-input").value.trim();
    const selectedCount = task.params.count;
    const resolvedCount = resolveOutputCount({
      selectedCount,
      text,
    });
    const countAdjusted = resolvedCount !== selectedCount;
    if (countAdjusted) {
      task.params.count = resolvedCount;
      $("#param-count").value = String(resolvedCount);
      const genCount = $("#gen-count");
      if (genCount) genCount.value = String(resolvedCount);
    }
    const check = validateBeforeSend(task, text, { fromQuickParams: !!options.fromQuickParams });
    if (!check.ok) {
      if (check.kind === "blocked") {
        setTaskStatus(task, "blocked");
        pushMessage(task, "system", check.message);
        saveState();
        renderWorkbench();
        toast("已拦截");
        return;
      }
      pushMessage(task, "system", check.message);
      saveState();
      renderWorkbench();
      toast(check.message);
      return;
    }

    let pending = pendingAttachments.get(task.id) || null;
    let quote = state.ui.quoteRef;
    const userText =
      text ||
      (task.type === "img2img" ? "请基于上传原图生成目标市场场景图。" : "请根据品类模板生成创意商品图。");
    const displayText = options.displayText || userText;

    const nextCategory = inferProductCategory(userText);
    if (
      shouldOpenNewTaskForProductChange({
        hasVersions: task.versions.length > 0,
        previousCategory: task.productCategory || null,
        nextCategory,
        hasQuote: !!quote,
        hasPendingUpload: !!pending?.dataUrl,
      })
    ) {
      const fromLabel = productCategoryLabel(task.productCategory);
      const toLabel = productCategoryLabel(nextCategory);
      pushMessage(
        task,
        "system",
        `检测到品类从「${fromLabel}」切换为「${toLabel}」，已自动新建任务继续（避免同窗串品类）。`,
      );
      saveState();
      task = startNewTask({
        silent: true,
        type: task.type,
        productCategory: nextCategory,
        title: `${toLabel}·${task.type === "img2img" ? "图生" : "文生"}`,
        welcomeText: `因品类切换自动新建任务（${toLabel}）。同品类修改请继续本任务；换品类请再开任务。`,
      });
      pending = pendingAttachments.get(task.id) || null;
      quote = state.ui.quoteRef;
    } else if (nextCategory && !task.productCategory) {
      task.productCategory = nextCategory;
    } else if (nextCategory && !task.versions.length) {
      task.productCategory = nextCategory;
    }
    refreshTaskTitle(task, userText);

    const hasVersions = task.versions.length > 0;
    // 已有版本后再上传原图：开新版本；否则默认 adjust，以便同 tip 续写
    const openNewFromReupload = shouldOpenNewVersionFromReupload({
      hasVersions,
      pendingDataUrl: pending?.dataUrl || null,
    });
    const generationMode = hasVersions && !openNewFromReupload ? "adjust" : "create";
    if (openNewFromReupload) {
      clearTransientQuote();
    }

    // 未显式引用却发修改指令：默认最近一张；仅当话术指向「某张」却未点引用时追问
    if (generationMode === "adjust" && !quote && !pending?.dataUrl) {
      const ver = getCurrentVersion(task);
      const tipCount = ver?.drafts?.length || 0;
      if (tipCount > 1 && isAmbiguousImageTargetText(userText)) {
        pushMessage(
          task,
          "system",
          "当前有多张可改结果。请先点击要改的那张「引用修改」，或说明要改链路里的哪一张后再发送。",
        );
        saveState();
        renderWorkbench();
        toast("请先指定要修改的图");
        return;
      }
      const autoQuote = resolveQuoteForGenerate(task);
      if (autoQuote?.image) {
        quote = autoQuote;
        task.selectedDraftId = autoQuote.draftId || task.selectedDraftId;
        pushMessage(
          task,
          "system",
          `未指定引用图，已默认基于最近一张「${autoQuote.label}」继续修改。`,
          { hideMeta: true },
        );
      }
    }

    const operationToken = acquireGenerationToken(task);
    if (!operationToken) return;

    let intentText = userText;
    let usedOptimize = false;
    // 立即生图且已选用提示词：强制走 Qwen（方案 B）
    const forceOptimize = !!options.fromQuickParams && hasManagedPromptSource(task);
    if (forceOptimize || shouldOptimizeUserText(task, userText)) {
      try {
        const withGuide = hasManagedPromptSource(task);
        toast(withGuide ? "正在用选用提示词优化描述…" : "正在优化描述…");
        const optimized = await optimizeUserTextWithPrompt(
          task,
          userText,
          activeAbortController?.signal,
        );
        intentText = optimized.text;
        usedOptimize = optimized.optimized;
      } catch (error) {
        if (isAbortError(error)) {
          releaseGenerationToken(operationToken);
          pushMessage(task, "system", "已终止文本优化。");
          saveState();
          renderWorkbench();
          toast("已终止");
          return;
        }
        // 优化失败时回退拼接，不阻断生图
        usedOptimize = false;
        intentText = userText;
        pushMessage(
          task,
          "system",
          `文本优化暂不可用（${formatGenerationError(error)}），已改用原始描述继续生成。`,
        );
      }
    }

    if (isBrandOrTrademarkRisk(intentText) || isBrandOrTrademarkRisk(userText)) {
      releaseGenerationToken(operationToken);
      setTaskStatus(task, "blocked");
      pushMessage(
        task,
        "system",
        "内容安全拦截：优化后的描述仍含品牌标识/高风险内容。请修改文案或新建任务。",
      );
      saveState();
      renderWorkbench();
      toast("已拦截");
      return;
    }

    const effectivePrompt = buildSendPrompt({
      task,
      generationMode,
      userIntentText: intentText,
      useOptimizedBody: usedOptimize,
    });
    if (!String(effectivePrompt || "").trim()) {
      releaseGenerationToken(operationToken);
      pushMessage(task, "system", "生成描述为空，请输入画面描述后再发送。");
      saveState();
      renderWorkbench();
      toast("请先填写描述");
      return;
    }
    task.effectivePrompt = effectivePrompt;

    // 引用非 tip：开新版本前提示，避免误以为在续写
    if (
      quote &&
      hasVersions &&
      !openNewFromReupload &&
      !findVersionToContinue({
        versions: task.versions,
        ref: quote,
        currentVersionId: task.currentVersionId,
        selectedDraftId: task.selectedDraftId,
      })
    ) {
      pushMessage(
        task,
        "system",
        `引用的「${quote.label || "历史图"}」不是当前版本最新图，将开新版本继续修改。`,
      );
    }

    const quoteForCompare =
      openNewFromReupload
        ? null
        : generationMode === "adjust"
          ? quote || resolveQuoteForGenerate(task)
          : quote;
    const requestSourceImage =
      generationMode === "create" || openNewFromReupload
        ? pending?.dataUrl || task.sourceImage
        : task.sourceImage;
    const previewRequest = buildGenerateRequest({
      prompt: effectivePrompt,
      sourceImage: requestSourceImage,
      referenceImage: quoteForCompare?.image,
      count: task.params.count,
      ratio: task.params.ratio,
      resolution: task.params.resolution,
      referenceOnly: generationMode === "adjust" && !!quoteForCompare?.image,
    });
    const previewPackage = {
      promptSnapshot: effectivePrompt,
      request: previewRequest,
    };
    if (
      task.lastGenerationInput &&
      isSameGenerationPackage(task.lastGenerationInput, previewPackage) &&
      !confirmUnchangedRegenerate()
    ) {
      releaseGenerationToken(operationToken);
      return;
    }

    // 快捷参数仅随本次生图带一次（保留比例/分辨率/张数/品类）
    consumeOneShotQuickParams(task);

    // 发送后立刻在用户消息中展示上传图，避免等待生成期间空白
    const attachImage = pending?.dataUrl || null;

    const userMessage = pushMessage(task, "user", displayText, {
      image: attachImage,
      quote: quote
        ? { label: quote.label, image: quote.image, versionId: quote.versionId, draftId: quote.draftId, kind: quote.kind }
        : null,
    });
    if (countAdjusted) {
      pushMessage(
        task,
        "system",
        `已按对话意图将生成张数调整为 ${resolvedCount} 张（多张将输出独立文件，非拼图）。`,
      );
    }
    pushMessage(task, "system", "", { promptPreview: effectivePrompt, hideMeta: true });
    if (attachImage) {
      // 重传开新版本前，先把旧原图冻进历史版本，避免 V1 路径被新图冲掉
      if (openNewFromReupload) {
        freezeMissingVersionSourceImages(task.versions, task.sourceImage);
      }
      task.sourceImage = attachImage;
    }
    if (!options.preserveComposer) {
      $("#composer-input").value = "";
    }
    pendingAttachments.delete(task.id);
    renderAttach();
    const quoteForGen = openNewFromReupload ? null : quote;
    $("#btn-adjust").dataset.pending = "0";
    clearTransientQuote();
    saveState();
    renderWorkbench();

    if (generationMode === "create") {
      await runGeneration(task, {
        mode: "create",
        note: userText,
        quote: quoteForGen,
        sourceImage: attachImage || task.sourceImage,
        userMessageId: userMessage.id,
        operationToken,
        changeChecked: true,
      });
    } else {
      await runGeneration(task, {
        mode: "adjust",
        note: userText,
        quote: quoteForGen || resolveQuoteForGenerate(task),
        sourceImage: attachImage || task.sourceImage,
        userMessageId: userMessage.id,
        operationToken,
        changeChecked: true,
      });
    }
  }

  async function runGeneration(task, {
    mode,
    note,
    quote = null,
    sourceImage = null,
    userMessageId = null,
    storedInput = null,
    operationToken = null,
    changeChecked = false,
  }) {
    if (operationToken) {
      if (activeGenerationToken !== operationToken) {
        toast("已有生成任务进行中");
        return;
      }
    } else {
      operationToken = acquireGenerationToken(task);
      if (!operationToken) return;
    }

    try {
      const isRetry = storedInput !== null;
      let generationInput;
      if (isRetry) {
        generationInput = cloneGenerationInput(storedInput);
        task.effectivePrompt = generationInput.promptSnapshot;
      } else {
        // create（含重传开新版本）不自动引用 tip；仅 adjust 才回落当前选中草稿
        const ref = quote || (mode === "adjust" ? resolveQuoteForGenerate(task) : null);
        const promptSnapshot = task.effectivePrompt;
        const requestSourceImage = sourceImage || task.sourceImage;
        // 引用修改只传被引用图，避免「原图+引用图」双输入时模型回退到原图外观（如紫色变回蓝色）
        const referenceOnly = !!ref?.image && (mode === "adjust" || !!ref.versionId || !!ref.draftId);
        const request = buildGenerateRequest({
          prompt: promptSnapshot,
          sourceImage: requestSourceImage,
          referenceImage: ref?.image,
          count: task.params.count,
          ratio: task.params.ratio,
          resolution: task.params.resolution,
          referenceOnly,
        });
        const primaryImage = referenceOnly ? ref.image : requestSourceImage;
        generationInput = {
          mode,
          note,
          ref,
          request,
          promptSnapshot,
          sourceInputIndex: primaryImage ? request.images.indexOf(primaryImage) : -1,
          userMessageId,
        };
      }

      const request = cloneGenerateRequest(generationInput.request);
      if (
        !isRetry &&
        !changeChecked &&
        task.lastGenerationInput &&
        isSameGenerationPackage(task.lastGenerationInput, generationInput) &&
        !confirmUnchangedRegenerate()
      ) {
        return;
      }
      retrySnapshots.set(task.id, cloneGenerationInput(generationInput));
      if (
        request.images.every(isLocalImageRoute) &&
        (!generationInput.ref?.image || isLocalImageRoute(generationInput.ref.image))
      ) {
        task.lastGenerationInput = cloneGenerationInput(generationInput);
      } else {
        delete task.lastGenerationInput;
      }

      // 单槽并发：请求等待期间保持「排队中」，避免瞬时假「生成中」
      setTaskStatus(task, "queued");
      sendButtonMode = "running";
      syncSendButton();
      renderWorkbench();
      saveState();

      if (!String(request.prompt || "").trim()) {
        throw new Error("生成描述为空，请输入画面描述后再发送。");
      }
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: activeAbortController?.signal,
      });
      if (!response.ok) {
        const errorBody = await response.json().catch(() => null);
        const statusHint =
          response.status === 429
            ? "生成任务正在处理中，请稍后重试。"
            : response.status === 400
              ? "请求参数不正确（常见原因：描述为空或超长）。"
              : "";
        throw new Error(errorBody?.error || statusHint || "生成失败，请稍后重试。");
      }

      const result = await response.json().catch(() => null);
      if (
        !Array.isArray(result?.images) ||
        result.images.length === 0 ||
        !result.images.every(isGeneratedImageRoute) ||
        !Array.isArray(result.inputImages) ||
        result.inputImages.length !== request.images.length ||
        !result.inputImages.every(isLocalImageRoute)
      ) {
        throw new Error("生成失败，请稍后重试。");
      }

      const localizedInput = cloneGenerationInput(generationInput);
      localizedInput.request.images = [...result.inputImages];
      if (localizedInput.ref?.image) {
        const refIndex = request.images.indexOf(localizedInput.ref.image);
        localizedInput.ref.image = result.inputImages[refIndex];
      }
      retrySnapshots.set(task.id, cloneGenerationInput(localizedInput));
      task.lastGenerationInput = cloneGenerationInput(localizedInput);

      const localSource = result.inputImages[localizedInput.sourceInputIndex];
      const ref = localizedInput.ref;
      mode = localizedInput.mode;
      note = localizedInput.note;
      const referenceOnlyForSource =
        !!ref?.image && (mode === "adjust" || !!ref.versionId || !!ref.draftId);
      // 仅首轮/重传 create 才更新任务原图；引用分支不得把引用图写进 task.sourceImage
      if (
        localSource &&
        !referenceOnlyForSource &&
        (task.versions.length === 0 || mode === "create")
      ) {
        task.sourceImage = localSource;
        const sourceMessage = task.messages.find((message) => message.id === localizedInput.userMessageId);
        if (sourceMessage?.image) sourceMessage.image = localSource;
      }
      // 版本原图：重传/首轮用本轮输入；分支沿用任务原图。禁止把引用图写成 sourceImage
      const versionSourceImage = resolveNewVersionSourceImage({
        mode,
        referenceOnly: referenceOnlyForSource,
        taskSourceImage: task.sourceImage,
        requestImages: localizedInput.request?.images || [],
        localizedInputImage: localSource,
      });
      const promptSnapshot = localizedInput.promptSnapshot;
      const isFirstSuccess = task.versions.length === 0;
      const templateSnapshot = task.promptSource
        ? { name: task.promptSource.name, version: task.promptSource.version, kind: task.promptSource.kind }
        : null;

      // 引用的是某版本最新一张 → 续写该版本链路，不新建 Vn（不依赖 mode，避免 failed 后误走 create）
      const continueVersion = findVersionToContinue({
        versions: task.versions,
        ref,
        currentVersionId: task.currentVersionId,
        selectedDraftId: task.selectedDraftId,
      });
      if (continueVersion) {
        console.log(`[version] continue ${continueVersion.name} tip=${ref?.draftId || "-"}`);
      } else if (ref?.versionId) {
        console.log(`[version] branch new from non-tip ref=${ref.versionId}/${ref.draftId || "-"}`);
      }

      let version;
      let continued = false;
      let drafts;
      if (continueVersion) {
        continued = true;
        const prevTip =
          continueVersion.drafts.find((draft) => draft.id === ref.draftId) || continueVersion.drafts[0];
        // 续写前补齐永久分支根，避免后续 parentVersionId 改成自身后丢棕裙等起点
        if (!continueVersion.branchRoot) {
          const recoveredRoot = resolveBranchRoot(
            continueVersion,
            task.messages || [],
            task.sourceImage,
            task.versions,
          );
          if (recoveredRoot) {
            const rootLabel = allocateVersionStepLabel(continueVersion, recoveredRoot.label);
            continueVersion.branchRoot = {
              id: recoveredRoot.id,
              image: recoveredRoot.image,
              label: rootLabel,
              fromVersionId: recoveredRoot.fromVersionId || null,
              parentImage: recoveredRoot.parentImage || task.sourceImage || null,
            };
            continueVersion.branchFromVersionId = recoveredRoot.fromVersionId || null;
            continueVersion.branchFromDraftId = recoveredRoot.id || null;
            if (
              !(continueVersion.steps || []).some(
                (step) => step.image === recoveredRoot.image || step.id === recoveredRoot.id,
              )
            ) {
              continueVersion.steps = [
                {
                  id: recoveredRoot.id,
                  image: recoveredRoot.image,
                  label: rootLabel,
                  fromVersionId: recoveredRoot.fromVersionId || null,
                  parentImage: recoveredRoot.parentImage || task.sourceImage || null,
                },
                ...(continueVersion.steps || []),
              ];
            }
          }
        }
        // 旧任务无 steps：先把仍挂着的上一张 refImage 收进链路，避免再丢中间图
        if (
          !(continueVersion.steps?.length > 0) &&
          continueVersion.refImage &&
          prevTip?.image &&
          continueVersion.refImage !== prevTip.image &&
          continueVersion.refImage !== continueVersion.branchRoot?.image
        ) {
          archiveVersionTip(continueVersion, {
            id: continueVersion.parentDraftId || uid("step"),
            image: continueVersion.refImage,
            label: continueVersion.refLabel || null,
          });
        }
        const archived = archiveVersionTip(continueVersion, prevTip);
        let nextStep = nextVersionStepIndex(continueVersion);
        drafts = result.images.map((image) => {
          const label = formatVersionStepLabel(continueVersion.name, nextStep);
          nextStep += 1;
          return { id: uid("draft"), label, image };
        });
        continueVersion.mode = mode;
        continueVersion.note = note;
        continueVersion.updatedAt = Date.now();
        continueVersion.drafts = drafts;
        continueVersion.parentVersionId = continueVersion.id;
        continueVersion.parentDraftId = archived?.id || prevTip?.id || ref.draftId || null;
        continueVersion.refLabel = archived?.label || prevTip?.label || ref.label || null;
        continueVersion.refImage = archived?.image || prevTip?.image || ref.image || null;
        continueVersion.promptSnapshot = promptSnapshot;
        continueVersion.templateSnapshot = templateSnapshot;
        if (!continueVersion.sourceImage) {
          continueVersion.sourceImage = resolveVersionSourceImage(continueVersion, task.sourceImage);
        }
        version = continueVersion;
      } else {
        const versionIndex = task.versions.length + 1;
        const versionName = `V${versionIndex}`;
        // 新分支：引用父图（如棕裙）永久写入 branchRoot = Vn.0_1，首张生成从 Vn.0_2 起
        const branchRoot = createBranchRootStep(versionName, ref, versionSourceImage);
        const versionStub = { name: versionName, steps: branchRoot ? [branchRoot] : [], branchRoot };
        let nextStep = nextVersionStepIndex(versionStub);
        drafts = result.images.map((image) => {
          const label = formatVersionStepLabel(versionName, nextStep);
          nextStep += 1;
          return { id: uid("draft"), label, image };
        });
        version = {
          id: uid("ver"),
          name: versionName,
          mode,
          note,
          createdAt: Date.now(),
          sourceImage: versionSourceImage,
          drafts,
          steps: branchRoot ? [branchRoot] : [],
          branchRoot: branchRoot
            ? {
                id: branchRoot.id,
                image: branchRoot.image,
                label: branchRoot.label,
                fromVersionId: branchRoot.fromVersionId || null,
                parentImage: branchRoot.parentImage || versionSourceImage || null,
              }
            : null,
          branchFromVersionId: branchRoot?.fromVersionId || null,
          branchFromDraftId: branchRoot?.id || null,
          parentVersionId: ref?.versionId || null,
          parentDraftId: ref?.draftId || null,
          refLabel: branchRoot?.label || ref?.label || (mode === "create" && versionSourceImage ? "原图" : null),
          refImage: branchRoot?.image || ref?.image || versionSourceImage || null,
          promptSnapshot,
          templateSnapshot,
        };
        task.versions.push(version);
      }
      task.currentVersionId = version.id;
      task.selectedDraftId = drafts[0]?.id || null;
      task.lineageFocus = null;
      task.hdReady = false;
      task.hdImage = null;
      const catTitle = categoryLabel(task.params.category) || (task.type === "img2img" ? "商品图" : "创意图");
      task.title = task.type === "img2img" ? `${catTitle} · 场景图` : `${catTitle} · 创意图`;
      setTaskStatus(task, "success");

      const tplHint = version.templateSnapshot
        ? `（模板：${version.templateSnapshot.name}${version.templateSnapshot.version ? ` v${version.templateSnapshot.version}` : ""}）`
        : "";
      if (drafts.length > 1) {
        pushMessage(
          task,
          "system",
          continued
            ? `已在 ${version.name} 链路更新，共 ${drafts.length} 张（已拆开，可分别引用）。`
            : mode === "adjust"
              ? `已基于「${ref?.label || "上一版"}」生成 ${version.name}，共 ${drafts.length} 张（已拆开，可分别引用）。`
              : `已生成 ${version.name}，共 ${drafts.length} 张${tplHint}（已拆开，可分别引用）。`,
        );
      }
      drafts.forEach((draft) => {
        const text =
          drafts.length === 1
            ? continued
              ? `已在 ${version.name} 链路更新。`
              : mode === "adjust"
                ? `已基于「${ref?.label || "上一版"}」生成 ${version.name}。`
                : `已生成 ${version.name}${tplHint}。`
            : `${version.name} · ${draft.label}`;
        pushMessage(task, "ai", text, {
          versionId: version.id,
          draftId: draft.id,
          drafts: [{ id: draft.id, label: draft.label, image: draft.image }],
        });
      });
      if (isFirstSuccess) {
        pushMessage(
          task,
          "system",
          "可继续：引用修改、批量下载、保存素材库，或新建任务。",
        );
      }
      saveState();
      renderWorkbench();
      toast(
        continued
          ? `已更新 ${version.name}`
          : mode === "adjust"
            ? `已生成 ${version.name}`
            : "草稿已生成",
      );
    } catch (error) {
      if (isAbortError(error)) {
        setTaskStatus(task, "idle");
        task.failReason = "";
        pushMessage(task, "system", "已终止当前生成，可修改描述或更换图片后重新发送。");
        saveState();
        renderWorkbench();
        toast("已终止生成");
      } else {
        setTaskStatus(task, "failed");
        task.failReason = formatGenerationError(error);
        pushMessage(task, "system", task.failReason);
        saveState();
        renderWorkbench();
        toast(task.failReason);
      }
    } finally {
      releaseGenerationToken(operationToken);
    }
  }

  function formatGenerationError(error) {
    const raw = String(error?.message || error || "").trim();
    if (/API[_\s-]?KEY|密钥|未配置|DASHSCOPE|Missing/i.test(raw)) {
      return "服务未配置有效密钥，请检查本地 .env 后重启再试。";
    }
    if (/超时|timeout|abort/i.test(raw)) {
      return "生成超时，请稍后重试，或简化描述后再试。";
    }
    if (/图片|image|upload|过大|格式|MIME|Base64/i.test(raw)) {
      return "图片无效或过大，请更换上传图后重试。";
    }
    if (/正在处理中|排队/.test(raw)) {
      return "上一笔生成仍在服务端收尾，请稍候 2～3 秒再发送；若刚点过终止，一般会很快释放。";
    }
    if (/429|限流|频率|Too Many/i.test(raw)) {
      return "请求过于频繁，请稍后再试。";
    }
    if (/网络|fetch failed|Failed to fetch|ECONN|ENOTFOUND/i.test(raw)) {
      return "网络异常，请确认本地服务已启动后重试。";
    }
    if (raw && raw !== "生成失败，请稍后重试。" && raw.length <= 120) return raw;
    return "生成失败，请检查网络后重试，或修改描述后再试。";
  }

  function findVersionDraft(version, draftId, imageHint = null) {
    if (!version) return null;
    if (draftId) {
      const byId =
        version.drafts?.find((draft) => draft.id === draftId) ||
        version.steps?.find((step) => step.id === draftId) ||
        (version.branchRoot?.id === draftId ? version.branchRoot : null) ||
        null;
      if (byId) return byId;
    }
    if (imageHint) {
      return (
        version.drafts?.find((draft) => draft.image === imageHint) ||
        version.steps?.find((step) => step.image === imageHint) ||
        (version.branchRoot?.image === imageHint ? version.branchRoot : null) ||
        null
      );
    }
    return null;
  }

  function resolveVersionDraftImage(task, versionId, draftId, imageHint = null) {
    const version = task?.versions?.find((item) => item.id === versionId);
    return findVersionDraft(version, draftId, imageHint)?.image || imageHint || null;
  }

  /** 选中对话/链路中的某张图：当前 tip 进 selectedDraft；历史步骤进 lineageFocus */
  function focusTaskDraft(task, { versionId, draftId, image = null, label = "" } = {}) {
    if (!task || !versionId) return null;
    const version = task.versions.find((item) => item.id === versionId);
    if (!version) return null;
    // 点哪张就以哪张图为准，避免 draftId 对不上 steps 时回落到 tip（绿图）
    const found = findVersionDraft(version, draftId, image);
    const resolvedImage = image || found?.image || null;
    const resolvedLabel = found?.label || label || "生成结果";
    task.currentVersionId = versionId;
    task.hdReady = false;
    state.ui.compareMode = false;
    if (found && version.drafts.some((draft) => draft.id === found.id) && found.image === resolvedImage) {
      task.selectedDraftId = found.id;
      task.lineageFocus = null;
    } else if (resolvedImage) {
      task.lineageFocus = {
        kind: "ancestor",
        versionId,
        draftId: found?.id || draftId || null,
        image: resolvedImage,
      };
    }
    return { image: resolvedImage, label: resolvedLabel, version };
  }

  function resolveAssistantResultDrafts(task, message) {
    if (!task || !message?.versionId) return [];
    const version = task.versions.find((item) => item.id === message.versionId);
    const fromVersion = Array.isArray(version?.drafts) ? version.drafts : [];
    const fromSteps = Array.isArray(version?.steps) ? version.steps : [];
    const fromMessage = Array.isArray(message.drafts) ? message.drafts : [];
    let source = fromMessage.length ? fromMessage : fromVersion;
    // 单图消息：优先用消息自身草稿，避免续写后 version.drafts 只剩 tip 时串图
    if (message.draftId) {
      const matched =
        fromMessage.find((draft) => draft.id === message.draftId) ||
        fromSteps.find((draft) => draft.id === message.draftId) ||
        fromVersion.find((draft) => draft.id === message.draftId);
      source = matched ? [matched] : source.filter((draft) => draft.id === message.draftId);
    }
    return source.filter((draft) => draft?.image && isGeneratedImageRoute(draft.image));
  }

  function resolveAssistantFeaturedDraft(task, message) {
    const drafts = resolveAssistantResultDrafts(task, message);
    if (!drafts.length) return { drafts, featured: null, label: "" };

    const isCurrentVersion = task.currentVersionId === message.versionId;
    const featured = drafts[0];
    if (
      isCurrentVersion &&
      task.hdReady &&
      isGeneratedImageRoute(task.hdImage) &&
      featured.image === task.hdImage
    ) {
      return { drafts, featured: { ...featured, image: task.hdImage }, label: "成品" };
    }

    return {
      drafts,
      featured,
      label: message.draftId && drafts.length === 1 ? featured.label || "生成结果" : "生成结果",
    };
  }

  /** 灯箱图集：多图时左右键 / 按钮 / 滚轮 / 底栏横滑 / 触控滑动 */
  let lightboxGallery = { items: [], index: 0 };
  let lightboxTouchX = null;
  let lightboxDragX = null;
  let lightboxWheelLockUntil = 0;

  function normalizeLightboxItems(items = []) {
    const seen = new Set();
    const list = [];
    for (const item of items) {
      const image = item?.image || item?.src || null;
      if (!image || seen.has(image)) continue;
      seen.add(image);
      list.push({
        image,
        title: item.title || item.label || "图片预览",
        metaHtml: item.metaHtml || null,
      });
    }
    return list;
  }

  function collectPathLightboxItems(task) {
    if (!task) return [];
    const ver = getCurrentVersion(task);
    if (!ver) {
      return task.sourceImage
        ? normalizeLightboxItems([{ image: task.sourceImage, title: "原图" }])
        : [];
    }
    return normalizeLightboxItems(
      buildBranchPathNodes({
        sourceImage: task.sourceImage,
        versions: task.versions,
        versionId: ver.id,
        selectedDraftId: task.selectedDraftId,
        messages: task.messages || [],
      }).map((node) => ({ image: node.image, title: node.label || "生成结果" })),
    );
  }

  function collectVersionLightboxItems(task, versionId = null) {
    if (!task) return [];
    const version =
      task.versions.find((item) => item.id === (versionId || task.currentVersionId)) ||
      getCurrentVersion(task);
    if (!version) return collectPathLightboxItems(task);
    const items = [];
    if (task.sourceImage) items.push({ image: task.sourceImage, title: "原图" });
    (version.steps || []).forEach((step) => {
      if (step?.image) items.push({ image: step.image, title: step.label || version.name });
    });
    (version.drafts || []).forEach((draft) => {
      if (draft?.image) items.push({ image: draft.image, title: draft.label || version.name });
    });
    const pathItems = collectPathLightboxItems(task);
    return normalizeLightboxItems([...pathItems, ...items]);
  }

  function collectTaskLightboxItems(task) {
    if (!task) return [];
    const items = [...collectPathLightboxItems(task)];
    (task.versions || []).forEach((version) => {
      (version.steps || []).forEach((step) => {
        if (step?.image) items.push({ image: step.image, title: step.label || version.name });
      });
      (version.drafts || []).forEach((draft) => {
        if (draft?.image) items.push({ image: draft.image, title: draft.label || version.name });
      });
    });
    (task.messages || []).forEach((message) => {
      if (message.role === "ai") {
        (message.drafts || []).forEach((draft) => {
          if (draft?.image) items.push({ image: draft.image, title: draft.label || "生成结果" });
        });
      }
      if (message.quote?.image) {
        items.push({ image: message.quote.image, title: message.quote.label || "引用图" });
      }
      if (message.image) items.push({ image: message.image, title: "上传图" });
    });
    return normalizeLightboxItems(items);
  }

  function collectRefPickerLightboxItems() {
    return normalizeLightboxItems(
      Object.values(refPickMap || {}).map((item) => ({
        image: item.image,
        title: item.label || "可引用图",
      })),
    );
  }

  function assetLightboxMeta(asset) {
    const enriched = enrichAsset(asset);
    return `<strong>${escapeHtml(asset.title || "素材")}</strong><br/>
            任务：${escapeHtml(enriched.taskTitle)} · ${escapeHtml(TYPE_LABEL[enriched.type] || enriched.type)}<br/>
            生图人 ${escapeHtml(enriched.createdBy)} · ${new Date(asset.createdAt).toLocaleString()} · ${escapeHtml(asset.versionName || "")}<br/>
            模板：${asset.promptSource ? escapeHtml(asset.promptSource.name || "") : "空白创建"}
            ${asset.promptSource?.version ? ` v${asset.promptSource.version}` : ""}<br/>
            <span class="help">品牌 Logo / 文字细节需人工复核</span>`;
  }

  function collectAssetLightboxItems(startAsset, groupAssets = null) {
    if (!startAsset) return [];
    const p = currentProject();
    const assets = p ? projectAssets(p.id) : [];
    const startTaskId = startAsset.taskId || "unknown";
    const startDate = dateKeyFromTs(startAsset.createdAt);
    const siblings = assets.filter(
      (asset) =>
        (asset.taskId || "unknown") === startTaskId &&
        dateKeyFromTs(asset.createdAt) === startDate,
    );
    const pool =
      Array.isArray(groupAssets) && groupAssets.length
        ? groupAssets
        : siblings.length > 1
          ? siblings
          : assets.length > 1
            ? assets
            : [startAsset];
    const ordered = [...pool].sort((a, b) => a.createdAt - b.createdAt);
    return normalizeLightboxItems(
      ordered.map((asset) => ({
        image: asset.image,
        title: asset.title || "素材",
        metaHtml: assetLightboxMeta(asset),
      })),
    );
  }

  function collectAssetStripLightboxItems(startBtn) {
    const strip = startBtn?.closest?.(".asset-strip");
    if (!strip) return null;
    const ids = [...strip.querySelectorAll("[data-preview]")]
      .map((btn) => btn.dataset.preview)
      .filter(Boolean);
    const group = ids
      .map((id) => state.assets.find((asset) => asset.id === id))
      .filter(Boolean);
    return group.length ? group : null;
  }

  function renderLightbox() {
    const items = lightboxGallery.items;
    const index = lightboxGallery.index;
    const current = items[index];
    if (!current) {
      closeLightbox();
      return;
    }
    $("#lightbox-image").src = current.image;
    const multi = items.length > 1;
    const countHtml = multi
      ? `<div class="lightbox-count">${index + 1} / ${items.length} · 左右键 / 滚轮 / 底栏滑动切换</div>`
      : `<span class="help">点击空白处或关闭按钮退出</span>`;
    $("#lightbox-meta").innerHTML = current.metaHtml
      ? `${current.metaHtml}<br/>${countHtml}`
      : `<strong>${escapeHtml(current.title || "图片预览")}</strong><br/>${countHtml}`;
    const prevBtn = $("#btn-lightbox-prev");
    const nextBtn = $("#btn-lightbox-next");
    if (prevBtn) prevBtn.hidden = !multi;
    if (nextBtn) nextBtn.hidden = !multi;
    const strip = $("#lightbox-filmstrip");
    if (strip) {
      if (!multi) {
        strip.hidden = true;
        strip.innerHTML = "";
      } else {
        strip.hidden = false;
        strip.innerHTML = items
          .map(
            (item, i) =>
              `<button class="lightbox-filmstrip-item${i === index ? " active" : ""}" type="button" data-lightbox-index="${i}" title="${escapeAttr(item.title || "")}"><img src="${item.image}" alt="" /></button>`,
          )
          .join("");
        const activeThumb = strip.querySelector(".lightbox-filmstrip-item.active");
        activeThumb?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
      }
    }
    $("#lightbox").classList.add("open");
    $("#lightbox").focus({ preventScroll: true });
  }

  function openImageLightbox(image, title = "图片预览", galleryItems = null) {
    if (!image && !galleryItems?.length) return;
    let items = normalizeLightboxItems(galleryItems || []);
    if (!items.length && image) {
      // 未显式传入图集时，尽量用当前任务链路做全局多图切换
      const taskGallery = collectTaskLightboxItems(currentTask());
      items = taskGallery.some((item) => item.image === image)
        ? taskGallery
        : [{ image, title: title || "图片预览" }];
    } else if (image && !items.some((item) => item.image === image)) {
      items.unshift({ image, title: title || "图片预览" });
    }
    const index = Math.max(
      0,
      items.findIndex((item) => item.image === image),
    );
    lightboxGallery = { items, index: index < 0 ? 0 : index };
    renderLightbox();
  }

  function closeLightbox() {
    $("#lightbox").classList.remove("open");
    lightboxGallery = { items: [], index: 0 };
    lightboxTouchX = null;
    lightboxDragX = null;
  }

  function stepLightbox(delta) {
    const total = lightboxGallery.items.length;
    if (total <= 1) return;
    lightboxGallery.index = (lightboxGallery.index + delta + total) % total;
    renderLightbox();
  }

  function jumpLightbox(index) {
    if (!lightboxGallery.items.length) return;
    const next = Number(index);
    if (!Number.isInteger(next) || next < 0 || next >= lightboxGallery.items.length) return;
    lightboxGallery.index = next;
    renderLightbox();
  }

  function renderGeneratingPlaceholder(task) {
    const count = normalizeCount(task?.params?.count);
    return Array.from({ length: count }, (_, index) => {
      const title = count > 1 ? `生成中… 图 ${index + 1}` : "生成中…";
      return `<div class="msg-row">
      <div class="msg ai generating">
        <div class="msg-result">
          <div class="msg-result-label">${title}</div>
          <div class="msg-draft-skel featured" aria-hidden="true"></div>
        </div>
        <div class="meta">助手 · 请稍候</div>
      </div>
    </div>`;
    }).join("");
  }

  function renderAssistantResultHtml(task, message) {
    const { featured, label } = resolveAssistantFeaturedDraft(task, message);
    if (!featured?.image) return "";

    return `<div class="msg-result">
      <div class="msg-result-label">${escapeHtml(label || "生成结果")}</div>
      <button class="msg-result-hero" type="button" title="${escapeAttr(featured.label || "生成结果")}" data-msg-version="${escapeAttr(message.versionId || "")}" data-msg-draft="${escapeAttr(featured.id || "")}"><img src="${featured.image}" alt="${escapeAttr(featured.label || "生成结果")}" /></button>
    </div>`;
  }

  function getCurrentVersion(task) {
    if (!task) return null;
    return task.versions.find((v) => v.id === task.currentVersionId) || task.versions[task.versions.length - 1] || null;
  }
  function getSelectedDraft(task) {
    const ver = getCurrentVersion(task);
    if (!ver) return null;
    return ver.drafts.find((d) => d.id === task.selectedDraftId) || ver.drafts[0] || null;
  }
  function selectDraft(draftId) {
    const task = currentTask();
    if (!task) return;
    task.selectedDraftId = draftId;
    task.lineageFocus = null;
    task.hdReady = false;
    state.ui.compareMode = false;
    saveState();
    renderWorkbench();
  }
  function selectVersion(versionId) {
    const task = currentTask();
    if (!task) return;
    const ver = task.versions.find((v) => v.id === versionId);
    if (!ver) return;
    // 切换版本时按对话引用链重算 branchRoot/steps，纠正历史错乱映射
    repairVersionLineageFromMessages(
      ver,
      task.messages || [],
      ver.drafts[0]?.id || task.selectedDraftId,
      [],
      task.sourceImage,
      task.versions,
    );
    task.currentVersionId = ver.id;
    task.selectedDraftId = ver.drafts[0]?.id || null;
    task.lineageFocus = null;
    task.hdReady = false;
    state.ui.compareMode = false;
    saveState();
    renderWorkbench();
  }

  function confirmHD() {
    const task = currentTask();
    const draft = getSelectedDraft(task);
    if (!task || !draft) return toast("请先选择一张草稿");
    if (task.status !== "success") return;
    task.hdReady = true;
    task.hdImage = draft.image;
    pushMessage(
      task,
      "system",
      `已确认成品（${getCurrentVersion(task)?.name || ""} · ${draft.label}）。可保存或下载。`
    );
    saveState();
    renderWorkbench();
    toast("已确认成品");
  }

  function saveToLibrary() {
    const task = currentTask();
    const p = currentProject();
    if (!task || !p) return;
    const ver = getCurrentVersion(task);
    const items = collectTaskExportItems(task);
    if (!items.length) return toast("当前任务暂无可保存图片");

    // 清掉本任务误存的原图，并按图片 URL 去重后补齐任务内全部样式
    state.assets = state.assets.filter((asset) => {
      if (asset.projectId !== p.id || asset.taskId !== task.id) return true;
      if (task.sourceImage && asset.image === task.sourceImage) return false;
      return true;
    });
    const existing = new Set(
      state.assets
        .filter((asset) => asset.projectId === p.id && asset.taskId === task.id)
        .map((asset) => asset.image),
    );
    const now = Date.now();
    let added = 0;
    items.forEach((item, index) => {
      const itemVer = task.versions.find((v) => v.id === item.versionId) || ver;
      if (existing.has(item.image)) {
        state.assets.forEach((asset) => {
          if (asset.projectId === p.id && asset.taskId === task.id && asset.image === item.image) {
            asset.stepLabel = item.label;
            asset.stepOrder = item.stepOrder;
            asset.versionName = item.versionName || itemVer?.name;
            asset.title = `${task.title || "生成素材"} · ${item.label}`;
          }
        });
        return;
      }
      existing.add(item.image);
      state.assets.unshift({
        id: uid("asset"),
        projectId: p.id,
        taskId: task.id,
        taskTitle: task.title || "未命名任务",
        type: task.type || "img2img",
        createdBy: USER_NAME,
        title: `${task.title || "生成素材"} · ${item.label}`,
        image: item.image,
        isHD: !!(task.hdReady && task.hdImage === item.image),
        createdAt: now + index,
        promptSource: itemVer?.templateSnapshot || task.promptSource,
        versionName: item.versionName || itemVer?.name,
        stepLabel: item.label,
        stepOrder: item.stepOrder,
        effectivePrompt: itemVer?.promptSnapshot || task.effectivePrompt,
        params: task.params,
        sourceImage: task.sourceImage,
      });
      added += 1;
    });
    if (!added) {
      saveState();
      toast("该任务图片已在素材库中（已同步标签）");
      if (state.ui.view === "assets") renderAssetsPage();
      return;
    }
    pushMessage(task, "system", `已将本任务共 ${added} 张保存到素材库「${p.name}」。`);
    saveState();
    renderWorkbench();
    toast(`已保存 ${added} 张到素材库`);
  }

  function dateKeyFromTs(ts) {
    const d = new Date(ts || Date.now());
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function dateLabelFromKey(dateKey) {
    const today = dateKeyFromTs(Date.now());
    const yest = new Date();
    yest.setDate(yest.getDate() - 1);
    const yesterday = dateKeyFromTs(yest.getTime());
    if (dateKey === today) return `今天 · ${dateKey}`;
    if (dateKey === yesterday) return `昨天 · ${dateKey}`;
    return dateKey;
  }

  function timeLabelFromTs(ts) {
    const d = new Date(ts || Date.now());
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  function fileSafeName(value, fallback = "item") {
    const text = String(value || fallback)
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, "_")
      .slice(0, 48);
    return text || fallback;
  }

  function enrichAsset(asset) {
    const task = state.tasks.find((item) => item.id === asset.taskId);
    return {
      ...asset,
      taskTitle: asset.taskTitle || task?.title || "未命名任务",
      type: asset.type || task?.type || "img2img",
      createdBy: asset.createdBy || USER_NAME,
    };
  }

  /** 日期 → 任务包 → 多图（包内按图片 URL 去重） */
  function buildAssetDayTaskGroups(assets) {
    const byDate = new Map();
    dedupeAssetsList(assets).map(enrichAsset).forEach((asset) => {
      const dateKey = dateKeyFromTs(asset.createdAt);
      if (!byDate.has(dateKey)) byDate.set(dateKey, new Map());
      const byTask = byDate.get(dateKey);
      const taskId = asset.taskId || "unknown";
      if (!byTask.has(taskId)) byTask.set(taskId, []);
      byTask.get(taskId).push(asset);
    });

    return [...byDate.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([dateKey, taskMap]) => {
        const taskGroups = [...taskMap.entries()]
          .map(([taskId, items]) => {
            const unique = [];
            const seen = new Set();
            [...items]
              .sort((a, b) => {
                const ao = a.stepOrder;
                const bo = b.stepOrder;
                if (ao != null && bo != null && ao !== bo) return ao - bo;
                return a.createdAt - b.createdAt;
              })
              .forEach((item) => {
                if (!item.image || seen.has(item.image)) return;
                seen.add(item.image);
                unique.push(item);
              });
            const latestAt = Math.max(...unique.map((item) => item.createdAt || 0), 0);
            const head = unique[unique.length - 1] || unique[0];
            return {
              taskId,
              taskTitle: head.taskTitle,
              type: head.type,
              createdBy: head.createdBy,
              assets: unique,
              latestAt,
            };
          })
          .sort((a, b) => b.latestAt - a.latestAt);
        return {
          dateKey,
          label: dateLabelFromKey(dateKey),
          taskGroups,
          totalCount: taskGroups.reduce((sum, group) => sum + group.assets.length, 0),
        };
      });
  }

  async function resolveImageBytes(src) {
    const response = await fetch(src);
    if (!response.ok) throw new Error("读取素材失败");
    return new Uint8Array(await response.arrayBuffer());
  }

  async function exportTaskPack(dateKey, taskId) {
    const project = currentProject();
    if (!project) return;
    const day = buildAssetDayTaskGroups(projectAssets(project.id)).find((item) => item.dateKey === dateKey);
    const pack = day?.taskGroups.find((item) => item.taskId === taskId);
    if (!pack?.assets?.length) {
      toast("没有可下载的素材");
      return;
    }
    toast("正在打包下载…");
    try {
      const files = [];
      for (let i = 0; i < pack.assets.length; i += 1) {
        const asset = pack.assets[i];
        const bytes = await resolveImageBytes(asset.image);
        const stamp = timeLabelFromTs(asset.createdAt).replace(":", "");
        const ver = fileSafeName(asset.versionName || "V", "V");
        const ext = /\.jpe?g($|\?)/i.test(asset.image) ? "jpg" : "png";
        files.push({
          name: `${String(i + 1).padStart(2, "0")}_${stamp}_${ver}.${ext}`,
          data: bytes,
        });
      }
      const blob = zipBlobFromFiles(files);
      const a = document.createElement("a");
      const url = URL.createObjectURL(blob);
      a.href = url;
      a.download = `${fileSafeName(project.name, "project")}_${fileSafeName(pack.taskTitle, "task")}_${dateKey}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast(`已下载 ${pack.assets.length} 张（ZIP）`);
    } catch (error) {
      toast(error?.message || "下载失败，请稍后重试");
    }
  }

  function openBatchDownload() {
    const task = currentTask();
    const ver = getCurrentVersion(task);
    const items = collectVersionExportItems(task);
    if (!task || !ver || !items.length) return toast("当前版本暂无可下载图片");
    const body = $("#batch-download-body");
    const hint = $("#batch-download-hint");
    if (hint) {
      hint.textContent = `选择 ${ver.name} 下要下载的图片（含历史步骤），可单选或多选；多张将打包为 ZIP。`;
    }
    const focusImage = resolveCanvasImage(task);
    const selectedId =
      items.find((item) => item.image === focusImage)?.id ||
      items.find((item) => item.draftId && item.draftId === task.selectedDraftId)?.id ||
      items[items.length - 1]?.id;
    const versionGallery = normalizeLightboxItems(
      items.map((item) => ({ image: item.image, title: item.label || "图" })),
    );
    body.innerHTML = items
      .map(
        (item) => `<label class="batch-download-item${item.id === selectedId ? " on" : ""}">
          <button class="batch-download-thumb" type="button" data-view-image="${escapeAttr(item.image)}" data-view-title="${escapeAttr(item.label || "图")}" title="查看大图，可左右切换">
            <img src="${item.image}" alt="" />
          </button>
          <span class="cap">
            <input type="checkbox" data-batch-item="${escapeAttr(item.id)}" ${item.id === selectedId ? "checked" : ""} />
            ${escapeHtml(item.label || "图")}
          </span>
        </label>`,
      )
      .join("");
    body.querySelectorAll(".batch-download-item").forEach((item) => {
      const input = item.querySelector("input");
      item.querySelector("[data-view-image]")?.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const btn = e.currentTarget;
        openImageLightbox(
          btn.dataset.viewImage,
          btn.dataset.viewTitle || "图",
          versionGallery,
        );
      });
      item.addEventListener("click", (e) => {
        if (e.target === input || e.target.closest("[data-view-image]")) {
          item.classList.toggle("on", input.checked);
          return;
        }
        e.preventDefault();
        input.checked = !input.checked;
        item.classList.toggle("on", input.checked);
      });
    });
    openOverlay("batch-download-overlay");
  }

  async function confirmBatchDownload() {
    const task = currentTask();
    const ver = getCurrentVersion(task);
    if (!task || !ver) return;
    const items = collectVersionExportItems(task);
    const ids = new Set(
      $$("#batch-download-body input[data-batch-item]:checked").map((el) => el.dataset.batchItem),
    );
    const selected = items.filter((item) => ids.has(item.id));
    if (!selected.length) return toast("请至少选择一张图片");
    toast(selected.length > 1 ? "正在打包下载…" : "开始下载…");
    try {
      if (selected.length === 1) {
        const item = selected[0];
        const a = document.createElement("a");
        a.href = item.image;
        a.download = `${fileSafeName(task.title || "asset")}_${fileSafeName(item.label, "img")}.png`;
        a.click();
        toast("开始下载");
      } else {
        const files = [];
        for (let i = 0; i < selected.length; i += 1) {
          const item = selected[i];
          const bytes = await resolveImageBytes(item.image);
          files.push({
            name: `${String(i + 1).padStart(2, "0")}_${fileSafeName(item.label, "img")}.png`,
            data: bytes,
          });
        }
        const blob = zipBlobFromFiles(files);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${fileSafeName(task.title || "asset")}_${fileSafeName(ver.name)}_batch.zip`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        toast(`已下载 ${selected.length} 张（ZIP）`);
      }
      closeOverlay("batch-download-overlay");
    } catch (error) {
      toast(error?.message || "下载失败，请稍后重试");
    }
  }

  function quoteSelectedDraft() {
    const task = currentTask();
    const ver = getCurrentVersion(task);
    // 画布正在看历史步/原图时必须引用焦点图；不能默默改成 tip 导致「往回引用」仍续写 V1
    const quoted = resolveCanvasQuoteTarget({
      version: ver,
      selectedDraftId: task?.selectedDraftId,
      lineageFocus: task?.lineageFocus,
      sourceImage: task?.sourceImage,
    });
    if (!task || !quoted?.image) return toast("请先选择一张草稿");
    pickQuoteRef(quoted);
  }

  function updateComposerGuide(task) {
    const alert = $("#composer-alert");
    const input = $("#composer-input");
    const type = task?.type || state.ui.taskType || "img2img";
    const pending = task ? pendingAttachments.get(task.id) : null;
    const needsSource =
      type === "img2img" && task && !task.sourceImage && !pending?.dataUrl && !task.versions.length;
    if (alert) {
      alert.textContent = "";
      alert.classList.add("hidden");
    }
    if (state.ui.quoteRef) {
      input.placeholder = "说明保留什么、改什么";
    } else if (needsSource) {
      input.placeholder = "请先上传商品原图";
    } else if (type === "img2img") {
      input.placeholder = "描述要生成的商品场景";
    } else {
      input.placeholder = "描述要生成的画面";
    }
  }

  function retryTask() {
    const task = currentTask();
    if (!task) return;
    if (activeGenerationToken) {
      toast("已有生成任务进行中");
      return;
    }
    const input = retrySnapshots.get(task.id) || task.lastGenerationInput;
    if (
      !input?.request ||
      !Array.isArray(input.request.images) ||
      typeof input.promptSnapshot !== "string"
    ) {
      return toast("暂无可重试的生成请求，请重新上传图片");
    }
    runGeneration(task, {
      mode: input.mode,
      note: input.note,
      quote: input.ref,
      storedInput: input,
    });
  }

  /* ---------- Personal prompts ---------- */
  function openPersonalEditor(id = null) {
    editingPersonalId = id;
    const item = id ? state.personalPrompts.find((p) => p.id === id) : null;
    $("#personal-prompt-title").textContent = item ? "编辑个人提示词" : "新建个人提示词";
    $("#pp-name").value = item?.name || "";
    $("#pp-type").value = item?.type || "img2img";
    $("#pp-category").value = item?.category || "apparel";
    $("#pp-tags").value = item?.tags || "";
    $("#pp-content").value = item?.content || "";
    $("#pp-negative").value = item?.negative || "";
    openOverlay("personal-prompt-overlay");
  }

  function savePersonalPrompt() {
    const name = $("#pp-name").value.trim();
    const content = $("#pp-content").value.trim();
    if (!name || !content) return toast("请填写名称与提示词内容");
    const payload = {
      name,
      type: $("#pp-type").value,
      category: $("#pp-category").value,
      tags: $("#pp-tags").value.trim(),
      content,
      negative: $("#pp-negative").value.trim(),
      source: editingPersonalId
        ? state.personalPrompts.find((p) => p.id === editingPersonalId)?.source || "手动创建"
        : $("#pp-tags").value.includes("任务")
          ? "由任务保存"
          : "手动创建",
      updatedAt: Date.now(),
    };
    if (editingPersonalId) {
      const idx = state.personalPrompts.findIndex((p) => p.id === editingPersonalId);
      if (idx >= 0) state.personalPrompts[idx] = { ...state.personalPrompts[idx], ...payload };
    } else {
      state.personalPrompts.unshift({ id: uid("pp"), createdAt: Date.now(), ...payload });
    }
    closeOverlay("personal-prompt-overlay");
    saveState();
    renderAll();
    toast("个人提示词已保存");
  }

  function deletePersonalPrompt(id) {
    state.personalPrompts = state.personalPrompts.filter((p) => p.id !== id);
    state.favorites = state.favorites.filter((f) => !(f.kind === "personal" && f.targetId === id));
    saveState();
    renderAll();
    toast("已删除个人提示词（历史任务不受影响）");
  }

  function toggleFavorite(kind, targetId) {
    const idx = state.favorites.findIndex((f) => f.kind === kind && f.targetId === targetId);
    if (idx >= 0) {
      state.favorites.splice(idx, 1);
      toast("已取消收藏");
    } else {
      state.favorites.unshift({ id: uid("fav"), kind, targetId, createdAt: Date.now() });
      toast("已收藏");
    }
    saveState();
    renderAll();
    if ($("#pick-overlay").classList.contains("open")) renderPickBody();
  }

  /* ---------- Public templates ---------- */
  function openTemplateEditor(id = null) {
    editingTemplateId = id;
    const item = id ? state.publicTemplates.find((t) => t.id === id) : null;
    $("#template-modal-title").textContent = item ? "编辑模板提示词" : "新建模板提示词";
    $("#tpl-name").value = item?.name || "";
    $("#tpl-desc").value = item?.desc || "";
    $("#tpl-type").value = item?.type || "img2img";
    $("#tpl-category").value = item?.category || "apparel";
    $("#tpl-content").value = item?.content || "";
    $("#tpl-negative").value = item?.negative || "";
    openOverlay("template-overlay");
  }

  function validateTemplateFields() {
    const name = $("#tpl-name").value.trim();
    const content = $("#tpl-content").value.trim();
    const category = $("#tpl-category").value;
    if (!name || !content) {
      toast("请填写模板提示词名称与内容");
      return null;
    }
    if (!CATEGORY_FIELDS[category]) {
      toast("表单方案不存在，禁止发布");
      return null;
    }
    return {
      name,
      desc: $("#tpl-desc").value.trim(),
      type: $("#tpl-type").value,
      category,
      content,
      negative: $("#tpl-negative").value.trim(),
    };
  }

  function saveTemplate(publish) {
    const payload = validateTemplateFields();
    if (!payload) return;
    if (publish) {
      const missing = [...payload.content.matchAll(/\{(\w+)\}/g)]
        .map((m) => m[1])
        .filter((k) => !(CATEGORY_FIELDS[payload.category] || []).some(([fk]) => fk === k));
      if (missing.length) {
        toast(`发布失败：引用字段不存在（${missing.join(", ")}）`);
        return;
      }
    }
    if (editingTemplateId) {
      const item = state.publicTemplates.find((t) => t.id === editingTemplateId);
      if (!item) return;
      Object.assign(item, payload, {
        updatedAt: Date.now(),
        updatedBy: USER_NAME,
        version: publish ? (item.version || 0) + 1 : item.version || 1,
        status: publish ? "published" : item.status === "disabled" ? "disabled" : "draft",
      });
    } else {
      state.publicTemplates.unshift({
        id: uid("tpl"),
        ...payload,
        status: publish ? "published" : "draft",
        version: 1,
        updatedAt: Date.now(),
        updatedBy: USER_NAME,
      });
    }
    closeOverlay("template-overlay");
    saveState();
    renderAll();
    toast(publish ? "模板提示词已发布（新版本已生成）" : "模板提示词草稿已保存");
  }

  function setTemplateStatus(id, status) {
    const item = state.publicTemplates.find((t) => t.id === id);
    if (!item) return;
    item.status = status;
    item.updatedAt = Date.now();
    item.updatedBy = USER_NAME;
    saveState();
    renderAll();
    toast(status === "disabled" ? "模板提示词已停用，新任务不可选用" : "模板提示词状态已更新");
  }

  /* ---------- Render ---------- */
  function renderAll() {
    const hasProjects = state.projects.length > 0;
    if (!hasProjects) {
      $$(".view-panel").forEach((el) => el.classList.toggle("active", el.id === "view-onboarding"));
    }
    renderTopbar();
    renderProjectDropdown();
    renderRailActive();
    if (!hasProjects || state.ui.view === "workbench") renderWorkbench();
    if (state.ui.view === "projects") renderProjectsPage();
    if (state.ui.view === "assets") renderAssetsPage();
    if (state.ui.view === "prompts") renderPromptsPage();
  }

  function renderRailActive() {
    $$(".rail-foot .foot-item, .page-rail .foot-item").forEach((el) => {
      el.classList.toggle("on", el.dataset.nav === state.ui.view);
    });
  }

  function renderTopbar() {
    const p = currentProject();
    const label = $("#current-project-label");
    if (label) label.textContent = p ? p.name : "未选择";
  }

  function positionProjectDropdown() {
    const btn = $("#btn-project-switch");
    const dd = $("#project-dropdown");
    if (!btn || !dd) return;
    const rect = btn.getBoundingClientRect();
    const width = Math.min(300, Math.max(240, window.innerWidth - 24));
    let left = rect.left;
    if (left + width > window.innerWidth - 12) left = Math.max(12, window.innerWidth - width - 12);
    dd.style.top = `${Math.round(rect.bottom + 6)}px`;
    dd.style.left = `${Math.round(left)}px`;
    dd.style.width = `${width}px`;
  }

  function toggleProjectDropdown() {
    const dd = $("#project-dropdown");
    if (!dd) return;
    const willOpen = !dd.classList.contains("open");
    if (willOpen) {
      positionProjectDropdown();
      renderProjectDropdown();
      dd.classList.add("open");
    } else {
      dd.classList.remove("open");
    }
  }

  function renderProjectDropdown() {
    const list = $("#project-dropdown-list");
    if (!state.projects.length) {
      list.innerHTML = `<div style="padding:12px;font-size:12px;color:var(--mute)">暂无店铺项目。创建项目后即可开始生成商品视觉素材。</div>`;
      return;
    }
    list.innerHTML = state.projects
      .map((p) => {
        const tasks = projectTasks(p.id);
        const last = tasks[0]?.updatedAt;
        return `<button class="dd-item ${p.id === state.currentProjectId ? "active" : ""}" data-switch-project="${p.id}" type="button">
          <strong>${escapeHtml(p.name)}</strong>
          <span>${escapeHtml(p.note || "")} · 任务 ${tasks.length} · 素材 ${projectAssets(p.id).length}${last ? ` · 最近 ${new Date(last).toLocaleDateString()}` : ""}</span>
        </button>`;
      })
      .join("");
  }

  function hasConversation(task) {
    if (!task) return false;
    if (task.versions?.length) return true;
    return (task.messages || []).some((m) => m.role === "user" || m.role === "ai");
  }

  function setTaskFilter(filter) {
    state.ui.taskFilter = filter || "all";
    saveState();
    renderTaskList();
  }

  function renderTaskList() {
    const list = $("#task-list");
    if (!list) return;
    const filter = state.ui.taskFilter || "all";
    const p = currentProject();

    $$("#task-tabs .task-tab").forEach((tab) => {
      tab.classList.toggle("on", tab.dataset.taskFilter === filter);
    });

    if (!p) {
      list.innerHTML = `<div class="help rail-empty">请先创建项目</div>`;
      $("#task-rail-count").textContent = "0";
      $("#task-count-all").textContent = "0";
      $("#task-count-img2img").textContent = "0";
      $("#task-count-txt2img").textContent = "0";
      return;
    }

    // 左侧只展示已产生对话的任务；「暂无任务」仅表示从未生成过对话
    const allTasks = projectTasks(p.id).filter(hasConversation);
    const imgTasks = allTasks.filter((t) => t.type === "img2img");
    const txtTasks = allTasks.filter((t) => t.type === "txt2img");
    const tasks =
      filter === "img2img" ? imgTasks : filter === "txt2img" ? txtTasks : allTasks;

    $("#task-count-all").textContent = String(allTasks.length);
    $("#task-count-img2img").textContent = String(imgTasks.length);
    $("#task-count-txt2img").textContent = String(txtTasks.length);
    $("#task-rail-count").textContent = String(tasks.length);

    if (!allTasks.length) {
      list.innerHTML = `<div class="help rail-empty">暂无任务<br/><span>发送第一条对话后会出现在这里</span></div>`;
      return;
    }
    if (!tasks.length) {
      list.innerHTML = `<div class="help rail-empty">该类型下暂无任务<br/><span>可切换到「全部」查看，或新建对话后发送</span></div>`;
      return;
    }

    list.innerHTML = tasks
      .map((t) => {
        const dot =
          t.status === "success"
            ? "ok"
            : t.status === "running" || t.status === "queued"
              ? "run"
              : t.status === "failed"
                ? "fail"
                : t.status === "blocked"
                  ? "block"
                  : "";
        const typeClass = t.type === "img2img" ? "img" : "txt";
        const typeLabel = t.type === "img2img" ? "商品图加工" : "创意生图";
        return `<button class="task-item ${t.id === p.currentTaskId ? "on" : ""}" data-open-task="${t.id}" type="button">
          <div class="t">${escapeHtml(t.title)}</div>
          <div class="m">
            <span class="dot ${dot}"></span>
            <span class="tag-mini ${typeClass}">${typeLabel}</span>
            <span>${STATUS_TEXT[t.status]} · ${new Date(t.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          </div>
        </button>`;
      })
      .join("");
  }

  function renderWorkbench() {
    renderTaskList();
    const task = currentTask();
    const type = task?.type || state.ui.taskType;
    $("#type-img2img").classList.toggle("on", type === "img2img");
    $("#type-txt2img").classList.toggle("on", type === "txt2img");

    const applied = $("#applied-prompt");
    const src = state.ui.appliedPrompt || task?.promptSource;
    if (src) {
      applied.classList.remove("hidden");
      const kindLabel = src.kind === "public" ? "模板提示词" : "个人提示词";
      $("#applied-prompt-label").textContent = `${kindLabel}：${src.name}${src.version ? ` v${src.version}` : ""}`;
    } else applied.classList.add("hidden");

    const status = task?.status || "idle";
    const pill = $("#task-status-pill");
    pill.className = `status-pill ${status === "idle" ? "" : status}`;
    pill.textContent = STATUS_TEXT[status] || status;
    const canvasBadge = $("#canvas-badge");
    canvasBadge.className = `status-pill ${status === "idle" ? "" : status}`;
    canvasBadge.textContent = STATUS_TEXT[status] || status;
    const stream = $("#chat-stream");
    if (!task) {
      stream.innerHTML = `<div class="msg system">请先创建或选择店铺项目。</div>`;
    } else {
      // 清理历史里已废弃的「Qwen 优化描述」系统气泡（本地旧消息）
      const beforeLen = task.messages.length;
      task.messages = task.messages.filter((m) => !isDeprecatedOptimizeNotice(m));
      if (task.messages.length !== beforeLen) saveState();

      stream.innerHTML = task.messages
        .map((m) => {
          const showRetry =
            task.status === "failed" &&
            m.role === "system" &&
            (m.text.includes("失败") || m.text.includes("超时") || m.text.includes("异常") || m.text.includes("密钥"));
          const actions = showRetry
            ? `<div class="msg-actions"><button class="btn sm primary" data-retry type="button">一键重试</button></div>`
            : "";
          const img =
            m.role === "user" && m.image
              ? `<button class="upload-thumb-btn" type="button" data-view-image="${escapeAttr(m.image)}" data-view-title="上传图" title="查看上传图"><img class="upload-thumb" src="${m.image}" alt="上传图" /></button>`
              : "";
          const quoteHtml = m.quote
            ? `<button class="quote-preview msg-quote-view" type="button" data-view-image="${escapeAttr(m.quote.image)}" data-view-title="${escapeAttr(m.quote.label || "引用图")}" title="查看引用图"><img src="${m.quote.image}" alt="" /><div class="quote-meta"><strong>引用</strong><span>${escapeHtml(m.quote.label)}</span></div></button>`
            : "";
          const resultHtml =
            m.role === "ai" && m.versionId ? renderAssistantResultHtml(task, m) : "";
          const isPromptCard = !!m.promptPreview;
          const promptPreviewHtml = isPromptCard
            ? `<details class="prompt-preview"><summary>本次合成内容</summary><pre>${escapeHtml(m.promptPreview)}</pre></details>`
            : "";
          const quoteDrafts = m.role === "ai" && m.versionId ? resolveAssistantResultDrafts(task, m) : [];
          const canQuote = quoteDrafts.length > 0;
          const quoteDraftId = m.draftId || quoteDrafts[0]?.id || "";
          const quoteImage = quoteDrafts[0]?.image || "";
          const side = canQuote
            ? `<div class="msg-side"><button class="btn sm" data-quote-version="${escapeAttr(m.versionId)}" data-quote-draft="${escapeAttr(quoteDraftId)}" data-quote-image="${escapeAttr(quoteImage)}" type="button">引用修改</button></div>`
            : "";
          const roleClass = m.role === "user" ? "user" : m.role === "system" ? "system" : "ai";
          const titleHtml = isPromptCard ? "" : escapeHtml(m.text || "");
          const metaHtml =
            isPromptCard || m.hideMeta
              ? ""
              : `<div class="meta">${m.role === "user" ? "我" : m.role === "system" ? "系统" : "助手"} · ${m.time}</div>`;
          return `<div class="msg-row ${m.role === "user" ? "user" : ""}">
            <div class="msg ${roleClass}${isPromptCard ? " prompt-card" : ""}">${titleHtml}${promptPreviewHtml}${resultHtml}${quoteHtml}${img}${metaHtml}${actions}</div>
            ${side}
          </div>`;
        })
        .join("");
      if (status === "running" || status === "queued") {
        stream.innerHTML += renderGeneratingPlaceholder(task);
      }
      stream.scrollTop = stream.scrollHeight;
    }
    updateComposerGuide(task);

    const draft = getSelectedDraft(task);
    const empty = $("#canvas-empty");
    const preview = $("#canvas-preview");
    const img = $("#canvas-image");
    const canvasImage = resolveCanvasImage(task);
    const waitingPreview =
      !canvasImage &&
      (status === "running" || status === "queued") &&
      (task?.sourceImage || state.ui.quoteRef?.image);
    if (canvasImage) {
      empty.classList.add("hidden");
      preview.classList.remove("hidden");
      img.src = canvasImage;
    } else if (waitingPreview) {
      empty.classList.add("hidden");
      preview.classList.remove("hidden");
      img.src = task.sourceImage || state.ui.quoteRef.image;
    } else {
      empty.classList.remove("hidden");
      preview.classList.add("hidden");
    }

    const strip = $("#draft-strip");
    const ver = getCurrentVersion(task);
    if (!ver) {
      const waitingHint =
        status === "running" || status === "queued"
          ? `<span class="chip soft">生成中，完成后将在此展示链路图</span>`
          : `<span class="chip soft">生成成功后，此处展示当前版本的修改链路</span>`;
      strip.innerHTML = waitingHint;
    } else {
      // 展示前纠错：误写的 sourceImage / 缺失 steps，避免「原图」错图与链路缺环
      if (
        ver.sourceImage &&
        isVersionGeneratedOrBranchImage(ver, ver.sourceImage)
      ) {
        delete ver.sourceImage;
      }
      repairVersionLineageFromMessages(
        ver,
        task.messages || [],
        task.selectedDraftId,
        [],
        task.sourceImage,
        task.versions,
      );
      // 链路条始终展示完整 tip 链路；预览焦点只高亮，不截断（截断会导致切换时其它缩略图突然消失）
      const pathNodes = buildBranchPathNodes({
        sourceImage: task.sourceImage,
        versions: task.versions,
        versionId: ver.id,
        selectedDraftId: task.selectedDraftId,
        messages: task.messages || [],
      });
      const focusImage = task.lineageFocus?.kind === "ancestor" ? task.lineageFocus.image : null;
      const pathSourceImage = resolveVersionSourceImage(ver, task.sourceImage);
      const activeKey = task.lineageFocus?.kind === "source"
        ? "source"
        : task.lineageFocus?.kind === "ancestor"
          ? `draft:${ver.id}:${task.lineageFocus.draftId}`
          : `draft:${ver.id}:${task.selectedDraftId || ver.drafts[0]?.id}`;
      // 不再显示「草稿 · Vx.x」：换原图后版本以下方「版本」条为准
      strip.innerHTML = pathNodes
        .map((node) => {
          const active =
            node.key === activeKey ||
            (focusImage && node.image === focusImage) ||
            ((node.kind === "current" || node.kind === "candidate") &&
              node.draftId &&
              node.draftId === task.selectedDraftId)
              ? "active"
              : "";
          const attrs =
            node.kind === "source"
              ? `data-path-source="1" data-path-image="${escapeAttr(node.image || pathSourceImage || "")}"`
              : `data-path-kind="${escapeAttr(node.kind)}" data-path-version="${escapeAttr(node.versionId || "")}" data-path-draft="${escapeAttr(node.draftId || "")}" data-path-image="${escapeAttr(node.image || "")}"`;
          return `<button class="draft-item path-item ${active}" type="button" title="${escapeAttr(`${node.label} · 单击预览，双击大图左右切换`)}" ${attrs}><img src="${node.image}" alt="${escapeAttr(node.label)}" /><span class="draft-cap">${escapeHtml(node.label)}</span></button>`;
        })
        .join("");
    }

    const timeline = $("#version-timeline");
    const lineageNodes = task ? buildLineageNodes(task) : [];
    if (!lineageNodes.length) {
      timeline.innerHTML = `<span class="chip soft">暂无版本</span>`;
    } else {
      timeline.innerHTML = lineageNodes
        .map((n) => {
          const cls = ["version-chip", n.active ? "active" : ""].filter(Boolean).join(" ");
          const displayName = shortVersionName(n.name);
          return `<button class="${cls}" type="button" title="${escapeAttr(n.trace || n.name)}" data-version="${n.versionId}">${escapeHtml(displayName)}</button>`;
        })
        .join("");
    }

    const hasDraft = !!draft;
    const canUseResult = hasDraft && status === "success";
    $("#btn-save").disabled = !hasDraft;
    const batchBtn = $("#btn-batch-download");
    if (batchBtn) batchBtn.disabled = !hasDraft;
    $("#btn-regenerate").disabled = !task || status === "running" || status === "queued";
    $("#btn-adjust").disabled = !canUseResult;
    $("#params-drawer").classList.toggle("open", !!state.ui.paramsOpen);
    syncParamsDrawerFromTask();
    renderAttach();
    renderQuote();
    // 重绘后保持发送钮「运行中/终止」状态，避免看起来像未生效
    syncSendButton();
  }

  function renderProjectsPage() {
    const wrap = $("#project-cards");
    if (!state.projects.length) {
      wrap.innerHTML = `<div class="empty-state"><div class="box"><h2>暂无店铺项目</h2><p>创建项目后即可开始生成商品视觉素材。</p><button class="btn primary" id="btn-empty-create-project" type="button">创建项目</button></div></div>`;
      return;
    }
    wrap.innerHTML = `<div class="cards">${state.projects
      .map((p) => {
        const tasks = projectTasks(p.id);
        const last = tasks[0]?.updatedAt;
        return `<div class="card ${p.id === state.currentProjectId ? "active" : ""}">
          <h3>${escapeHtml(p.name)}</h3>
          <p>${escapeHtml(p.note || "")}</p>
          <p>任务 ${tasks.length} · 素材 ${projectAssets(p.id).length}${last ? ` · 最近任务 ${new Date(last).toLocaleString()}` : ""}</p>
          <div class="msg-actions">
            <button class="btn sm primary" data-switch-project="${p.id}" type="button">进入生图</button>
            <button class="btn sm" data-rename-project="${p.id}" type="button">重命名</button>
          </div>
        </div>`;
      })
      .join("")}</div>`;
  }

  function syncPromptsPageChrome() {
    const tab = state.ui.promptTab;
    $$("#prompts-tabs .tab").forEach((t) => t.classList.toggle("on", t.dataset.promptTab === tab));
    $("#prompt-filters-mine")?.classList.toggle("hidden", tab === "templates");
    $("#prompt-filters-templates")?.classList.toggle("hidden", tab !== "templates");
    $("#btn-new-personal-prompt")?.classList.toggle("hidden", tab !== "mine");
    $("#btn-new-template")?.classList.toggle("hidden", tab !== "templates");
  }

  function renderTemplatesList(body) {
    const q = ($("#template-search")?.value || "").trim().toLowerCase();
    const fs = $("#template-filter-status")?.value || "";
    const ft = $("#template-filter-type")?.value || "";
    let list = state.publicTemplates.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    list = list.filter((t) => {
      if (fs && t.status !== fs) return false;
      if (ft && t.type !== ft) return false;
      if (q && !`${t.name} ${t.desc || ""} ${t.content}`.toLowerCase().includes(q)) return false;
      return true;
    });
    if (!list.length) {
      body.innerHTML = `<div class="empty-state"><div class="box"><h2>暂无模板提示词</h2><p>创建并发布后，即可在工作台使用。</p><button class="btn primary" id="btn-empty-new-tpl" type="button">新建模板提示词</button></div></div>`;
      return;
    }
    body.innerHTML = list
      .map(
        (t) => `<div class="list-card">
        <h3>${escapeHtml(t.name)} <span class="chip soft">${TPL_STATUS[t.status]}</span> <span class="chip soft">v${t.version}</span></h3>
        <div class="meta-row">
          <span class="chip soft">${TYPE_LABEL[t.type]}</span>
          <span class="chip soft">${categoryLabel(t.category)}</span>
          ${isFavorited("public", t.id) ? `<span class="chip">已收藏</span>` : ""}
        </div>
        <p>${escapeHtml(t.desc || "")}</p>
        <p>${escapeHtml(t.content.slice(0, 160))}${t.content.length > 160 ? "…" : ""}</p>
        <p>最近修改：${new Date(t.updatedAt).toLocaleString()} · ${escapeHtml(t.updatedBy || "")}</p>
        <div class="actions">
          ${t.status === "published" ? `<button class="btn sm primary" data-apply-public="${t.id}" type="button">使用</button>` : ""}
          <button class="btn sm" data-edit-template="${t.id}" type="button">编辑</button>
          <button class="btn sm" data-fav-public="${t.id}" type="button">${isFavorited("public", t.id) ? "取消收藏" : "收藏"}</button>
          ${t.status !== "disabled" ? `<button class="btn sm" data-disable-template="${t.id}" type="button">停用</button>` : `<button class="btn sm" data-enable-template="${t.id}" type="button">恢复为草稿</button>`}
          ${t.status === "draft" ? `<button class="btn sm primary" data-publish-template="${t.id}" type="button">发布</button>` : ""}
        </div>
      </div>`
      )
      .join("");
  }

  function renderPromptsPage() {
    syncPromptsPageChrome();
    const body = $("#prompts-body");
    if (!body) return;

    if (state.ui.promptTab === "templates") {
      renderTemplatesList(body);
      return;
    }

    const q = ($("#prompt-search")?.value || "").trim().toLowerCase();
    const ft = $("#prompt-filter-type")?.value || "";
    const fc = $("#prompt-filter-cat")?.value || "";

    if (state.ui.promptTab === "fav") {
      const favs = state.favorites
        .map((f) => {
          if (f.kind === "personal") {
            const p = state.personalPrompts.find((x) => x.id === f.targetId);
            return p ? { ...p, favKind: "personal" } : null;
          }
          const t = state.publicTemplates.find((x) => x.id === f.targetId);
          return t ? { ...t, favKind: "public", name: t.name, content: t.content } : null;
        })
        .filter(Boolean)
        .filter((item) => {
          if (ft && item.type !== ft) return false;
          if (fc && item.category !== fc) return false;
          if (q && !`${item.name} ${item.content} ${item.tags || ""}`.toLowerCase().includes(q)) return false;
          return true;
        });
      if (!favs.length) {
        body.innerHTML = `<div class="empty-state"><div class="box"><h2>暂未收藏提示词</h2><p>可在模板提示词或我的提示词中收藏，便于快速查找。</p><button class="btn primary" data-nav="templates" type="button">前往模板提示词</button></div></div>`;
        return;
      }
      body.innerHTML = favs
        .map(
          (item) => `<div class="list-card">
          <h3>${escapeHtml(item.name)} <span class="chip soft">${item.favKind === "public" ? "模板提示词" : "个人"}</span></h3>
          <div class="meta-row">
            <span class="chip soft">${TYPE_LABEL[item.type]}</span>
            <span class="chip soft">${categoryLabel(item.category)}</span>
            ${item.version ? `<span class="chip soft">v${item.version}</span>` : ""}
          </div>
          <p>${escapeHtml((item.content || "").slice(0, 140))}</p>
          <div class="actions">
            <button class="btn sm primary" data-${item.favKind === "public" ? "apply-public" : "apply-personal"}="${item.id}" type="button">使用</button>
            <button class="btn sm" data-fav-${item.favKind}="${item.id}" type="button">取消收藏</button>
          </div>
        </div>`
        )
        .join("");
      return;
    }

    let list = state.personalPrompts.slice();
    list = list.filter((p) => {
      if (ft && p.type !== ft) return false;
      if (fc && p.category !== fc) return false;
      if (q && !`${p.name} ${p.content} ${p.tags || ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
    if (!list.length) {
      body.innerHTML = `<div class="empty-state"><div class="box"><h2>还没有个人提示词</h2><p>可手动新建，或从已完成任务中保存。</p><button class="btn primary" id="btn-empty-new-prompt" type="button">新建提示词</button></div></div>`;
      return;
    }
    body.innerHTML = list
      .map(
        (p) => `<div class="list-card">
        <h3>${escapeHtml(p.name)}</h3>
        <div class="meta-row">
          <span class="chip soft">${TYPE_LABEL[p.type]}</span>
          <span class="chip soft">${categoryLabel(p.category)}</span>
          <span class="chip soft">${escapeHtml(p.source || "手动创建")}</span>
          ${isFavorited("personal", p.id) ? `<span class="chip">已收藏</span>` : ""}
        </div>
        <p>${escapeHtml(p.content.slice(0, 140))}${p.content.length > 140 ? "…" : ""}</p>
        <div class="actions">
          <button class="btn sm primary" data-apply-personal="${p.id}" type="button">使用</button>
          <button class="btn sm" data-edit-personal="${p.id}" type="button">编辑</button>
          <button class="btn sm" data-fav-personal="${p.id}" type="button">${isFavorited("personal", p.id) ? "取消收藏" : "收藏"}</button>
          <button class="btn sm" data-del-personal="${p.id}" type="button">删除</button>
        </div>
      </div>`
      )
      .join("");
  }

  function renderAssetsPage() {
    const p = currentProject();
    $("#assets-project-label").textContent = p ? p.name : "未选择项目";
    const body = $("#assets-body");
    if (!p) {
      body.innerHTML = `<div class="empty-state"><div class="box"><h2>请先选择项目</h2><p>素材库按店铺项目隔离。</p></div></div>`;
      return;
    }
    // 进入素材库时落盘去重，清掉历史重复图
    const before = state.assets.length;
    state.assets = dedupeAssetsList(state.assets);
    if (state.assets.length !== before) saveState();

    const assets = projectAssets(p.id);
    if (!assets.length) {
      body.innerHTML = `<div class="empty-state"><div class="box"><h2>还没有保存的素材</h2><p>在工作台生成后点「保存素材库」即可收纳到这里。</p></div></div>`;
      return;
    }

    const days = buildAssetDayTaskGroups(assets);
    body.innerHTML = `<div class="asset-day-list">${days
      .map((day) => {
        const packs = day.taskGroups
          .map((pack) => {
            const strip = pack.assets
              .map(
                (asset) => `<div class="asset-strip-item">
                  <button class="asset-strip-thumb" data-preview="${escapeAttr(asset.id)}" data-preview-pack="${escapeAttr(pack.taskId)}" type="button" title="${escapeAttr(
                  `${asset.stepLabel || asset.versionName || ""} · ${timeLabelFromTs(asset.createdAt)} · 可左右切换`,
                )}">
                    <img src="${asset.image}" alt="" />
                    <span>${escapeHtml(asset.stepLabel || asset.versionName || timeLabelFromTs(asset.createdAt))}</span>
                  </button>
                  <button class="asset-unsave" data-unsave-asset="${escapeAttr(asset.id)}" type="button" title="取消保存">×</button>
                </div>`,
              )
              .join("");
            return `<div class="asset-task-pack">
              <div class="asset-task-row">
                <div class="asset-task-main">
                  <div class="asset-task-name">${escapeHtml(pack.taskTitle)}</div>
                  <div class="asset-task-meta">
                    <span class="pill">${escapeHtml(TYPE_LABEL[pack.type] || pack.type)}</span>
                    <span>${escapeHtml(pack.createdBy)}</span>
                    <span>${pack.assets.length} 张</span>
                    <span>最近 ${escapeHtml(timeLabelFromTs(pack.latestAt))}</span>
                  </div>
                  <div class="asset-strip">${strip}</div>
                </div>
                <div class="asset-task-actions">
                  <button class="btn sm primary" data-export-pack="${escapeAttr(day.dateKey)}" data-export-task="${escapeAttr(
              pack.taskId,
            )}" type="button">批量下载</button>
                  <button class="btn sm" data-open-task="${escapeAttr(pack.taskId)}" type="button">来源任务</button>
                </div>
              </div>
            </div>`;
          })
          .join("");
        return `<section class="asset-day-block">
          <div class="asset-day-head">
            <strong>${escapeHtml(day.label)}</strong>
            <span>${day.taskGroups.length} 个任务 · ${day.totalCount} 张图</span>
          </div>
          <div class="asset-task-list">${packs}</div>
        </section>`;
      })
      .join("")}</div>`;
  }

  /* ---------- Events ---------- */
  function bindEvents() {
    $("#btn-project-switch")?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleProjectDropdown();
    });
    document.addEventListener("click", (e) => {
      const dd = $("#project-dropdown");
      if (!dd?.classList.contains("open")) return;
      if (dd.contains(e.target) || e.target.closest("#btn-project-switch")) return;
      closeDropdown();
    });
    window.addEventListener("resize", () => {
      if ($("#project-dropdown")?.classList.contains("open")) positionProjectDropdown();
    });

    $("#btn-create-project-from-dd").addEventListener("click", openCreateProject);
    $("#btn-create-first-project").addEventListener("click", openCreateProject);
    $("#btn-create-project").addEventListener("click", openCreateProject);
    $("#btn-confirm-create-project").addEventListener("click", confirmProjectModal);
    $("#btn-new-task-rail").addEventListener("click", startNewTask);
    $("#task-tabs")?.addEventListener("click", (e) => {
      const tab = e.target.closest("[data-task-filter]");
      if (!tab) return;
      setTaskFilter(tab.dataset.taskFilter);
    });

    $$("[data-close]").forEach((btn) => btn.addEventListener("click", () => closeOverlay(btn.dataset.close)));
    $$(".overlay").forEach((ov) =>
      ov.addEventListener("click", (e) => {
        if (e.target === ov) ov.classList.remove("open");
      })
    );

    document.addEventListener("click", (e) => {
      const nav = e.target.closest("[data-nav]");
      if (nav) {
        e.preventDefault();
        closeOverlay("pick-overlay");
        showView(nav.dataset.nav);
      }
      const sw = e.target.closest("[data-switch-project]");
      if (sw) switchProject(sw.dataset.switchProject);
      const rename = e.target.closest("[data-rename-project]");
      if (rename) openRenameProject(rename.dataset.renameProject);
      const draft = e.target.closest("[data-draft]");
      if (draft?.dataset.draft) selectDraft(draft.dataset.draft);
      const pathSource = e.target.closest("[data-path-source]");
      if (pathSource) {
        const t = currentTask();
        const ver = getCurrentVersion(t);
        const sourceImage =
          pathSource.dataset.pathImage ||
          pathSource.querySelector("img")?.getAttribute("src") ||
          resolveVersionSourceImage(ver, t?.sourceImage) ||
          t?.sourceImage ||
          null;
        if (sourceImage) {
          focusPathNode(t, { kind: "source", image: sourceImage });
          // 单击切画布；双击进入多图灯箱
          if (e.detail >= 2) {
            openImageLightbox(sourceImage, "原图", collectPathLightboxItems(t));
          }
        }
      }
      const pathNode = e.target.closest("[data-path-kind]");
      if (pathNode) {
        const t = currentTask();
        const versionId = pathNode.dataset.pathVersion || null;
        const draftId = pathNode.dataset.pathDraft || null;
        const imageFromDom =
          pathNode.dataset.pathImage ||
          pathNode.querySelector("img")?.getAttribute("src") ||
          null;
        const image =
          imageFromDom ||
          resolveVersionDraftImage(t, versionId, draftId) ||
          null;
        focusPathNode(t, {
          kind: pathNode.dataset.pathKind,
          versionId,
          draftId,
          image,
          label: pathNode.title,
        });
        if (e.detail >= 2 && image) {
          openImageLightbox(image, pathNode.title || "生成结果", collectPathLightboxItems(t));
        }
      }
      const viewImage = e.target.closest("[data-view-image]");
      if (viewImage && !viewImage.closest("#batch-download-body")) {
        const task = currentTask();
        openImageLightbox(
          viewImage.dataset.viewImage,
          viewImage.dataset.viewTitle || "图片预览",
          collectTaskLightboxItems(task),
        );
      }
      const ver = e.target.closest("[data-version]");
      if (ver) selectVersion(ver.dataset.version);
      const openTaskBtn = e.target.closest("[data-open-task]");
      if (openTaskBtn) openTask(openTaskBtn.dataset.openTask);
      const unsaveBtn = e.target.closest("[data-unsave-asset]");
      if (unsaveBtn) {
        e.preventDefault();
        e.stopPropagation();
        unsaveAsset(unsaveBtn.dataset.unsaveAsset);
        return;
      }
      const exportPack = e.target.closest("[data-export-pack]");
      if (exportPack) {
        exportTaskPack(exportPack.dataset.exportPack, exportPack.dataset.exportTask);
      }
      const preview = e.target.closest("[data-preview]");
      if (preview) {
        const asset = state.assets.find((a) => a.id === preview.dataset.preview);
        if (asset) {
          const packAssets = collectAssetStripLightboxItems(preview);
          openImageLightbox(
            asset.image,
            asset.title || "素材",
            collectAssetLightboxItems(asset, packAssets),
          );
        }
      }
      if (e.target.closest("[data-retry]")) retryTask();
      const quoteVersion = e.target.closest("[data-quote-version]");
      if (quoteVersion) {
        const task = currentTask();
        const version = task?.versions.find((item) => item.id === quoteVersion.dataset.quoteVersion);
        const draftId = quoteVersion.dataset.quoteDraft || null;
        // 用消息自身图/按钮上的图，禁止回落到 tip（repair 改写 steps id 后旧 draftId 会查不到）
        const row = quoteVersion.closest(".msg-row");
        const imageHint =
          quoteVersion.dataset.quoteImage ||
          row?.querySelector(".msg-result-hero img")?.getAttribute("src") ||
          row?.querySelector("img")?.getAttribute("src") ||
          null;
        const draft = resolveQuoteTargetDraft(version, {
          draftId,
          imageHint,
          label: `${version?.name || "V"} · 图`,
        });
        if (version && draft?.image) {
          pickQuoteRef({
            kind: "draft",
            label: draft.label || `${version.name} · 图`,
            image: draft.image,
            versionId: version.id,
            draftId: draft.id,
          });
        } else {
          toast("找不到该历史结果，请点选链路缩略图后再引用修改");
        }
      }
      const msgDraft = e.target.closest("[data-msg-draft]");
      if (msgDraft) {
        const task = currentTask();
        if (task && msgDraft.dataset.msgVersion) {
          // 以缩略图实际 src 为准，避免续写后 draftId 失效回落到 tip
          const imageFromDom = msgDraft.querySelector("img")?.getAttribute("src") || null;
          const focused = focusTaskDraft(task, {
            versionId: msgDraft.dataset.msgVersion,
            draftId: msgDraft.dataset.msgDraft,
            image: imageFromDom,
            label: msgDraft.getAttribute("title") || "",
          });
          saveState();
          renderWorkbench();
          if (msgDraft.classList.contains("msg-result-hero")) {
            const preview = imageFromDom || focused?.image;
            if (preview) {
              openImageLightbox(
                preview,
                `${focused?.version?.name || ""} · ${focused?.label || "生成结果"}`.trim(),
                collectTaskLightboxItems(task),
              );
            }
          }
        }
      }
      if (e.target.closest("[data-view-source]")) {
        const t = currentTask();
        if (t?.sourceImage) {
          state.ui.compareMode = true;
          saveState();
          renderWorkbench();
          toast("正在查看原图");
        }
      }
      const pick = e.target.closest("[data-pick-ref]");
      if (pick && refPickMap[pick.dataset.pickRef]) {
        const ref = refPickMap[pick.dataset.pickRef];
        // 双击预览多图；单击选为引用（延迟以区分双击）
        if (e.detail >= 2) {
          if (refPickClickTimer) {
            clearTimeout(refPickClickTimer);
            refPickClickTimer = null;
          }
          openImageLightbox(ref.image, ref.label || "可引用图", collectRefPickerLightboxItems());
        } else {
          if (refPickClickTimer) clearTimeout(refPickClickTimer);
          refPickClickTimer = setTimeout(() => {
            refPickClickTimer = null;
            pickQuoteRef(ref);
          }, 220);
        }
      }

      const ap = e.target.closest("[data-apply-public]");
      if (ap) {
        const t = state.publicTemplates.find((x) => x.id === ap.dataset.applyPublic);
        if (t && t.status === "published") {
          if (!currentProject()) openCreateProject();
          else applyPromptSource({ kind: "public", ...t });
        } else toast("仅已发布的模板提示词可使用");
      }
      const ape = e.target.closest("[data-apply-personal]");
      if (ape) {
        const p = state.personalPrompts.find((x) => x.id === ape.dataset.applyPersonal);
        if (p) {
          if (!currentProject()) openCreateProject();
          else applyPromptSource({ kind: "personal", ...p });
        }
      }
      if (e.target.closest("[data-apply-blank]")) applyPromptSource({ kind: "blank" });

      const fp = e.target.closest("[data-fav-public]");
      if (fp) toggleFavorite("public", fp.dataset.favPublic);
      const fpe = e.target.closest("[data-fav-personal]");
      if (fpe) toggleFavorite("personal", fpe.dataset.favPersonal);
      const ep = e.target.closest("[data-edit-personal]");
      if (ep) openPersonalEditor(ep.dataset.editPersonal);
      const dp = e.target.closest("[data-del-personal]");
      if (dp) deletePersonalPrompt(dp.dataset.delPersonal);
      const et = e.target.closest("[data-edit-template]");
      if (et) openTemplateEditor(et.dataset.editTemplate);
      const dt = e.target.closest("[data-disable-template]");
      if (dt) setTemplateStatus(dt.dataset.disableTemplate, "disabled");
      const en = e.target.closest("[data-enable-template]");
      if (en) setTemplateStatus(en.dataset.enableTemplate, "draft");
      const pt = e.target.closest("[data-publish-template]");
      if (pt) {
        editingTemplateId = pt.dataset.publishTemplate;
        const item = state.publicTemplates.find((t) => t.id === editingTemplateId);
        if (item) {
          $("#tpl-name").value = item.name;
          $("#tpl-desc").value = item.desc || "";
          $("#tpl-type").value = item.type;
          $("#tpl-category").value = item.category;
          $("#tpl-content").value = item.content;
          $("#tpl-negative").value = item.negative || "";
          saveTemplate(true);
        }
      }
      if (e.target.closest("#btn-empty-create-project")) openCreateProject();
      if (e.target.closest("#btn-empty-new-prompt")) openPersonalEditor();
      if (e.target.closest("#btn-empty-new-tpl")) openTemplateEditor();
    });

    $$("#pick-tabs .tab").forEach((tab) =>
      tab.addEventListener("click", () => {
        pickTab = tab.dataset.pickTab;
        $$("#pick-tabs .tab").forEach((t) => t.classList.toggle("on", t === tab));
        renderPickBody();
      })
    );
    $$("#prompts-tabs .tab").forEach((tab) =>
      tab.addEventListener("click", () => {
        state.ui.promptTab = tab.dataset.promptTab;
        saveState();
        renderPromptsPage();
      })
    );

    ["prompt-search", "prompt-filter-type", "prompt-filter-cat"].forEach((id) => {
      $(`#${id}`)?.addEventListener("input", () => renderPromptsPage());
      $(`#${id}`)?.addEventListener("change", () => renderPromptsPage());
    });
    ["template-search", "template-filter-status", "template-filter-type"].forEach((id) => {
      $(`#${id}`)?.addEventListener("input", () => renderPromptsPage());
      $(`#${id}`)?.addEventListener("change", () => renderPromptsPage());
    });

    $("#btn-new-personal-prompt").addEventListener("click", () => openPersonalEditor());
    $("#btn-save-personal-prompt").addEventListener("click", savePersonalPrompt);
    $("#btn-new-template").addEventListener("click", () => openTemplateEditor());
    $("#btn-save-template-draft").addEventListener("click", () => saveTemplate(false));
    $("#btn-publish-template").addEventListener("click", () => saveTemplate(true));
    $("#btn-pick-prompt").addEventListener("click", openPickOverlay);
    $("#btn-clear-applied").addEventListener("click", () => applyPromptSource({ kind: "blank" }));

    $("#type-img2img").addEventListener("click", () => {
      if (activeGenerationToken) return toast("请先点击「运行中」终止当前生成");
      const task = currentTask();
      if (task?.versions?.length) {
        return toast("当前任务已有生成结果，请新建任务后再切换文生图/图生图");
      }
      state.ui.taskType = "img2img";
      if (task) task.type = "img2img";
      saveState();
      renderWorkbench();
      updateComposerGuide(task);
    });
    $("#type-txt2img").addEventListener("click", () => {
      if (activeGenerationToken) return toast("请先点击「运行中」终止当前生成");
      const task = currentTask();
      if (task?.versions?.length) {
        return toast("当前任务已有生成结果，请新建任务后再切换文生图/图生图");
      }
      state.ui.taskType = "txt2img";
      if (task) task.type = "txt2img";
      saveState();
      renderWorkbench();
      updateComposerGuide(task);
    });

    $("#btn-upload").addEventListener("click", () => $("#file-input").click());
    $("#file-input").addEventListener("change", async (e) => {
      await onFileSelected(e.target.files?.[0]);
      e.target.value = "";
    });
    $("#btn-clear-attach").addEventListener("click", clearAttach);
    $("#btn-clear-quote").addEventListener("click", clearQuote);
    const onComposerGenChange = () => {
      const gen = readComposerGenControls();
      syncDrawerGenControls(gen);
      const task = currentTask();
      if (task) {
        task.params = { ...task.params, ...gen };
        saveState();
      }
    };
    $("#gen-resolution")?.addEventListener("change", onComposerGenChange);
    $("#gen-ratio")?.addEventListener("change", onComposerGenChange);
    $("#gen-count")?.addEventListener("change", onComposerGenChange);
    $("#param-resolution")?.addEventListener("change", () => {
      const resolution = normalizeResolution($("#param-resolution").value);
      const ratio = normalizeRatioOption(suggestValue($('[data-combo="ratio"]')));
      const count = normalizeCount($("#param-count").value);
      syncComposerGenControls({ resolution, ratio, count });
      const task = currentTask();
      if (task) {
        task.params = { ...task.params, resolution, ratio, count };
        saveState();
      }
    });
    $("#param-count").addEventListener("change", () => {
      const resolution = normalizeResolution($("#param-resolution")?.value);
      const ratio = normalizeRatioOption(suggestValue($('[data-combo="ratio"]')));
      const count = normalizeCount($("#param-count").value);
      syncComposerGenControls({ resolution, ratio, count });
      const task = currentTask();
      if (task) {
        task.params = { ...task.params, resolution, ratio, count };
        saveState();
      }
    });
    $("#btn-send").addEventListener("click", () => {
      if (activeGenerationToken) {
        abortActiveGeneration();
        return;
      }
      sendMessage();
    });
    $("#composer-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (activeGenerationToken) return;
        sendMessage();
      }
    });

    $("#btn-toggle-params").addEventListener("click", () => setParamsOpen(!state.ui.paramsOpen));
    $("#btn-close-params").addEventListener("click", () => setParamsOpen(false));
    $$(".suggest-field[data-combo]").forEach(bindSuggestField);
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".suggest-field")) closeAllSuggestMenus();
    });
    $("#param-category").addEventListener("change", () => {
      const cat = $("#param-category").value;
      const task = currentTask();
      if (task) {
        task.params.category = cat;
        task.params.fields = {};
      }
      renderParamFields();
      persistQuickParamsQuietly("drawer");
    });
    $("#param-extra")?.addEventListener("change", () => persistQuickParamsQuietly("drawer"));
    $("#param-resolution")?.addEventListener("change", () => persistQuickParamsQuietly("drawer"));
    $("#param-count")?.addEventListener("change", () => persistQuickParamsQuietly("drawer"));
    $("#btn-apply-params").addEventListener("click", () => {
      generateFromQuickParams();
    });

    $("#btn-save").addEventListener("click", saveToLibrary);
    $("#btn-batch-download")?.addEventListener("click", openBatchDownload);
    $("#btn-confirm-batch-download")?.addEventListener("click", () => {
      confirmBatchDownload();
    });
    $("#btn-batch-select-all")?.addEventListener("click", () => {
      $$("#batch-download-body input[data-batch-item]").forEach((input) => {
        input.checked = true;
        input.closest(".batch-download-item")?.classList.add("on");
      });
    });
    $("#canvas-image").addEventListener("click", () => {
      const task = currentTask();
      if (!task || $("#canvas-preview").classList.contains("hidden")) return;
      // 画布看图必须跟当前展示一致（含 lineageFocus 历史步），不能总拿 tip
      const shown = $("#canvas-image").getAttribute("src");
      const image = resolveCanvasImage(task) || shown;
      if (!image) return;
      const gallery = collectPathLightboxItems(task);
      if (state.ui.compareMode || task.lineageFocus?.kind === "source") {
        openImageLightbox(
          task.lineageFocus?.image ||
            resolveVersionSourceImage(getCurrentVersion(task), task.sourceImage) ||
            image,
          "原图",
          gallery,
        );
        return;
      }
      if (task.lineageFocus?.kind === "ancestor") {
        const step = findVersionDraft(
          task.versions.find((item) => item.id === task.lineageFocus.versionId),
          task.lineageFocus.draftId,
          task.lineageFocus.image || image,
        );
        openImageLightbox(
          task.lineageFocus.image || shown || image,
          step?.label || "历史步骤",
          gallery,
        );
        return;
      }
      const draft = getSelectedDraft(task);
      openImageLightbox(
        shown || image,
        `${getCurrentVersion(task)?.name || "预览"} · ${draft?.label || "生成结果"}`,
        gallery,
      );
    });
    $("#quote-thumb")?.addEventListener("click", () => {
      const ref = state.ui.quoteRef;
      if (!ref?.image) return;
      openImageLightbox(ref.image, ref.label || "引用图", collectTaskLightboxItems(currentTask()));
    });
    $("#attach-thumb")?.addEventListener("click", () => {
      const task = currentTask();
      const pending = pendingAttachments.get(task?.id);
      const image = pending?.dataUrl || task?.sourceImage;
      if (!image) return;
      openImageLightbox(image, "上传原图", collectTaskLightboxItems(task));
    });
    $("#btn-regenerate").addEventListener("click", () => {
      const task = currentTask();
      if (!task) return;
      runGeneration(task, { mode: "create", note: "重新生成（保留历史版本）" });
    });
    $("#btn-adjust").addEventListener("click", () => {
      quoteSelectedDraft();
    });

    $("#btn-close-lightbox").addEventListener("click", () => closeLightbox());
    $("#btn-lightbox-prev")?.addEventListener("click", (e) => {
      e.stopPropagation();
      stepLightbox(-1);
    });
    $("#btn-lightbox-next")?.addEventListener("click", (e) => {
      e.stopPropagation();
      stepLightbox(1);
    });
    $("#lightbox").addEventListener("click", (e) => {
      const thumb = e.target.closest("[data-lightbox-index]");
      if (thumb) {
        e.stopPropagation();
        jumpLightbox(thumb.dataset.lightboxIndex);
        return;
      }
      if (e.target.id === "lightbox") closeLightbox();
    });
    const lightboxStage = $("#lightbox-stage");
    lightboxStage?.addEventListener(
      "wheel",
      (e) => {
        if (!$("#lightbox")?.classList.contains("open")) return;
        if (lightboxGallery.items.length <= 1) return;
        e.preventDefault();
        const now = Date.now();
        if (now < lightboxWheelLockUntil) return;
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (Math.abs(delta) < 8) return;
        lightboxWheelLockUntil = now + 220;
        stepLightbox(delta > 0 ? 1 : -1);
      },
      { passive: false },
    );
    lightboxStage?.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      lightboxDragX = e.clientX;
    });
    window.addEventListener("mouseup", (e) => {
      if (lightboxDragX == null) return;
      const delta = e.clientX - lightboxDragX;
      lightboxDragX = null;
      if (!$("#lightbox")?.classList.contains("open")) return;
      if (Math.abs(delta) < 48) return;
      stepLightbox(delta < 0 ? 1 : -1);
    });
    lightboxStage?.addEventListener(
      "touchstart",
      (e) => {
        lightboxTouchX = e.changedTouches?.[0]?.clientX ?? null;
      },
      { passive: true },
    );
    lightboxStage?.addEventListener(
      "touchend",
      (e) => {
        if (lightboxTouchX == null) return;
        const endX = e.changedTouches?.[0]?.clientX ?? lightboxTouchX;
        const delta = endX - lightboxTouchX;
        lightboxTouchX = null;
        if (Math.abs(delta) < 40) return;
        stepLightbox(delta < 0 ? 1 : -1);
      },
      { passive: true },
    );
    document.addEventListener("keydown", (e) => {
      if (!$("#lightbox")?.classList.contains("open")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeLightbox();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepLightbox(-1);
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        stepLightbox(1);
      }
    });
    $("#project-name-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") confirmProjectModal();
    });
  }

  function init() {
    bindEvents();
    if (!state.publicTemplates?.length) state.publicTemplates = seedTemplates();
    ensureDefaultPersonalPrompts();
    saveState();
    if (!state.projects.length) state.ui.view = "onboarding";
    else if (!state.ui.view || state.ui.view === "onboarding") state.ui.view = "workbench";
    const p = currentProject();
    if (p && !currentTask()) seedWelcomeTask(p.id);
    const task = currentTask();
    if (task) {
      ensureDefaultPersonalPrompt(task);
      state.ui.appliedPrompt = task.promptSource || null;
    }
    showView(state.ui.view);
  }

  init();
})();
