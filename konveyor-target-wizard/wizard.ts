/**
 * Konveyor Custom Target Wizard
 * -----------------------------
 * Wizard paso a paso para crear "custom migration targets" de Konveyor,
 * replicando el flujo de tackle2-ui (Administration > Custom migration targets):
 *
 *   1. Datos generales  : nombre, descripción, proveedor de lenguaje, icono
 *   2. Reglas           : editor interactivo de reglas (por defecto), subida
 *                         manual de ficheros YAML, o repositorio (git/svn)
 *   3. Labels y sources : label automático konveyor.io/target=<slug>, labels custom y sources
 *   4. Revisión         : resumen + payload JSON listo para POST /hub/targets
 *
 * El editor interactivo genera reglas YAML del analyzer-lsp
 * (https://github.com/konveyor/analyzer-lsp) sin escribir YAML a mano.
 *
 * Sin dependencias externas: TypeScript estricto compilado a un único wizard.js.
 */

/* ============================== Modelo ============================== */

type RulesMode = "create" | "upload" | "repository";

interface RuleFile {
  name: string;
  size: number;
  content: string;
  ruleCount: number;
  issues: string[];
}

interface RepoConfig {
  kind: "git" | "subversion";
  url: string;
  branch: string;
  path: string;
  credentials: string;
}

type CondProvider = "java.referenced" | "builtin.filecontent" | "builtin.file" | "builtin.xml";

interface SimpleCond {
  provider: CondProvider;
  pattern: string;
  location: string;    // java.referenced
  filePattern: string; // builtin.filecontent
  xpath: string;       // builtin.xml
  filepaths: string;   // builtin.xml (separados por comas)
}

type RuleCategory = "mandatory" | "optional" | "potential";
type CondLogic = "single" | "and" | "or";

interface BuiltRule {
  ruleID: string;
  description: string;
  category: RuleCategory;
  effort: number;
  message: string;
  labels: string; // labels adicionales, separados por comas
  logic: CondLogic;
  conditions: SimpleCond[];
  linkTitle: string;
  linkUrl: string;
}

interface WizardState {
  step: number;
  maxVisited: number;
  // Paso 1
  name: string;
  description: string;
  provider: string;
  icon: string;
  // Paso 2
  mode: RulesMode;
  rules: BuiltRule[];
  draft: BuiltRule | null;
  draftIndex: number; // -1 = regla nueva
  files: RuleFile[];
  repo: RepoConfig;
  // Paso 3
  customLabels: string[];
  sources: string[];
  // Paso 4
  created: boolean;
}

const PROVIDERS = ["Java", "Go", ".NET", "Node.js", "Python", "Otro"] as const;

const ICONS = ["🎯", "☁️", "📦", "⚙️", "🛡️", "🚀", "🗄️", "🔧"] as const;

/** Sources habituales en los rulesets de Konveyor (konveyor.io/source=...) */
const KNOWN_SOURCES = [
  "eap", "eap6", "eap7", "eap8", "springboot", "spring",
  "weblogic", "websphere", "jonas", "orion", "resteasy",
  "openjdk", "oraclejdk", "javaee", "jakarta-ee",
  "camel", "camel2", "camel3", "thorntail", "drools", "jbpm",
];

const JAVA_LOCATIONS = [
  "", "IMPORT", "PACKAGE", "TYPE", "INHERITANCE", "IMPLEMENTS_TYPE",
  "ANNOTATION", "METHOD_CALL", "CONSTRUCTOR_CALL", "RETURN_TYPE", "FIELD", "ENUM",
];

const EFFORT_LEVELS = [0, 1, 3, 5, 7, 13];

const COND_PROVIDERS: { value: CondProvider; label: string; help: string }[] = [
  {
    value: "java.referenced",
    label: "java.referenced — referencia Java",
    help: "Detecta usos de una clase/paquete Java (imports, anotaciones, llamadas...)",
  },
  {
    value: "builtin.filecontent",
    label: "builtin.filecontent — contenido de fichero",
    help: "Busca un patrón (regex) dentro del contenido de los ficheros",
  },
  {
    value: "builtin.file",
    label: "builtin.file — existencia de fichero",
    help: "Detecta ficheros cuyo nombre coincide con un patrón",
  },
  {
    value: "builtin.xml",
    label: "builtin.xml — XPath en XML",
    help: "Evalúa una expresión XPath sobre ficheros XML",
  },
];

const state: WizardState = {
  step: 0,
  maxVisited: 0,
  name: "",
  description: "",
  provider: "Java",
  icon: ICONS[0],
  mode: "create",
  rules: [],
  draft: null,
  draftIndex: -1,
  files: [],
  repo: { kind: "git", url: "", branch: "", path: "", credentials: "" },
  customLabels: [],
  sources: [],
  created: false,
};

const STEPS = [
  { title: "Datos generales", subtitle: "Nombre, descripción e icono" },
  { title: "Reglas personalizadas", subtitle: "Editor, ficheros o repositorio" },
  { title: "Labels y sources", subtitle: "Etiquetado del target" },
  { title: "Revisión y creación", subtitle: "Payload para el Hub" },
] as const;

/* ============================== Utilidades ============================== */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function $(sel: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(sel);
  if (!node) throw new Error(`Elemento no encontrado: ${sel}`);
  return node;
}

/* ============================== Editor de reglas ============================== */

function newCondition(): SimpleCond {
  return { provider: "java.referenced", pattern: "", location: "", filePattern: "", xpath: "", filepaths: "" };
}

function nextRuleId(): string {
  const prefix = slugify(state.name) || "regla";
  const used = new Set(state.rules.map((r) => r.ruleID));
  let n = state.rules.length + 1;
  let id = "";
  do {
    id = `${prefix}-${String(n).padStart(5, "0")}`;
    n += 1;
  } while (used.has(id));
  return id;
}

