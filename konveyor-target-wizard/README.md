# Konveyor · Asistente de creación de custom targets

Wizard paso a paso (HTML + TypeScript, sin dependencias) para crear
**custom migration targets** de [Konveyor](https://github.com/konveyor),
replicando el flujo de *Administration → Custom migration targets* de
[tackle2-ui](https://github.com/konveyor/tackle2-ui).

## Pasos del wizard

1. **Datos generales** — nombre, descripción, proveedor de lenguaje e icono.
2. **Reglas personalizadas** — dos modos, como en Konveyor:
   - **Subir ficheros**: drag & drop de ficheros YAML de reglas del
     [analyzer-lsp](https://github.com/konveyor/analyzer-lsp), con análisis
     ligero (cuenta `ruleID`, avisa si falta `when:`, detecta ficheros vacíos
     o `ruleset.yaml` de metadatos).
   - **Repositorio**: git/subversion con URL, branch, path raíz y credencial
     (identity) opcional.
3. **Labels y sources** — genera automáticamente el label
   `konveyor.io/target=<slug>`, permite añadir labels custom y marcar los
   sources compatibles (`konveyor.io/source=…`).
4. **Revisión y creación** — resumen, payload JSON del recurso `Target` de
   tackle2-hub (`POST /hub/targets`), con botones de copiar y descargar
   `target.json`, y las llamadas `curl` necesarias contra un Hub real.

## Uso

Abrir `index.html` directamente en el navegador — el JS compilado
(`wizard.js`) está incluido en el repo.

## Desarrollo

El código fuente está en `wizard.ts` (TypeScript estricto, sin frameworks).
Para recompilar:

```bash
npx tsc -p tsconfig.json   # genera wizard.js
```

## Nota sobre el payload

En un Hub real, cada fichero de reglas se sube primero con
`POST /hub/files` y se referencia por `id` dentro de `ruleset.rules[].file`;
el wizard deja `id: 0` como placeholder. La imagen del target funciona igual
(`image.id`).
