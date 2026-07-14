"use strict";
/**
 * Konveyor Custom Target Wizard
 * -----------------------------
 * Wizard paso a paso para crear "custom migration targets" de Konveyor,
 * replicando el flujo de tackle2-ui (Administration > Custom migration targets):
 *
 *   1. Datos generales  : nombre, descripción, proveedor de lenguaje, icono
 *   2. Reglas           : subida manual de ficheros YAML de reglas, o repositorio (git/svn)
 *   3. Labels y sources : label automático konveyor.io/target=<slug>, labels custom y sources
 *   4. Revisión         : resumen + payload JSON listo para POST /hub/targets
 *
 * Sin dependencias externas: TypeScript estricto compilado a un único wizard.js.
 */
const PROVIDERS = ["Java", "Go", ".NET", "Node.js", "Python", "Otro"];
const ICONS = ["🎯", "☁️", "📦", "⚙️", "🛡️", "🚀", "🗄️", "🔧"];
/** Sources habituales en los rulesets de Konveyor (konveyor.io/source=...) */
const KNOWN_SOURCES = [
    "eap", "eap6", "eap7", "eap8", "springboot", "spring",
    "weblogic", "websphere", "jonas", "orion", "resteasy",
    "openjdk", "oraclejdk", "javaee", "jakarta-ee",
    "camel", "camel2", "camel3", "thorntail", "drools", "jbpm",
];
const state = {
    step: 0,
    maxVisited: 0,
    name: "",
    description: "",
    provider: "Java",
    icon: ICONS[0],
    mode: "upload",
    files: [],
    repo: { kind: "git", url: "", branch: "", path: "", credentials: "" },
    customLabels: [],
    sources: [],
    created: false,
};
const STEPS = [
    { title: "Datos generales", subtitle: "Nombre, descripción e icono" },
    { title: "Reglas personalizadas", subtitle: "Ficheros YAML o repositorio" },
    { title: "Labels y sources", subtitle: "Etiquetado del target" },
    { title: "Revisión y creación", subtitle: "Payload para el Hub" },
];
/* ============================== Utilidades ============================== */
function esc(s) {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
function slugify(s) {
    return s
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}
function formatSize(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function $(sel) {
    const node = document.querySelector(sel);
    if (!node)
        throw new Error(`Elemento no encontrado: ${sel}`);
    return node;
}
/* ============================== Validación ============================== */
/** Análisis ligero de un fichero YAML de reglas de Konveyor (analyzer-lsp). */
function analyzeRuleFile(name, content) {
    const issues = [];
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
        }
        else {
            issues.push("No se encontró ningún campo ruleID: — ¿es un fichero de reglas válido?");
        }
    }
    if (ruleCount > 0 && !/^\s*when\s*:/m.test(content)) {
        issues.push("Hay ruleID pero ninguna condición when: — las reglas no harán match");
    }
    return { name, size, content, ruleCount, issues };
}
function stepErrors(step) {
    const errors = [];
    if (step === 0) {
        if (state.name.trim().length < 3) {
            errors.push("El nombre debe tener al menos 3 caracteres.");
        }
        if (!state.provider) {
            errors.push("Selecciona un proveedor de lenguaje.");
        }
    }
    if (step === 1) {
        if (state.mode === "upload") {
            if (state.files.length === 0) {
                errors.push("Sube al menos un fichero YAML de reglas.");
            }
            else if (!state.files.some((f) => f.ruleCount > 0)) {
                errors.push("Ninguno de los ficheros subidos contiene reglas (ruleID).");
            }
        }
        else {
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
function targetLabel() {
    return `konveyor.io/target=${slugify(state.name) || "mi-target"}`;
}
function allLabels() {
    const labels = [targetLabel(), ...state.customLabels];
    for (const source of state.sources) {
        labels.push(`konveyor.io/source=${source}`);
    }
    return labels;
}
/** Construye el payload del recurso Target de tackle2-hub (POST /hub/targets). */
function buildPayload() {
    const ruleset = {
        name: state.name.trim(),
        description: state.description.trim(),
    };
    if (state.mode === "upload") {
        // En el flujo real, cada fichero se sube antes con POST /hub/files
        // y aquí se referencia por id; se deja 0 como placeholder.
        ruleset.rules = state.files.map((f) => ({
            name: f.name,
            file: { id: 0, name: f.name },
        }));
    }
    else {
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
function renderNav() {
    const nav = $("#wizard-nav");
    nav.innerHTML = STEPS.map((s, i) => {
        const status = i === state.step ? "current" : i < state.step || i <= state.maxVisited ? "done" : "todo";
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
    nav.querySelectorAll(".nav-step.clickable").forEach((li) => {
        li.addEventListener("click", () => {
            state.step = Number(li.dataset.step);
            render();
        });
    });
}
/* ============================== Render: pasos ============================== */
function renderStep0() {
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
        ${PROVIDERS.map((p) => `<button type="button" class="chip ${state.provider === p ? "chip-on" : ""}"
                    data-provider="${p}">${p}</button>`).join("")}
      </div>
    </div>

    <div class="field">
      <span class="field-label">Icono del target</span>
      <div class="chip-row">
        ${ICONS.map((icon) => `<button type="button" class="chip icon-chip ${state.icon === icon ? "chip-on" : ""}"
                    data-icon="${icon}">${icon}</button>`).join("")}
      </div>
      <span class="field-help">En Konveyor real se sube una imagen SVG/PNG (POST /hub/files).</span>
    </div>`;
}
function renderStep1() {
    const uploadPane = `
    <div id="dropzone" class="dropzone">
      <p><strong>Arrastra aquí tus ficheros de reglas</strong> (.yaml / .yml)</p>
      <p class="hint">o</p>
      <button type="button" class="btn btn-secondary" id="btn-browse">Seleccionar ficheros…</button>
      <input id="f-files" type="file" accept=".yaml,.yml" multiple hidden />
    </div>
    ${state.files.length
        ? `<ul class="file-list">
            ${state.files
            .map((f, i) => `
              <li class="file-item ${f.ruleCount === 0 ? "file-bad" : ""}">
                <span class="file-icon">${f.ruleCount > 0 ? "📄" : "⚠️"}</span>
                <span class="file-meta">
                  <strong>${esc(f.name)}</strong>
                  <small>${formatSize(f.size)} · ${f.ruleCount} regla${f.ruleCount === 1 ? "" : "s"} detectada${f.ruleCount === 1 ? "" : "s"}</small>
                  ${f.issues.map((issue) => `<small class="issue">⚠ ${esc(issue)}</small>`).join("")}
                </span>
                <button type="button" class="btn-x" data-rm-file="${i}" title="Quitar">✕</button>
              </li>`)
            .join("")}
          </ul>`
        : ""}`;
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
    return `
    <h2>Reglas personalizadas</h2>
    <p class="hint">Un target agrupa un <em>ruleset</em>: reglas YAML del
    <a href="https://github.com/konveyor/analyzer-lsp" target="_blank" rel="noopener">analyzer-lsp</a>.
    Puedes subirlas manualmente o referenciar un repositorio.</p>

    <div class="mode-toggle" role="tablist">
      <button type="button" class="mode-btn ${state.mode === "upload" ? "mode-on" : ""}" data-mode="upload">
        ⬆️ Subir ficheros
      </button>
      <button type="button" class="mode-btn ${state.mode === "repository" ? "mode-on" : ""}" data-mode="repository">
        🌐 Repositorio
      </button>
    </div>

    ${state.mode === "upload" ? uploadPane : repoPane}`;
}
function renderStep2() {
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
        .map((l, i) => `<span class="label-pill">${esc(l)}
              <button type="button" class="btn-x" data-rm-label="${i}" title="Quitar">✕</button></span>`)
        .join("")}
      </div>
    </div>

    <div class="field">
      <span class="field-label">Sources compatibles (konveyor.io/source=…)</span>
      <div class="source-grid">
        ${KNOWN_SOURCES.map((s) => `
          <label class="source-item">
            <input type="checkbox" data-source="${s}" ${state.sources.includes(s) ? "checked" : ""} />
            <span>${s}</span>
          </label>`).join("")}
      </div>
    </div>`;
}
function renderStep3() {
    const payload = JSON.stringify(buildPayload(), null, 2);
    const rulesSummary = state.mode === "upload"
        ? `${state.files.length} fichero(s), ${state.files.reduce((n, f) => n + f.ruleCount, 0)} regla(s)`
        : `${state.repo.kind} · ${esc(state.repo.url)}${state.repo.branch ? ` @ ${esc(state.repo.branch)}` : ""}`;
    if (state.created) {
        return `
      <div class="success">
        <div class="success-icon">✅</div>
        <h2>Target «${esc(state.name)}» listo</h2>
        <p>El payload se ha generado. Para crearlo en un Hub real de Konveyor:</p>
        <pre class="code">« subir cada fichero de reglas »
curl -X POST $HUB_URL/files -F "file=@mis-reglas.yaml"

« crear el target con los ids de fichero devueltos »
curl -X POST $HUB_URL/targets \\
  -H "Content-Type: application/json" \\
  -d @target.json</pre>
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

    <div class="field">
      <span class="field-label">Payload — <code>POST /hub/targets</code></span>
      <pre class="code" id="payload-pre">${esc(payload)}</pre>
      <div class="inline-add">
        <button type="button" class="btn btn-secondary" id="btn-download">⬇ Descargar target.json</button>
        <button type="button" class="btn btn-secondary" id="btn-copy">📋 Copiar</button>
      </div>
    </div>`;
}
/* ============================== Eventos por paso ============================== */
function bindStep0() {
    $("#f-name").addEventListener("input", (e) => {
        state.name = e.target.value;
        const help = document.querySelector("#f-name + .field-help, .field-help code");
        const codeEl = document.querySelector(".field-help code");
        if (codeEl)
            codeEl.textContent = targetLabel();
        void help;
    });
    $("#f-desc").addEventListener("input", (e) => {
        state.description = e.target.value;
    });
    document.querySelectorAll("[data-provider]").forEach((btn) => {
        btn.addEventListener("click", () => {
            state.provider = btn.dataset.provider ?? state.provider;
            render();
        });
    });
    document.querySelectorAll("[data-icon]").forEach((btn) => {
        btn.addEventListener("click", () => {
            state.icon = btn.dataset.icon ?? state.icon;
            render();
        });
    });
}
function addFiles(files) {
    const pending = Array.from(files);
    let remaining = pending.length;
    if (remaining === 0)
        return;
    for (const file of pending) {
        const reader = new FileReader();
        reader.onload = () => {
            const content = typeof reader.result === "string" ? reader.result : "";
            // Sustituye si ya existe un fichero con el mismo nombre
            const idx = state.files.findIndex((f) => f.name === file.name);
            const analyzed = analyzeRuleFile(file.name, content);
            if (idx >= 0)
                state.files[idx] = analyzed;
            else
                state.files.push(analyzed);
            remaining -= 1;
            if (remaining === 0)
                render();
        };
        reader.readAsText(file);
    }
}
function bindStep1() {
    document.querySelectorAll("[data-mode]").forEach((btn) => {
        btn.addEventListener("click", () => {
            state.mode = btn.dataset.mode;
            render();
        });
    });
    if (state.mode === "upload") {
        const drop = $("#dropzone");
        const input = $("#f-files");
        $("#btn-browse").addEventListener("click", () => input.click());
        input.addEventListener("change", () => {
            if (input.files)
                addFiles(input.files);
        });
        drop.addEventListener("dragover", (e) => {
            e.preventDefault();
            drop.classList.add("drag-on");
        });
        drop.addEventListener("dragleave", () => drop.classList.remove("drag-on"));
        drop.addEventListener("drop", (e) => {
            e.preventDefault();
            drop.classList.remove("drag-on");
            if (e.dataTransfer?.files)
                addFiles(e.dataTransfer.files);
        });
        document.querySelectorAll("[data-rm-file]").forEach((btn) => {
            btn.addEventListener("click", () => {
                state.files.splice(Number(btn.dataset.rmFile), 1);
                render();
            });
        });
    }
    else {
        $("#f-repo-kind").addEventListener("change", (e) => {
            state.repo.kind = e.target.value;
        });
        $("#f-repo-url").addEventListener("input", (e) => {
            state.repo.url = e.target.value;
        });
        $("#f-repo-branch").addEventListener("input", (e) => {
            state.repo.branch = e.target.value;
        });
        $("#f-repo-path").addEventListener("input", (e) => {
            state.repo.path = e.target.value;
        });
        $("#f-repo-cred").addEventListener("input", (e) => {
            state.repo.credentials = e.target.value;
        });
    }
}
function bindStep2() {
    const addLabel = () => {
        const input = $("#f-label-new");
        const value = input.value.trim();
        if (value && !state.customLabels.includes(value)) {
            state.customLabels.push(value);
            render();
        }
    };
    $("#btn-add-label").addEventListener("click", addLabel);
    $("#f-label-new").addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            addLabel();
        }
    });
    document.querySelectorAll("[data-rm-label]").forEach((btn) => {
        btn.addEventListener("click", () => {
            state.customLabels.splice(Number(btn.dataset.rmLabel), 1);
            render();
        });
    });
    document.querySelectorAll("[data-source]").forEach((cb) => {
        cb.addEventListener("change", () => {
            const src = cb.dataset.source ?? "";
            if (cb.checked && !state.sources.includes(src))
                state.sources.push(src);
            if (!cb.checked)
                state.sources = state.sources.filter((s) => s !== src);
        });
    });
}
function downloadPayload() {
    const blob = new Blob([JSON.stringify(buildPayload(), null, 2)], {
        type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `target-${slugify(state.name) || "konveyor"}.json`;
    a.click();
    URL.revokeObjectURL(url);
}
function bindStep3() {
    if (state.created) {
        $("#btn-download-2").addEventListener("click", downloadPayload);
        $("#btn-restart").addEventListener("click", () => {
            Object.assign(state, {
                step: 0,
                maxVisited: 0,
                name: "",
                description: "",
                provider: "Java",
                icon: ICONS[0],
                mode: "upload",
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
    $("#btn-copy").addEventListener("click", () => {
        void navigator.clipboard.writeText(JSON.stringify(buildPayload(), null, 2)).then(() => {
            $("#btn-copy").textContent = "✓ Copiado";
            setTimeout(() => {
                const btn = document.querySelector("#btn-copy");
                if (btn)
                    btn.textContent = "📋 Copiar";
            }, 1500);
        });
    });
}
/* ============================== Render principal ============================== */
function render() {
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
        }
        else {
            state.step += 1;
            state.maxVisited = Math.max(state.maxVisited, state.step);
        }
        render();
    });
}
document.addEventListener("DOMContentLoaded", render);