function newRule(): BuiltRule {
  return {
    ruleID: nextRuleId(),
    description: "",
    category: "mandatory",
    effort: 1,
    message: "",
    labels: "",
    logic: "single",
    conditions: [newCondition()],
    linkTitle: "",
    linkUrl: "",
  };
}

function condSummary(c: SimpleCond): string {
  switch (c.provider) {
    case "java.referenced":
      return `java.referenced: ${c.pattern}${c.location ? ` (${c.location})` : ""}`;
    case "builtin.filecontent":
      return `filecontent: /${c.pattern}/${c.filePattern ? ` en ${c.filePattern}` : ""}`;
    case "builtin.file":
      return `file: ${c.pattern}`;
    case "builtin.xml":
      return `xml: ${c.xpath}`;
  }
}

function validateDraft(rule: BuiltRule): string[] {
  const errors: string[] = [];
  if (!rule.ruleID.trim()) {
    errors.push("El ruleID es obligatorio.");
  } else if (!/^[a-zA-Z0-9._-]+$/.test(rule.ruleID.trim())) {
    errors.push("El ruleID solo puede contener letras, números, puntos, guiones y guiones bajos.");
  } else if (
    state.rules.some((r, i) => i !== state.draftIndex && r.ruleID === rule.ruleID.trim())
  ) {
    errors.push(`Ya existe una regla con ruleID «${rule.ruleID.trim()}».`);
  }
  rule.conditions.forEach((c, i) => {
    if (c.provider === "builtin.xml") {
      if (!c.xpath.trim()) errors.push(`Condición ${i + 1}: falta la expresión XPath.`);
    } else if (!c.pattern.trim()) {
      errors.push(`Condición ${i + 1}: falta el patrón.`);
    }
  });
  if (!rule.message.trim()) {
    errors.push("Añade un mensaje: es lo que verá el desarrollador cuando la regla haga match.");
  }
  return errors;
}

/* ============================== Generación de YAML ============================== */

function yamlScalar(s: string): string {
  const v = s.trim();
  if (v === "") return '""';
  if (/^[A-Za-z0-9._\/=+][A-Za-z0-9._\/=+ -]*$/.test(v) && !/^(true|false|null|yes|no|on|off)$/i.test(v)) {
    return v;
  }
  return JSON.stringify(v);
}

function condToLines(c: SimpleCond): string[] {
  const lines: string[] = [];
  switch (c.provider) {
    case "java.referenced":
      lines.push("java.referenced:");
      lines.push(`  pattern: ${yamlScalar(c.pattern)}`);
      if (c.location) lines.push(`  location: ${c.location}`);
      break;
    case "builtin.filecontent":
      lines.push("builtin.filecontent:");
      lines.push(`  pattern: ${yamlScalar(c.pattern)}`);
      if (c.filePattern.trim()) lines.push(`  filePattern: ${yamlScalar(c.filePattern)}`);
      break;
    case "builtin.file":
      lines.push("builtin.file:");
      lines.push(`  pattern: ${yamlScalar(c.pattern)}`);
      break;
    case "builtin.xml":
      lines.push("builtin.xml:");
      lines.push(`  xpath: ${yamlScalar(c.xpath)}`);
      if (c.filepaths.trim()) {
        lines.push("  filepaths:");
        c.filepaths
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean)
          .forEach((f) => lines.push(`    - ${yamlScalar(f)}`));
      }
      break;
  }
  return lines;
}

function ruleLabels(rule: BuiltRule): string[] {
  const labels = [targetLabel()];
  for (const source of state.sources) labels.push(`konveyor.io/source=${source}`);
  rule.labels
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((l) => labels.push(l));
  return labels;
}

/** Genera el fichero YAML de reglas del analyzer-lsp a partir del editor. */
function buildRulesYaml(): string {
  const out: string[] = [];
  for (const rule of state.rules) {
    out.push(`- ruleID: ${yamlScalar(rule.ruleID)}`);
    if (rule.description.trim()) out.push(`  description: ${yamlScalar(rule.description)}`);
    out.push(`  category: ${rule.category}`);
    out.push(`  effort: ${rule.effort}`);
    out.push("  labels:");
    ruleLabels(rule).forEach((l) => out.push(`    - ${yamlScalar(l)}`));
    out.push("  when:");
    if (rule.conditions.length === 1 || rule.logic === "single") {
      condToLines(rule.conditions[0]).forEach((ln) => out.push(`    ${ln}`));
    } else {
      out.push(`    ${rule.logic}:`);
      for (const c of rule.conditions) {
        const lines = condToLines(c);
        out.push(`      - ${lines[0]}`);
        lines.slice(1).forEach((ln) => out.push(`        ${ln}`));
      }
    }
    if (rule.message.trim()) out.push(`  message: ${yamlScalar(rule.message)}`);
    if (rule.linkUrl.trim()) {
      out.push("  links:");
      out.push(`    - title: ${yamlScalar(rule.linkTitle.trim() || rule.linkUrl)}`);
      out.push(`      url: ${yamlScalar(rule.linkUrl)}`);
    }
  }
  return out.join("\n") + "\n";
}

function rulesFileName(): string {
  return `${slugify(state.name) || "custom"}-reglas.yaml`;
}

/* ============================== Validación ============================== */

/** Análisis ligero de un fichero YAML de reglas de Konveyor (analyzer-lsp). */
function analyzeRuleFile(name: string, content: string): RuleFile {
  const issues: string[] = [];
  const size = new Blob([content]).size;

  if (!/\.ya?ml$/i.test(name)) {
    issues.push("La extensión debería ser .yaml o .yml");
  }
  if (content.trim().length === 0) {
    issues.push("El fichero está vacío");
  }

  const ruleCount = (content.match(/^\s*-?\s*ruleID\s*:/gm) ?? []).length;
  if (ruleCount === 0 && content.trim().length > 0) {
    // Puede ser un fichero ruleset.yaml (metadatos) en lugar de reglas
    if (/^\s*name\s*:/m.test(content) && /labels\s*:/m.test(content)) {
      issues.push("Parece un ruleset.yaml de metadatos (sin reglas ruleID)");
    } else {
      issues.push("No se encontró ningún campo ruleID: — ¿es un fichero de reglas válido?");
    }
  }
  if (ruleCount > 0 && !/^\s*when\s*:/m.test(content)) {
    issues.push("Hay ruleID pero ninguna condición when: — las reglas no harán match");
  }

  return { name, size, content, ruleCount, issues };
}

function stepErrors(step: number): string[] {
  const errors: string[] = [];
  if (step === 0) {
    if (state.name.trim().length < 3) {
      errors.push("El nombre debe tener al menos 3 caracteres.");
    }
    if (!state.provider) {
      errors.push("Selecciona un proveedor de lenguaje.");
    }
  }
  if (step === 1) {
    if (state.mode === "create") {
      if (state.draft !== null) {
        errors.push("Tienes una regla sin guardar: guárdala o cancela la edición.");
      }
      if (state.rules.length === 0 && state.draft === null) {
        errors.push("Crea al menos una regla con el editor (o usa otro modo).");
      }
    } else if (state.mode === "upload") {
      if (state.files.length === 0) {
        errors.push("Sube al menos un fichero YAML de reglas.");
      } else if (!state.files.some((f) => f.ruleCount > 0)) {
        errors.push("Ninguno de los ficheros subidos contiene reglas (ruleID).");
      }
    } else {
      const url = state.repo.url.trim();
      if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(url)) {
        errors.push("Introduce una URL de repositorio válida (https://, ssh:// o git@).");
      }
    }
  }
  if (step === 2) {
    for (const label of state.customLabels) {
      if (!/^[a-zA-Z0-9._\/-]+(=[a-zA-Z0-9._-]+)?$/.test(label)) {
        errors.push(`Label con formato inválido: ${label}`);
      }
    }
  }
  return errors;
}

/* ============================== Payload ============================== */

function targetLabel(): string {
  return `konveyor.io/target=${slugify(state.name) || "mi-target"}`;
}

function allLabels(): string[] {
  const labels = [targetLabel(), ...state.customLabels];
  for (const source of state.sources) {
    labels.push(`konveyor.io/source=${source}`);
  }
  return labels;
}

/** Construye el payload del recurso Target de tackle2-hub (POST /hub/targets). */
function buildPayload(): object {
  const ruleset: Record<string, unknown> = {
    name: state.name.trim(),
    description: state.description.trim(),
  };

  if (state.mode === "create") {
    // El YAML generado por el editor se sube como un único fichero
    // (POST /hub/files) y se referencia aquí; id 0 = placeholder.
    ruleset.rules = [{ name: rulesFileName(), file: { id: 0, name: rulesFileName() } }];
  } else if (state.mode === "upload") {
    // En el flujo real, cada fichero se sube antes con POST /hub/files
    // y aquí se referencia por id; se deja 0 como placeholder.
    ruleset.rules = state.files.map((f) => ({
      name: f.name,
      file: { id: 0, name: f.name },
    }));
  } else {
    ruleset.repository = {
      kind: state.repo.kind,
      url: state.repo.url.trim(),
      branch: state.repo.branch.trim(),
      path: state.repo.path.trim(),
    };
    if (state.repo.credentials.trim()) {
      ruleset.identity = { name: state.repo.credentials.trim() };
    }
  }

  return {
    name: state.name.trim(),
    description: state.description.trim(),
    provider: state.provider,
    choice: true,
    custom: true,
    labels: allLabels().map((l) => ({ name: l, label: l })),
    image: { id: 1 },
    ruleset,
  };
}

/* ============================== Render: navegación ============================== */

function renderNav(): void {
  const nav = $("#wizard-nav");
  nav.innerHTML = STEPS.map((s, i) => {
    const status =
      i === state.step ? "current" : i < state.step || i <= state.maxVisited ? "done" : "todo";
    const clickable = i <= state.maxVisited && !state.created;
    return `
      <li class="nav-step ${status} ${clickable ? "clickable" : ""}" data-step="${i}">
        <span class="nav-bullet">${status === "done" && i < state.step ? "✓" : i + 1}</span>
        <span class="nav-text">
          <span class="nav-title">${s.title}</span>
          <span class="nav-subtitle">${s.subtitle}</span>
        </span>
      </li>`;
  }).join("");

  nav.querySelectorAll<HTMLElement>(".nav-step.clickable").forEach((li) => {
    li.addEventListener("click", () => {
      state.step = Number(li.dataset.step);
      render();
    });
  });
}

/* ============================== Render: pasos ============================== */

function renderStep0(): string {
  return `
    <h2>Datos generales</h2>
    <p class="hint">Define el nombre con el que aparecerá el target en la vista
    <em>Custom migration targets</em> de Konveyor.</p>

    <label class="field">
      <span class="field-label">Nombre <b class="req">*</b></span>
      <input id="f-name" type="text" placeholder="p. ej. Quarkus interno" value="${esc(state.name)}" />
      <span class="field-help">Se generará el label <code>${esc(targetLabel())}</code></span>
    </label>

    <label class="field">
      <span class="field-label">Descripción</span>
      <textarea id="f-desc" rows="3"
        placeholder="Describe qué migración cubre este target...">${esc(state.description)}</textarea>
    </label>

    <div class="field">
      <span class="field-label">Proveedor de lenguaje <b class="req">*</b></span>
      <div class="chip-row">
        ${PROVIDERS.map(
          (p) => `<button type="button" class="chip ${state.provider === p ? "chip-on" : ""}"
                    data-provider="${p}">${p}</button>`,
        ).join("")}
      </div>
    </div>

    <div class="field">
      <span class="field-label">Icono del target</span>
      <div class="chip-row">
        ${ICONS.map(
          (icon) => `<button type="button" class="chip icon-chip ${state.icon === icon ? "chip-on" : ""}"
                    data-icon="${icon}">${icon}</button>`,
        ).join("")}
      </div>
      <span class="field-help">En Konveyor real se sube una imagen SVG/PNG (POST /hub/files).</span>
    </div>`;
}

/* ---------- Paso 2: editor interactivo ---------- */

function renderCondFields(c: SimpleCond, i: number): string {
  switch (c.provider) {
    case "java.referenced":
      return `
        <label class="cf">
          <span>Patrón <b class="req">*</b></span>
          <input type="text" data-cf data-ci="${i}" data-field="pattern"
            value="${esc(c.pattern)}" placeholder="javax.ejb.Stateless  ·  javax.ejb*" />
        </label>
        <label class="cf">
          <span>Ubicación</span>
          <select data-cf data-ci="${i}" data-field="location">
            ${JAVA_LOCATIONS.map(
              (loc) =>
                `<option value="${loc}" ${c.location === loc ? "selected" : ""}>${loc || "(cualquiera)"}</option>`,
            ).join("")}
          </select>
        </label>`;
    case "builtin.filecontent":
      return `
        <label class="cf">
          <span>Patrón (regex) <b class="req">*</b></span>
          <input type="text" data-cf data-ci="${i}" data-field="pattern"
            value="${esc(c.pattern)}" placeholder="java:jboss/datasources" />
        </label>
        <label class="cf">
          <span>Filtro de ficheros</span>
          <input type="text" data-cf data-ci="${i}" data-field="filePattern"
            value="${esc(c.filePattern)}" placeholder="*.properties (opcional)" />
        </label>`;
    case "builtin.file":
      return `
        <label class="cf cf-wide">
          <span>Patrón de nombre de fichero <b class="req">*</b></span>
          <input type="text" data-cf data-ci="${i}" data-field="pattern"
            value="${esc(c.pattern)}" placeholder="persistence\\.xml" />
        </label>`;
    case "builtin.xml":
      return `
        <label class="cf">
          <span>XPath <b class="req">*</b></span>
          <input type="text" data-cf data-ci="${i}" data-field="xpath"
            value="${esc(c.xpath)}" placeholder="//dependency[artifactId='hibernate-core']" />
        </label>
        <label class="cf">
          <span>Ficheros (separados por comas)</span>
          <input type="text" data-cf data-ci="${i}" data-field="filepaths"
            value="${esc(c.filepaths)}" placeholder="pom.xml (opcional)" />
        </label>`;
  }
}

function renderDraftForm(rule: BuiltRule): string {
  const providerHelp = (p: CondProvider): string =>
    COND_PROVIDERS.find((cp) => cp.value === p)?.help ?? "";
  return `
    <div class="builder-form">
      <h3>${state.draftIndex >= 0 ? "Editar regla" : "Nueva regla"}</h3>
      <div id="draft-errors"></div>

      <div class="form-grid">
        <label class="field">
          <span class="field-label">ruleID <b class="req">*</b></span>
          <input id="r-id" type="text" value="${esc(rule.ruleID)}" />
        </label>
        <label class="field">
          <span class="field-label">Categoría</span>
          <select id="r-cat">
            <option value="mandatory" ${rule.category === "mandatory" ? "selected" : ""}>mandatory — obligatoria</option>
            <option value="optional" ${rule.category === "optional" ? "selected" : ""}>optional — opcional</option>
            <option value="potential" ${rule.category === "potential" ? "selected" : ""}>potential — potencial</option>
          </select>
        </label>
        <label class="field span-2">
          <span class="field-label">Descripción</span>
          <input id="r-desc" type="text" value="${esc(rule.description)}"
            placeholder="Título corto de la regla, p. ej. «Reemplazar EJB Stateless por CDI»" />
        </label>
        <label class="field">
          <span class="field-label">Esfuerzo (story points)</span>
          <select id="r-effort">
            ${EFFORT_LEVELS.map(
              (e) => `<option value="${e}" ${rule.effort === e ? "selected" : ""}>${e}</option>`,
            ).join("")}
          </select>
        </label>
        <label class="field">
          <span class="field-label">Labels extra (separados por comas)</span>
          <input id="r-labels" type="text" value="${esc(rule.labels)}" placeholder="discovery, team=payments" />
        </label>
      </div>

      <div class="field">
        <span class="field-label">Condiciones (when) <b class="req">*</b></span>
        ${
          rule.conditions.length > 1
            ? `<div class="logic-row">
                <span>Deben cumplirse:</span>
                <select id="r-logic">
                  <option value="and" ${rule.logic !== "or" ? "selected" : ""}>todas (AND)</option>
                  <option value="or" ${rule.logic === "or" ? "selected" : ""}>cualquiera (OR)</option>
                </select>
              </div>`
            : ""
        }
        ${rule.conditions
          .map(
            (c, i) => `
          <div class="cond-row">
            <div class="cond-head">
              <select data-cprov data-ci="${i}" title="Tipo de condición">
                ${COND_PROVIDERS.map(
                  (cp) =>
                    `<option value="${cp.value}" ${c.provider === cp.value ? "selected" : ""}>${cp.label}</option>`,
                ).join("")}
              </select>
              ${
                rule.conditions.length > 1
                  ? `<button type="button" class="btn-x" data-rm-cond="${i}" title="Quitar condición">✕</button>`
                  : ""
              }
            </div>
            <p class="cond-help">${providerHelp(c.provider)}</p>
            <div class="cond-fields">${renderCondFields(c, i)}</div>
          </div>`,
          )
          .join("")}
        <button type="button" class="btn btn-link" id="btn-add-cond">＋ Añadir otra condición</button>
      </div>

      <label class="field">
        <span class="field-label">Mensaje para el desarrollador <b class="req">*</b></span>
        <textarea id="r-msg" rows="2"
          placeholder="Qué debe hacer cuando la regla haga match, p. ej. «Usa @ApplicationScoped de CDI»">${esc(rule.message)}</textarea>
      </label>

      <div class="form-grid">
        <label class="field">
          <span class="field-label">Enlace de documentación (opcional)</span>
          <input id="r-link-url" type="text" value="${esc(rule.linkUrl)}" placeholder="https://..." />
        </label>
        <label class="field">
          <span class="field-label">Título del enlace</span>
          <input id="r-link-title" type="text" value="${esc(rule.linkTitle)}" placeholder="Guía de migración" />
        </label>
      </div>

      <div class="inline-add">
        <button type="button" class="btn btn-primary" id="btn-save-rule">💾 Guardar regla</button>
        <button type="button" class="btn btn-secondary" id="btn-cancel-rule">Cancelar</button>
      </div>
    </div>`;
}

function renderBuilderPane(): string {
  const list = state.rules.length
    ? `<ul class="rule-list">
        ${state.rules
          .map(
            (r, i) => `
          <li class="rule-card">
            <div class="rule-card-main">
              <div class="rule-card-title">
                <code>${esc(r.ruleID)}</code>
                <span class="badge badge-${r.category}">${r.category}</span>
                <span class="badge badge-effort">esfuerzo ${r.effort}</span>
              </div>
              ${r.description ? `<p class="rule-desc">${esc(r.description)}</p>` : ""}
              <p class="rule-when">
                ${r.conditions.map((c) => `<code>${esc(condSummary(c))}</code>`).join(
                  ` <em>${r.logic === "or" ? "OR" : "AND"}</em> `,
                )}
              </p>
            </div>
            <div class="rule-card-actions">
              <button type="button" class="btn-mini" data-edit-rule="${i}">✏️ Editar</button>
              <button type="button" class="btn-mini" data-del-rule="${i}">🗑 Borrar</button>
            </div>
          </li>`,
          )
          .join("")}
      </ul>`
    : "";

  const empty =
    state.rules.length === 0 && !state.draft
      ? `<div class="empty-state">
          <p>🧩 Aún no hay reglas.</p>
          <p class="hint">Crea tu primera regla con el asistente: eliges la condición
          (clase Java, contenido de fichero, XPath...) y el wizard genera el YAML por ti.</p>
          <button type="button" class="btn btn-primary" id="btn-first-rule">＋ Crear mi primera regla</button>
        </div>`
      : "";

  const toolbar =
    state.rules.length > 0 && !state.draft
      ? `<div class="builder-toolbar">
          <span><strong>${state.rules.length}</strong> regla${state.rules.length === 1 ? "" : "s"} definida${state.rules.length === 1 ? "" : "s"}</span>
          <button type="button" class="btn btn-secondary" id="btn-new-rule">＋ Nueva regla</button>
        </div>`
      : "";

  const yamlPreview =
    state.rules.length > 0
      ? `<details class="yaml-details" ${state.draft ? "" : "open"}>
          <summary>Vista previa del YAML generado — <code>${esc(rulesFileName())}</code></summary>
          <pre class="code">${esc(buildRulesYaml())}</pre>
        </details>`
      : "";

  return `${toolbar}${list}${empty}${state.draft ? renderDraftForm(state.draft) : ""}${yamlPreview}`;
}

function renderStep1(): string {
  const uploadPane = `
    <div id="dropzone" class="dropzone">
      <p><strong>Arrastra aquí tus ficheros de reglas</strong> (.yaml / .yml)</p>
      <p class="hint">o</p>
      <button type="button" class="btn btn-secondary" id="btn-browse">Seleccionar ficheros…</button>
      <input id="f-files" type="file" accept=".yaml,.yml" multiple hidden />
    </div>
    ${
      state.files.length
        ? `<ul class="file-list">
            ${state.files
              .map(
                (f, i) => `
              <li class="file-item ${f.ruleCount === 0 ? "file-bad" : ""}">
                <span class="file-icon">${f.ruleCount > 0 ? "📄" : "⚠️"}</span>
                <span class="file-meta">
                  <strong>${esc(f.name)}</strong>
                  <small>${formatSize(f.size)} · ${f.ruleCount} regla${f.ruleCount === 1 ? "" : "s"} detectada${f.ruleCount === 1 ? "" : "s"}</small>
                  ${f.issues.map((issue) => `<small class="issue">⚠ ${esc(issue)}</small>`).join("")}
                </span>
                <button type="button" class="btn-x" data-rm-file="${i}" title="Quitar">✕</button>
              </li>`,
              )
              .join("")}
          </ul>`
        : ""
    }`;

  const repoPane = `
    <div class="repo-grid">
      <label class="field">
        <span class="field-label">Tipo de repositorio</span>
        <select id="f-repo-kind">
          <option value="git" ${state.repo.kind === "git" ? "selected" : ""}>Git</option>
          <option value="subversion" ${state.repo.kind === "subversion" ? "selected" : ""}>Subversion</option>
        </select>
      </label>
      <label class="field span-2">
        <span class="field-label">URL del repositorio <b class="req">*</b></span>
        <input id="f-repo-url" type="text" value="${esc(state.repo.url)}"
          placeholder="https://github.com/mi-org/mis-reglas.git" />
      </label>
      <label class="field">
        <span class="field-label">Branch</span>
        <input id="f-repo-branch" type="text" value="${esc(state.repo.branch)}" placeholder="main" />
      </label>
      <label class="field">
        <span class="field-label">Ruta raíz (path)</span>
        <input id="f-repo-path" type="text" value="${esc(state.repo.path)}" placeholder="/rules" />
      </label>
      <label class="field">
        <span class="field-label">Credenciales (identity)</span>
        <input id="f-repo-cred" type="text" value="${esc(state.repo.credentials)}"
          placeholder="nombre de la credencial en el Hub (opcional)" />
      </label>
    </div>`;

  const panes: Record<RulesMode, string> = {
    create: renderBuilderPane(),
    upload: uploadPane,
    repository: repoPane,
  };

  return `
    <h2>Reglas personalizadas</h2>
    <p class="hint">Un target agrupa un <em>ruleset</em>: reglas YAML del
    <a href="https://github.com/konveyor/analyzer-lsp" target="_blank" rel="noopener">analyzer-lsp</a>.
    Puedes <strong>crearlas de forma interactiva</strong> con el editor (recomendado),
    subir ficheros ya escritos, o referenciar un repositorio.</p>

    <div class="mode-toggle" role="tablist">
      <button type="button" class="mode-btn ${state.mode === "create" ? "mode-on" : ""}" data-mode="create">
        ✏️ Crear reglas
      </button>
      <button type="button" class="mode-btn ${state.mode === "upload" ? "mode-on" : ""}" data-mode="upload">
        ⬆️ Subir ficheros
      </button>
      <button type="button" class="mode-btn ${state.mode === "repository" ? "mode-on" : ""}" data-mode="repository">
        🌐 Repositorio
      </button>
    </div>

    ${panes[state.mode]}`;
}

function renderStep2(): string {
  return `
    <h2>Labels y sources</h2>
    <p class="hint">Los labels permiten al análisis seleccionar las reglas del target.
    El label principal se genera automáticamente a partir del nombre.</p>

    <div class="field">
      <span class="field-label">Label del target (automático)</span>
      <span class="label-pill label-auto">${esc(targetLabel())}</span>
    </div>

    <div class="field">
      <span class="field-label">Labels adicionales</span>
      <div class="inline-add">
        <input id="f-label-new" type="text" placeholder="clave=valor  ·  p. ej. team=payments" />
        <button type="button" class="btn btn-secondary" id="btn-add-label">Añadir</button>
      </div>
      <div class="chip-row" id="label-chips">
        ${state.customLabels
          .map(
            (l, i) => `<span class="label-pill">${esc(l)}
              <button type="button" class="btn-x" data-rm-label="${i}" title="Quitar">✕</button></span>`,
          )
          .join("")}
      </div>
    </div>

    <div class="field">
      <span class="field-label">Sources compatibles (konveyor.io/source=…)</span>
      <div class="source-grid">
        ${KNOWN_SOURCES.map(
          (s) => `
          <label class="source-item">
            <input type="checkbox" data-source="${s}" ${state.sources.includes(s) ? "checked" : ""} />
            <span>${s}</span>
          </label>`,
        ).join("")}
      </div>
      <span class="field-help">Si has creado reglas con el editor, estos sources se añaden
      también como labels de cada regla en el YAML generado.</span>
    </div>`;
}

function renderStep3(): string {
  const payload = JSON.stringify(buildPayload(), null, 2);
  const rulesSummary =
    state.mode === "create"
      ? `${state.rules.length} regla(s) creada(s) con el editor → <code>${esc(rulesFileName())}</code>`
      : state.mode === "upload"
        ? `${state.files.length} fichero(s), ${state.files.reduce((n, f) => n + f.ruleCount, 0)} regla(s)`
        : `${state.repo.kind} · ${esc(state.repo.url)}${state.repo.branch ? ` @ ${esc(state.repo.branch)}` : ""}`;

  if (state.created) {
    const uploadLine =
      state.mode === "create"
        ? `curl -X POST $HUB_URL/files -F "file=@${rulesFileName()}"`
        : 'curl -X POST $HUB_URL/files -F "file=@mis-reglas.yaml"';
    return `
      <div class="success">
        <div class="success-icon">✅</div>
        <h2>Target «${esc(state.name)}» listo</h2>
        <p>El payload se ha generado. Para crearlo en un Hub real de Konveyor:</p>
        <pre class="code">« subir cada fichero de reglas »
${uploadLine}

« crear el target con los ids de fichero devueltos »
curl -X POST $HUB_URL/targets \\
  -H "Content-Type: application/json" \\
  -d @target.json</pre>
        ${
          state.mode === "create"
            ? `<button type="button" class="btn btn-secondary" id="btn-download-yaml-2">⬇ Descargar ${esc(rulesFileName())}</button>`
            : ""
        }
        <button type="button" class="btn btn-primary" id="btn-download-2">⬇ Descargar target.json</button>
        <button type="button" class="btn btn-secondary" id="btn-restart">Crear otro target</button>
      </div>`;
  }

  return `
    <h2>Revisión</h2>
    <dl class="review">
      <dt>Icono / nombre</dt><dd>${state.icon} <strong>${esc(state.name)}</strong></dd>
      <dt>Descripción</dt><dd>${esc(state.description) || "<em>—</em>"}</dd>
      <dt>Proveedor</dt><dd>${esc(state.provider)}</dd>
      <dt>Reglas</dt><dd>${rulesSummary}</dd>
      <dt>Labels</dt><dd>${allLabels().map((l) => `<span class="label-pill">${esc(l)}</span>`).join(" ")}</dd>
    </dl>

    ${
      state.mode === "create" && state.rules.length > 0
        ? `<details class="yaml-details">
            <summary>Reglas generadas — <code>${esc(rulesFileName())}</code></summary>
            <pre class="code">${esc(buildRulesYaml())}</pre>
          </details>`
        : ""
    }

    <div class="field">
      <span class="field-label">Payload — <code>POST /hub/targets</code></span>
      <pre class="code" id="payload-pre">${esc(payload)}</pre>
      <div class="inline-add">
        <button type="button" class="btn btn-secondary" id="btn-download">⬇ Descargar target.json</button>
        ${
          state.mode === "create" && state.rules.length > 0
            ? `<button type="button" class="btn btn-secondary" id="btn-download-yaml">⬇ Descargar YAML de reglas</button>`
            : ""
        }
        <button type="button" class="btn btn-secondary" id="btn-copy">📋 Copiar</button>
      </div>
    </div>`;
}

/* ============================== Eventos por paso ============================== */

function bindStep0(): void {
  $("#f-name").addEventListener("input", (e) => {
    state.name = (e.target as HTMLInputElement).value;
    const codeEl = document.querySelector<HTMLElement>(".field-help code");
    if (codeEl) codeEl.textContent = targetLabel();
  });
  $("#f-desc").addEventListener("input", (e) => {
    state.description = (e.target as HTMLTextAreaElement).value;
  });
  document.querySelectorAll<HTMLElement>("[data-provider]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.provider = btn.dataset.provider ?? state.provider;
      render();
    });
  });
  document.querySelectorAll<HTMLElement>("[data-icon]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.icon = btn.dataset.icon ?? state.icon;
      render();
    });
  });
}

function addFiles(files: FileList | File[]): void {
  const pending = Array.from(files);
  let remaining = pending.length;
  if (remaining === 0) return;
  for (const file of pending) {
    const reader = new FileReader();
    reader.onload = () => {
      const content = typeof reader.result === "string" ? reader.result : "";
      // Sustituye si ya existe un fichero con el mismo nombre
      const idx = state.files.findIndex((f) => f.name === file.name);
      const analyzed = analyzeRuleFile(file.name, content);
      if (idx >= 0) state.files[idx] = analyzed;
      else state.files.push(analyzed);
      remaining -= 1;
      if (remaining === 0) render();
    };
    reader.readAsText(file);
  }
}

function startDraft(index: number): void {
  state.draftIndex = index;
  state.draft = index >= 0 ? (JSON.parse(JSON.stringify(state.rules[index])) as BuiltRule) : newRule();
  render();
}

function bindBuilder(): void {
  document.querySelector<HTMLElement>("#btn-first-rule")?.addEventListener("click", () => startDraft(-1));
  document.querySelector<HTMLElement>("#btn-new-rule")?.addEventListener("click", () => startDraft(-1));

  document.querySelectorAll<HTMLElement>("[data-edit-rule]").forEach((btn) => {
    btn.addEventListener("click", () => startDraft(Number(btn.dataset.editRule)));
  });
  document.querySelectorAll<HTMLElement>("[data-del-rule]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.rules.splice(Number(btn.dataset.delRule), 1);
      render();
    });
  });

  const draft = state.draft;
  if (!draft) return;

  // Campos de texto: actualizan el borrador sin re-render (para no perder el foco)
  const bindText = (sel: string, set: (v: string) => void): void => {
    document.querySelector<HTMLElement>(sel)?.addEventListener("input", (e) => {
      set((e.target as HTMLInputElement | HTMLTextAreaElement).value);
    });
  };
  bindText("#r-id", (v) => (draft.ruleID = v));
  bindText("#r-desc", (v) => (draft.description = v));
  bindText("#r-msg", (v) => (draft.message = v));
  bindText("#r-labels", (v) => (draft.labels = v));
  bindText("#r-link-url", (v) => (draft.linkUrl = v));
  bindText("#r-link-title", (v) => (draft.linkTitle = v));

  document.querySelector<HTMLSelectElement>("#r-cat")?.addEventListener("change", (e) => {
    draft.category = (e.target as HTMLSelectElement).value as RuleCategory;
  });
  document.querySelector<HTMLSelectElement>("#r-effort")?.addEventListener("change", (e) => {
    draft.effort = Number((e.target as HTMLSelectElement).value);
  });
  document.querySelector<HTMLSelectElement>("#r-logic")?.addEventListener("change", (e) => {
    draft.logic = (e.target as HTMLSelectElement).value as CondLogic;
  });

  // Condiciones
  document.querySelectorAll<HTMLInputElement>("[data-cf]").forEach((input) => {
    input.addEventListener("input", () => {
      const ci = Number(input.dataset.ci);
      const field = input.dataset.field as keyof SimpleCond;
      if (field !== "provider") {
        (draft.conditions[ci][field] as string) = input.value;
      }
    });
  });
  document.querySelectorAll<HTMLSelectElement>("[data-cprov]").forEach((sel) => {
    sel.addEventListener("change", () => {
      draft.conditions[Number(sel.dataset.ci)].provider = sel.value as CondProvider;
      render();
    });
  });
  document.querySelectorAll<HTMLElement>("[data-rm-cond]").forEach((btn) => {
    btn.addEventListener("click", () => {
      draft.conditions.splice(Number(btn.dataset.rmCond), 1);
      if (draft.conditions.length <= 1) draft.logic = "single";
      render();
    });
  });
  document.querySelector<HTMLElement>("#btn-add-cond")?.addEventListener("click", () => {
    draft.conditions.push(newCondition());
    if (draft.logic === "single") draft.logic = "and";
    render();
  });

  $("#btn-save-rule").addEventListener("click", () => {
    const errors = validateDraft(draft);
    if (errors.length > 0) {
      $("#draft-errors").innerHTML = `
        <div class="alert">${errors.map((err) => `<p>⚠ ${esc(err)}</p>`).join("")}</div>`;
      return;
    }
    draft.ruleID = draft.ruleID.trim();
    if (state.draftIndex >= 0) state.rules[state.draftIndex] = draft;
    else state.rules.push(draft);
    state.draft = null;
    state.draftIndex = -1;
    render();
  });
  $("#btn-cancel-rule").addEventListener("click", () => {
    state.draft = null;
    state.draftIndex = -1;
    render();
  });
}

function bindStep1(): void {
  document.querySelectorAll<HTMLElement>("[data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.mode = btn.dataset.mode as RulesMode;
      render();
    });
  });

  if (state.mode === "create") {
    bindBuilder();
  } else if (state.mode === "upload") {
    const drop = $("#dropzone");
    const input = $("#f-files") as HTMLInputElement;
    $("#btn-browse").addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      if (input.files) addFiles(input.files);
    });
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("drag-on");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("drag-on"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("drag-on");
      if (e.dataTransfer?.files) addFiles(e.dataTransfer.files);
    });
    document.querySelectorAll<HTMLElement>("[data-rm-file]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.files.splice(Number(btn.dataset.rmFile), 1);
        render();
      });
    });
  } else {
    ($("#f-repo-kind") as HTMLSelectElement).addEventListener("change", (e) => {
      state.repo.kind = (e.target as HTMLSelectElement).value as RepoConfig["kind"];
    });
    $("#f-repo-url").addEventListener("input", (e) => {
      state.repo.url = (e.target as HTMLInputElement).value;
    });
    $("#f-repo-branch").addEventListener("input", (e) => {
      state.repo.branch = (e.target as HTMLInputElement).value;
    });
    $("#f-repo-path").addEventListener("input", (e) => {
      state.repo.path = (e.target as HTMLInputElement).value;
    });
    $("#f-repo-cred").addEventListener("input", (e) => {
      state.repo.credentials = (e.target as HTMLInputElement).value;
    });
  }
}

function bindStep2(): void {
  const addLabel = (): void => {
    const input = $("#f-label-new") as HTMLInputElement;
    const value = input.value.trim();
    if (value && !state.customLabels.includes(value)) {
      state.customLabels.push(value);
      render();
    }
  };
  $("#btn-add-label").addEventListener("click", addLabel);
  $("#f-label-new").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") {
      e.preventDefault();
      addLabel();
    }
  });
  document.querySelectorAll<HTMLElement>("[data-rm-label]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.customLabels.splice(Number(btn.dataset.rmLabel), 1);
      render();
    });
  });
  document.querySelectorAll<HTMLInputElement>("[data-source]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const src = cb.dataset.source ?? "";
      if (cb.checked && !state.sources.includes(src)) state.sources.push(src);
      if (!cb.checked) state.sources = state.sources.filter((s) => s !== src);
    });
  });
}

function downloadBlob(content: string, mime: string, filename: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadPayload(): void {
  downloadBlob(
    JSON.stringify(buildPayload(), null, 2),
    "application/json",
    `target-${slugify(state.name) || "konveyor"}.json`,
  );
}

function downloadRulesYaml(): void {
  downloadBlob(buildRulesYaml(), "application/yaml", rulesFileName());
}

function bindStep3(): void {
  if (state.created) {
    $("#btn-download-2").addEventListener("click", downloadPayload);
    document
      .querySelector<HTMLElement>("#btn-download-yaml-2")
      ?.addEventListener("click", downloadRulesYaml);
    $("#btn-restart").addEventListener("click", () => {
      Object.assign(state, {
        step: 0,
        maxVisited: 0,
        name: "",
        description: "",
        provider: "Java",
        icon: ICONS[0],
        mode: "create" as RulesMode,
        rules: [],
        draft: null,
        draftIndex: -1,
        files: [],
        repo: { kind: "git", url: "", branch: "", path: "", credentials: "" },
        customLabels: [],
        sources: [],
        created: false,
      });
      render();
    });
    return;
  }
  $("#btn-download").addEventListener("click", downloadPayload);
  document
    .querySelector<HTMLElement>("#btn-download-yaml")
    ?.addEventListener("click", downloadRulesYaml);
  $("#btn-copy").addEventListener("click", () => {
    void navigator.clipboard.writeText(JSON.stringify(buildPayload(), null, 2)).then(() => {
      $("#btn-copy").textContent = "✓ Copiado";
      setTimeout(() => {
        const btn = document.querySelector<HTMLElement>("#btn-copy");
        if (btn) btn.textContent = "📋 Copiar";
      }, 1500);
    });
  });
}

/* ============================== Render principal ============================== */

function render(): void {
  renderNav();

  const body = $("#wizard-body");
  const renderers = [renderStep0, renderStep1, renderStep2, renderStep3];
  body.innerHTML = `<div id="step-errors"></div>${renderers[state.step]()}`;

  const binders = [bindStep0, bindStep1, bindStep2, bindStep3];
  binders[state.step]();

  // Footer
  const footer = $("#wizard-footer");
  if (state.created) {
    footer.innerHTML = "";
    return;
  }
  const isLast = state.step === STEPS.length - 1;
  footer.innerHTML = `
    <button type="button" class="btn btn-secondary" id="btn-back"
      ${state.step === 0 ? "disabled" : ""}>‹ Atrás</button>
    <button type="button" class="btn btn-primary" id="btn-next">
      ${isLast ? "🎯 Crear target" : "Siguiente ›"}
    </button>`;

  $("#btn-back").addEventListener("click", () => {
    if (state.step > 0) {
      state.step -= 1;
      render();
    }
  });
  $("#btn-next").addEventListener("click", () => {
    const errors = stepErrors(state.step);
    if (errors.length > 0) {
      $("#step-errors").innerHTML = `
        <div class="alert">
          ${errors.map((err) => `<p>⚠ ${esc(err)}</p>`).join("")}
        </div>`;
      return;
    }
    if (isLast) {
      state.created = true;
    } else {
      state.step += 1;
      state.maxVisited = Math.max(state.maxVisited, state.step);
    }
    render();
  });
}

document.addEventListener("DOMContentLoaded", render);
